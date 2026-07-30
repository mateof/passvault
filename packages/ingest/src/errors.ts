/**
 * Ingestion failures. Each code has a translated message in `@passvault/i18n` under
 * `ingest.error.*`, so an interface never has to invent wording for a failure.
 */
export type IngestErrorCode =
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_LARGE'
  | 'ENCRYPTED_PDF'
  | 'DAMAGED_FILE'
  | 'TOO_MANY_PAGES'
  | 'PKPASS_SIGNATURE_INVALID'
  | 'PKPASS_MALFORMED'
  | 'RASTERIZER_UNAVAILABLE'

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'IngestError'
  }
}
