import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { BarcodeFormat } from '@passvault/tkpak'
import { IngestError } from './errors.js'

/**
 * Apple Wallet passes.
 *
 * A `.pkpass` is a ZIP holding `pass.json`, a `manifest.json` of SHA-1 digests, and a
 * PKCS#7 `signature` over that manifest.
 */

export interface PkpassBarcode {
  format: BarcodeFormat
  value: string
  altText?: string
}

export interface PkpassIntegrity {
  /** Every file in the archive matches its digest in manifest.json. */
  digestsMatch: boolean
  /** A PKCS#7 signature file is present. */
  signaturePresent: boolean
  /**
   * Whether the signature was verified against Apple's certificate chain.
   *
   * Always false here, and deliberately so rather than silently unimplemented: verifying
   * it needs Apple's WWDR intermediate certificate and a PKCS#7 verifier, and claiming a
   * pass is authentic without doing that work would be worse than saying it is unverified.
   * The manifest digests are checked, which catches a pass edited after signing, and the
   * interface reports the difference.
   */
  signatureVerified: boolean
  filesWithWrongDigest: string[]
}

export interface PkpassContents {
  /** The parsed pass.json, as Apple defines it. */
  pass: Record<string, unknown>
  description?: string
  organizationName?: string
  eventName?: string
  venue?: string
  relevantDate?: string
  barcodes: PkpassBarcode[]
  integrity: PkpassIntegrity
  /** Rendered assets, so the pass can be displayed rather than only read. */
  images: Map<string, Uint8Array>
}

const BARCODE_FORMATS: Record<string, BarcodeFormat> = {
  PKBarcodeFormatQR: 'QR_CODE',
  PKBarcodeFormatPDF417: 'PDF_417',
  PKBarcodeFormatAztec: 'AZTEC',
  PKBarcodeFormatCode128: 'CODE_128',
}

export function readPkpass(bytes: Uint8Array): PkpassContents {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (cause) {
    throw new IngestError('PKPASS_MALFORMED', 'pass is not a readable ZIP archive', { cause })
  }

  const passJson = entries['pass.json']
  if (!passJson) {
    throw new IngestError('PKPASS_MALFORMED', 'pass holds no pass.json')
  }

  let pass: Record<string, unknown>
  try {
    pass = JSON.parse(Buffer.from(passJson).toString('utf8')) as Record<string, unknown>
  } catch (cause) {
    throw new IngestError('PKPASS_MALFORMED', 'pass.json is not valid JSON', { cause })
  }

  const images = new Map<string, Uint8Array>()
  for (const [name, content] of Object.entries(entries)) {
    if (/\.(png|jpg|jpeg)$/i.test(name)) {
      images.set(name, content)
    }
  }

  const contents: PkpassContents = {
    pass,
    barcodes: readBarcodes(pass),
    integrity: checkIntegrity(entries),
    images,
  }

  const description = stringField(pass, 'description')
  const organizationName = stringField(pass, 'organizationName')
  const relevantDate = stringField(pass, 'relevantDate')
  if (description) contents.description = description
  if (organizationName) contents.organizationName = organizationName
  if (relevantDate) contents.relevantDate = relevantDate

  // Apple's event ticket puts the event name and venue in free-form field arrays rather
  // than named properties, so they are read by key convention and treated as hints.
  const eventName = fieldValue(pass, ['eventName', 'event', 'title']) ?? description
  const venue = fieldValue(pass, ['venue', 'venueName', 'location', 'place'])
  if (eventName) contents.eventName = eventName
  if (venue) contents.venue = venue

  return contents
}

function readBarcodes(pass: Record<string, unknown>): PkpassBarcode[] {
  const found: PkpassBarcode[] = []
  const candidates: unknown[] = []
  if (Array.isArray(pass.barcodes)) {
    candidates.push(...pass.barcodes)
  }
  if (pass.barcode) {
    // Deprecated by Apple in favour of the array, and still emitted by plenty of vendors.
    candidates.push(pass.barcode)
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue
    }
    const entry = candidate as Record<string, unknown>
    const format = BARCODE_FORMATS[String(entry.format)]
    const message = entry.message
    if (!format || typeof message !== 'string' || message.length === 0) {
      continue
    }
    const barcode: PkpassBarcode = { format, value: message }
    if (typeof entry.altText === 'string') {
      barcode.altText = entry.altText
    }
    found.push(barcode)
  }
  return found
}

/**
 * Checks every file against `manifest.json`.
 *
 * SHA-1 because that is what Apple specifies. It is used here as a tamper check against a
 * manifest that is itself covered by the PKCS#7 signature, not as a security primitive on
 * its own, and this comment exists so nobody "upgrades" it and breaks compatibility.
 */
function checkIntegrity(entries: Record<string, Uint8Array>): PkpassIntegrity {
  const signaturePresent = Object.hasOwn(entries, 'signature')
  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) {
    return {
      digestsMatch: false,
      signaturePresent,
      signatureVerified: false,
      filesWithWrongDigest: ['manifest.json'],
    }
  }

  let manifest: Record<string, string>
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Record<string, string>
  } catch {
    return {
      digestsMatch: false,
      signaturePresent,
      signatureVerified: false,
      filesWithWrongDigest: ['manifest.json'],
    }
  }

  const wrong: string[] = []
  for (const [name, expected] of Object.entries(manifest)) {
    const content = entries[name]
    if (!content) {
      wrong.push(name)
      continue
    }
    const actual = createHash('sha1').update(content).digest('hex')
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      wrong.push(name)
    }
  }

  return {
    digestsMatch: wrong.length === 0,
    signaturePresent,
    signatureVerified: false,
    filesWithWrongDigest: wrong,
  }
}

function stringField(pass: Record<string, unknown>, key: string): string | undefined {
  const value = pass[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Searches the free-form field arrays Apple defines for a pass style. */
function fieldValue(pass: Record<string, unknown>, keys: string[]): string | undefined {
  const styles = ['eventTicket', 'generic', 'boardingPass', 'coupon', 'storeCard']
  const groups = ['primaryFields', 'secondaryFields', 'auxiliaryFields', 'headerFields']
  for (const style of styles) {
    const body = pass[style]
    if (typeof body !== 'object' || body === null) {
      continue
    }
    for (const group of groups) {
      const fields = (body as Record<string, unknown>)[group]
      if (!Array.isArray(fields)) {
        continue
      }
      for (const field of fields) {
        if (typeof field !== 'object' || field === null) {
          continue
        }
        const entry = field as Record<string, unknown>
        const key = String(entry.key ?? '')
        if (keys.some((candidate) => key.toLowerCase() === candidate.toLowerCase())) {
          const value = entry.value
          if (typeof value === 'string' && value.length > 0) {
            return value
          }
        }
      }
    }
  }
  return undefined
}
