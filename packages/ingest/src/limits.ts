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
  /**
   * Codes read from one page.
   *
   * Eight was too few and failed silently: a sheet of season passes or a block booking
   * printed twelve to a page came back with eight tickets and nothing saying the rest had
   * been dropped. This bounds what a hostile file costs; it does not describe what a real
   * ticket looks like, so it sits well above any honest sheet.
   */
  barcodesPerPage: 24,
  /**
   * Full-page-equivalent width for the crops stored against tickets that share a sheet.
   *
   * Wider than the detection render because this one is read by a person holding a phone at
   * a turnstile, not by a decoder.
   */
  cropRenderWidth: 2400,
  /**
   * Width of the throwaway render used to find the blank gutters on a shared sheet.
   *
   * Deliberately small. This is looking for the white band between two printed passes, which
   * is a coarse feature, and it only decides where inside an already-safe gap to cut — so
   * missing a hairline costs a line through a border, not a leaked barcode.
   */
  inkMapWidth: 400,
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
