import { PDFDocument, StandardFonts } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { prepareZXingModule, writeBarcode } from 'zxing-wasm'

/**
 * Real barcodes in real files.
 *
 * The fixtures encode genuine QR, Aztec and PDF417 symbols and embed them in genuine PDFs,
 * so the tests exercise the whole path — encode, lay out, split, rasterise, decode — rather
 * than a stubbed decoder agreeing with a stubbed encoder. That is the difference between
 * testing the pipeline and testing the mocks.
 */

let prepared: Promise<void> | undefined

async function ensureZXing(): Promise<void> {
  prepared ??= (async () => {
    const require = createRequire(import.meta.url)
    const wasmBinary = new Uint8Array(
      await readFile(require.resolve('zxing-wasm/full/zxing_full.wasm')),
    )
    prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
  })()
  await prepared
}

export type WritableFormat = 'QRCode' | 'Aztec' | 'PDF417' | 'Code128' | 'DataMatrix'

export async function barcodePng(
  text: string,
  format: WritableFormat = 'QRCode',
): Promise<Uint8Array> {
  await ensureZXing()
  const written = await writeBarcode(text, { format, scale: 6 })
  if (!written.image) {
    throw new Error(`could not encode a ${format}: ${written.error ?? 'no image returned'}`)
  }
  return new Uint8Array(await written.image.arrayBuffer())
}

export interface PageSpec {
  /** Barcode payloads to draw on this page. Empty means a page with no barcode at all. */
  codes: { text: string; format?: WritableFormat }[]
  heading?: string
  /**
   * Lay the codes out in a grid of this many columns instead of a single row.
   *
   * A row is what a sheet of two passes looks like and is the default. Real sheets also come
   * stacked (`columns: 1`) and four-up or more, and those layouts are the ones that tell
   * whether a page is being cut into tickets correctly rather than by luck.
   */
  columns?: number
}

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842

/** Builds a multi-page PDF, one spec per page. */
export async function ticketPdf(pages: PageSpec[]): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)

  for (const spec of pages) {
    const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    if (spec.heading) {
      page.drawText(spec.heading, { x: 48, y: 780, size: 16, font })
    }
    for (const [index, code] of spec.codes.entries()) {
      const png = await document.embedPng(await barcodePng(code.text, code.format ?? 'QRCode'))
      const { x, y, size, captionY, caption } = spec.columns
        ? gridSlot(index, spec.columns)
        : rowSlot(index)
      page.drawImage(png, {
        x,
        y,
        width: size,
        height: (size * png.height) / png.width,
      })
      page.drawText(code.text, { x, y: captionY, size: caption, font })
    }
  }

  return new Uint8Array(await document.save())
}

interface Slot {
  x: number
  y: number
  size: number
  captionY: number
  caption: number
}

function rowSlot(index: number): Slot {
  const size = 180
  const x = 60 + index * (size + 40)
  return { x, y: 520, size, captionY: 496, caption: 9 }
}

function gridSlot(index: number, columns: number): Slot {
  const margin = 36
  const cell = (PAGE_WIDTH - margin * 2) / columns
  // Short of the cell, so the gap between neighbours is a band with nothing in it — which is
  // what a guillotine cut needs and what a printed sheet has.
  const size = Math.min(cell - 14, 160)
  const row = Math.floor(index / columns)
  const column = index % columns
  const y = PAGE_HEIGHT - margin - (row + 1) * (size + 28)
  return {
    x: margin + column * cell,
    y,
    size,
    captionY: y - 12,
    caption: Math.max(5, Math.min(9, size / 20)),
  }
}

/** A PDF with no barcode anywhere: the instructions sheet vendors put in front. */
export async function instructionsOnlyPdf(): Promise<Uint8Array> {
  return ticketPdf([{ codes: [], heading: 'How to get in: bring photo ID' }])
}

export interface PkpassSpec {
  barcodes?: { format: string; message: string; altText?: string }[]
  eventName?: string
  venue?: string
  /** Break a digest, as a pass edited after signing would be. */
  corruptDigest?: boolean
  omitSignature?: boolean
}

/**
 * Builds an Apple Wallet pass.
 *
 * The signature is a placeholder: verifying a real one needs Apple's certificate chain, and
 * `readPkpass` reports the signature as unverified rather than pretending otherwise. What
 * these fixtures do exercise is the manifest digest check, which is what catches a pass
 * altered after it was signed.
 */
export function pkpass(spec: PkpassSpec = {}): Uint8Array {
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: 'pass.org.example.passvault',
    serialNumber: 'VECT-0001',
    teamIdentifier: 'ABCDE12345',
    organizationName: 'Festival do Norte',
    description: spec.eventName ?? 'Festival do Norte 2026',
    eventTicket: {
      primaryFields: [
        { key: 'eventName', label: 'Event', value: spec.eventName ?? 'Festival do Norte 2026' },
      ],
      secondaryFields: [{ key: 'venue', label: 'Venue', value: spec.venue ?? 'Recinto Ferial' }],
    },
    barcodes: spec.barcodes ?? [
      { format: 'PKBarcodeFormatQR', message: '8412-PKPASS-0001', messageEncoding: 'iso-8859-1' },
    ],
  }

  const passJson = strToU8(JSON.stringify(pass, null, 2))
  const icon = strToU8('not really a png')
  const files: Record<string, Uint8Array> = { 'pass.json': passJson, 'icon.png': icon }

  const manifest: Record<string, string> = {}
  for (const [name, content] of Object.entries(files)) {
    manifest[name] = createHash('sha1').update(content).digest('hex')
  }
  if (spec.corruptDigest) {
    manifest['pass.json'] = createHash('sha1').update(strToU8('different content')).digest('hex')
  }

  const entries: Record<string, Uint8Array> = {
    ...files,
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  }
  if (!spec.omitSignature) {
    entries.signature = strToU8('placeholder PKCS#7 signature')
  }

  return zipSync(entries)
}

/** A ZIP that is not a pass, to check that detection does not accept any archive. */
export function plainZip(): Uint8Array {
  return zipSync({ 'readme.txt': strToU8('nothing to see') })
}
