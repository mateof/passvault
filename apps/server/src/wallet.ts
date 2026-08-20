import { execFile } from 'node:child_process'
import { createHash, createSign } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { badRequest } from './errors.js'

/**
 * Issuing a pass into the wallet a phone already has.
 *
 * PassVault has read `.pkpass` files since the beginning and never written one, which is the wrong
 * way round for a product whose job is handing tickets to people: the place somebody looks for a
 * ticket at a gate is the wallet button on their own phone.
 *
 * ## What this can and cannot do on its own
 *
 * Both wallets are closed systems and neither can be entered anonymously. Apple refuses a pass
 * that is not signed by a Pass Type ID certificate issued to a named developer account; Google
 * only shows an object from a registered issuer, signed by that issuer's service account. Those
 * are not obstacles this code can route around — they are the point of the systems.
 *
 * So this is built to be complete when an operator has those credentials and to **refuse clearly
 * when they do not**, rather than producing a file that a phone rejects with no explanation. An
 * installation that never configures either is exactly as it was; the button simply is not there.
 *
 * ## Why the signature shells out to OpenSSL
 *
 * Apple wants a detached PKCS#7 (CMS) signature in DER. Node's crypto has no CMS at all — it
 * signs bytes, and a CMS structure is a whole ASN.1 document around that signature. The choices
 * were a dependency of a megabyte to serialise it, hand-rolling ASN.1 in this file, or calling the
 * `openssl` that is already in the runtime image. The third is the only one that is neither a
 * liability nor a science project, and its absence is detected and reported rather than assumed.
 */

const run = promisify(execFile)

export interface AppleWalletConfig {
  /** PEM certificate and key for a Pass Type ID, and Apple's WWDR intermediate. */
  certificatePem: string
  keyPem: string
  wwdrPem: string
  passTypeIdentifier: string
  teamIdentifier: string
  organizationName: string
}

export interface GoogleWalletConfig {
  issuerId: string
  /** The service account's email, which becomes the JWT issuer. */
  serviceAccountEmail: string
  /** Its private key, PEM. */
  privateKeyPem: string
  /** The event ticket class this installation writes objects into. */
  classSuffix: string
}

export interface PassContents {
  /** Stable across regeneration, so re-adding updates the pass rather than making a second. */
  serialNumber: string
  eventName: string
  venue?: string | null
  startsAt?: string | null
  seat?: string | null
  holder?: string | null
  barcode: { format: string; value: string }
}

/** Apple's own names for the symbologies. Anything else has no representation in a pass. */
const APPLE_FORMATS: Record<string, string> = {
  QR_CODE: 'PKBarcodeFormatQR',
  AZTEC: 'PKBarcodeFormatAztec',
  PDF_417: 'PKBarcodeFormatPDF417',
  CODE_128: 'PKBarcodeFormatCode128',
}

/** Google's, which are a different vocabulary for the same four things. */
const GOOGLE_FORMATS: Record<string, string> = {
  QR_CODE: 'QR_CODE',
  AZTEC: 'AZTEC',
  PDF_417: 'PDF_417',
  CODE_128: 'CODE_128',
}

/**
 * A one-pixel PNG, so the archive has the icons Apple requires without shipping artwork.
 *
 * A pass with no `icon.png` is rejected outright. This is deliberately not a logo: an installation
 * that wants its own can replace these, and inventing branding for somebody else's event would be
 * worse than a blank square.
 */
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function passJson(config: AppleWalletConfig, contents: PassContents): string {
  const format = APPLE_FORMATS[contents.barcode.format]
  if (!format) {
    throw badRequest('wallet.error.unsupportedFormat')
  }
  return JSON.stringify(
    {
      formatVersion: 1,
      passTypeIdentifier: config.passTypeIdentifier,
      teamIdentifier: config.teamIdentifier,
      organizationName: config.organizationName,
      serialNumber: contents.serialNumber,
      description: contents.eventName,
      eventTicket: {
        primaryFields: [{ key: 'event', label: 'Event', value: contents.eventName }],
        secondaryFields: [
          ...(contents.venue ? [{ key: 'venue', label: 'Venue', value: contents.venue }] : []),
          ...(contents.seat ? [{ key: 'seat', label: 'Seat', value: contents.seat }] : []),
        ],
        auxiliaryFields: contents.startsAt
          ? [
              {
                key: 'when',
                label: 'Starts',
                value: contents.startsAt,
                dateStyle: 'PKDateStyleShort',
                timeStyle: 'PKDateStyleShort',
              },
            ]
          : [],
      },
      ...(contents.startsAt ? { relevantDate: contents.startsAt } : {}),
      barcodes: [
        {
          format,
          message: contents.barcode.value,
          messageEncoding: 'iso-8859-1',
          ...(contents.seat ? { altText: contents.seat } : {}),
        },
      ],
    },
    null,
    2,
  )
}

