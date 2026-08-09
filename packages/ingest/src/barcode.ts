import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm'
import type { BarcodeFormat } from '@passvault/tkpak'
import { INGEST_LIMITS } from './limits.js'

/**
 * Barcode decoding, through ZXing compiled to WebAssembly.
 *
 * ZXing rather than ML Kit on the Android side, and the same library here, so both
 * implementations agree on what a ticket's barcode says. ML Kit copes better with a badly
 * lit photograph, but it needs Google Play Services or a bundled model of several
 * megabytes, and an application whose main claim is working without a server should not
 * require Google's to read a PDF.
 *
 * The WebAssembly binary is loaded from disk rather than fetched. The library's default is
 * to pull it from a CDN, which would make ingestion — the one operation that must work on
 * a plane — depend on the network.
 */

/** The formats a ticket actually uses, mapped to this project's names. */
const FORMAT_MAP: Record<string, BarcodeFormat> = {
  QRCode: 'QR_CODE',
  QRCodeModel1: 'QR_CODE',
  QRCodeModel2: 'QR_CODE',
  MicroQRCode: 'QR_CODE',
  RMQRCode: 'QR_CODE',
  Aztec: 'AZTEC',
  AztecCode: 'AZTEC',
  PDF417: 'PDF_417',
  CompactPDF417: 'PDF_417',
  MicroPDF417: 'PDF_417',
  Code128: 'CODE_128',
  Code39: 'CODE_39',
  Code39Std: 'CODE_39',
  Code39Ext: 'CODE_39',
  EAN13: 'EAN_13',
  DataMatrix: 'DATA_MATRIX',
}

const REQUESTED_FORMATS = [
  'QRCode',
  'MicroQRCode',
  'Aztec',
  'PDF417',
  'Code128',
  'Code39',
  'EAN13',
  'DataMatrix',
] as const

/** Axis-aligned bounds of a symbol, in pixels of the image it was read from. */
export interface BarcodeBox {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DecodedBarcode {
  format: BarcodeFormat
  value: string
  /** ZXing's own format name, kept for diagnostics when a format maps to several. */
  rawFormat: string
  /**
   * Where the symbol sits on the page.
   *
   * This is what lets a sheet carrying several passes be cut into one image per ticket,
   * instead of handing every holder a copy of the whole sheet with their neighbours' codes
   * on it.
   */
  box: BarcodeBox
}

interface Corners {
  topLeft: { x: number; y: number }
  topRight: { x: number; y: number }
  bottomLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
}

/** The four corners come back in reading order, which a rotated symbol does not respect. */
function boundsOf(position: Corners): BarcodeBox {
  const xs = [
    position.topLeft.x,
    position.topRight.x,
    position.bottomLeft.x,
    position.bottomRight.x,
  ]
  const ys = [
    position.topLeft.y,
    position.topRight.y,
    position.bottomLeft.y,
    position.bottomRight.y,
  ]
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  }
}

let modulePrepared: Promise<void> | undefined

async function ensureModule(): Promise<void> {
  modulePrepared ??= (async () => {
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('zxing-wasm/full/zxing_full.wasm')
    const file = await readFile(wasmPath)
    // The module wants an ArrayBuffer, and a Buffer's underlying buffer is usually a
    // shared pool, so the byte range has to be sliced out rather than handed over whole.
    const wasmBinary = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer
    prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
  })()
  await modulePrepared
}

/**
 * Decodes every barcode in an encoded image (PNG or JPEG bytes).
 *
 * Returns them all rather than the first, because a page with two barcodes is a real case
 * — two passes printed on one sheet — and the caller has to decide how they split into
 * tickets instead of being handed a guess.
 *
 * One symbol *over* the per-page limit is requested on purpose. Asking for exactly the
 * limit makes a page that happens to hold that many indistinguishable from one that holds
 * more, and the difference matters: the second case is losing tickets. A caller that gets
 * back more than `INGEST_LIMITS.barcodesPerPage` knows the page overflowed and can say so.
 */
export async function decodeBarcodes(imageBytes: Uint8Array): Promise<DecodedBarcode[]> {
  await ensureModule()
  const results = await readBarcodes(imageBytes, {
    formats: [...REQUESTED_FORMATS],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    maxNumberOfSymbols: INGEST_LIMITS.barcodesPerPage + 1,
  })
  return results
    .filter((result) => result.isValid && result.text.length > 0)
    .map((result) => ({
      format: FORMAT_MAP[result.format] ?? 'QR_CODE',
      value: result.text,
      rawFormat: result.format,
      box: boundsOf(result.position),
    }))
}

export function isTicketBarcodeFormat(rawFormat: string): boolean {
  return Object.hasOwn(FORMAT_MAP, rawFormat)
}
