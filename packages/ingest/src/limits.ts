import { IngestError } from './errors.js'

/**
 * Ingestion runs on attacker-supplied files — anything a friend forwarded arrived from
 * somewhere else first — and PDF and image parsers are large attack surfaces. These
 * bounds do not make the parsers safe; they bound what a hostile file can cost.
 */
export const INGEST_LIMITS = {
  fileBytes: 64 * 1024 * 1024,
  pages: 256,
  /** Rasterised width, enough for a dense PDF417 without producing 50 MB bitmaps. */
  renderWidth: 1600,
  barcodesPerPage: 8,
} as const

export function assertFileSize(byteLength: number): void {
  if (byteLength > INGEST_LIMITS.fileBytes) {
    throw new IngestError(
      'FILE_TOO_LARGE',
      `file is ${byteLength} bytes, over the ${INGEST_LIMITS.fileBytes} byte limit`,
    )
  }
}

export function assertPageCount(pages: number): void {
  if (pages > INGEST_LIMITS.pages) {
    throw new IngestError(
      'TOO_MANY_PAGES',
      `document has ${pages} pages, over the ${INGEST_LIMITS.pages} page limit`,
    )
  }
}