/**
 * The detached PKCS#7 over the manifest, which is what makes a pass a pass.
 *
 * Written to a temporary directory because `openssl smime` reads files. The directory is removed
 * whatever happens: it holds the signing key, and a key left in `/tmp` because a signature failed
 * is a worse outcome than no pass at all.
 */
async function sign(config: AppleWalletConfig, manifest: string): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'passvault-pass-'))
  try {
    const paths = {
      manifest: join(directory, 'manifest.json'),
      certificate: join(directory, 'cert.pem'),
      key: join(directory, 'key.pem'),
      wwdr: join(directory, 'wwdr.pem'),
      signature: join(directory, 'signature'),
    }
    await writeFile(paths.manifest, manifest)
    await writeFile(paths.certificate, config.certificatePem)
    await writeFile(paths.key, config.keyPem)
    await writeFile(paths.wwdr, config.wwdrPem)

    await run('openssl', [
      'smime',
      '-sign',
      '-binary',
      '-noattr',
      '-signer',
      paths.certificate,
      '-inkey',
      paths.key,
      '-certfile',
      paths.wwdr,
      '-in',
      paths.manifest,
      '-out',
      paths.signature,
      '-outform',
      'DER',
    ])
    return new Uint8Array(await readFile(paths.signature))
  } catch {
    // Missing binary, wrong password on the key, an expired certificate: all of them arrive here
    // as an exec failure, and all of them mean the same thing to whoever asked for a pass.
    throw badRequest('wallet.error.signingFailed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Everything in a pass except the signature.
 *
 * Separate from `applePass` because it is the part this project is responsible for — the files, the
 * digests, the shape of `pass.json` — and it can be checked without a developer account, which the
 * signature cannot.
 */
export function appleArchive(
  config: AppleWalletConfig,
  contents: PassContents,
): { files: Record<string, Uint8Array>; manifestJson: string } {
  const files: Record<string, Uint8Array> = {
    'pass.json': strToU8(passJson(config, contents)),
    'icon.png': new Uint8Array(BLANK_PNG),
    'icon@2x.png': new Uint8Array(BLANK_PNG),
    'logo.png': new Uint8Array(BLANK_PNG),
  }

  // SHA-1, because that is what the format specifies. Not a security choice this code gets to
  // make: a manifest with SHA-256 digests is a pass Apple will not open.
  const manifest: Record<string, string> = {}
  for (const [name, bytes] of Object.entries(files)) {
    manifest[name] = createHash('sha1').update(bytes).digest('hex')
  }
  return { files, manifestJson: JSON.stringify(manifest, null, 2) }
}

/** A signed `.pkpass`, ready for a phone. */
export async function applePass(
  config: AppleWalletConfig,
  contents: PassContents,
): Promise<Uint8Array> {
  const { files, manifestJson } = appleArchive(config, contents)
  return zipSync({
    ...files,
    'manifest.json': strToU8(manifestJson),
    signature: await sign(config, manifestJson),
  })
}

const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

/**
 * A "save to Google Wallet" link.
 *
 * The whole object travels inside a JWT the issuer signs, so there is no API call and nothing to
 * store on Google's side ahead of time. RS256, which `node:crypto` does natively — unlike Apple's
 * CMS, this one needs nothing outside the runtime.
 */
export function googlePassLink(config: GoogleWalletConfig, contents: PassContents): string {
  const format = GOOGLE_FORMATS[contents.barcode.format]
  if (!format) {
    throw badRequest('wallet.error.unsupportedFormat')
  }

  const object = {
    id: `${config.issuerId}.${contents.serialNumber}`,
    classId: `${config.issuerId}.${config.classSuffix}`,
    state: 'ACTIVE',
    barcode: { type: format, value: contents.barcode.value },
    ...(contents.seat
      ? { seatInfo: { seat: { defaultValue: { language: 'en', value: contents.seat } } } }
      : {}),
    ...(contents.holder ? { ticketHolderName: contents.holder } : {}),
  }

  const claims = {
    iss: config.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    // Not a timestamp anybody checks for freshness, but the JWT is signed and a link that never
    // expires is a link that is still valid when it is found in a chat log next year.
    iat: Math.floor(Date.now() / 1000),
    payload: { eventTicketObjects: [object] },
  }

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(claims))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  const signature = base64url(signer.sign(config.privateKeyPem))
  return `https://pay.google.com/gp/v/save/${header}.${body}.${signature}`
}
