/**
 * The error codes of the `.tkpak` specification. The Android implementation uses the
 * same names, and each has a translated message in every supported language, so a
 * code is part of the contract rather than an internal detail.
 */
export type TkpakErrorCode =
  | 'NOT_A_TKPAK'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED_MANIFEST'
  | 'LIMIT_EXCEEDED'
  | 'BAD_SIGNATURE'
  | 'UNKNOWN_ISSUER'
  | 'DIGEST_MISMATCH'
  | 'WRONG_PASSWORD'
  | 'NO_USABLE_KEY_SLOT'
  | 'DECRYPTION_FAILED'
  | 'FILE_ID_MISMATCH'

export class TkpakError extends Error {
  constructor(
    readonly code: TkpakErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TkpakError'
  }
}

export function malformed(detail: string): TkpakError {
  return new TkpakError('MALFORMED_MANIFEST', detail)
}
