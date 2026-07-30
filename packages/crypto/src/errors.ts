export type CryptoErrorCode =
  | 'MALFORMED_INPUT'
  | 'DECRYPTION_FAILED'
  | 'WRONG_PASSWORD'
  | 'WRONG_KEY'
  | 'LIMIT_EXCEEDED'
  | 'BAD_SIGNATURE'

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CryptoError'
  }
}

/**
 * True when a failure means "this key does not open this ciphertext" rather than
 * "this ciphertext was tampered with". GCM cannot tell the two apart, so callers
 * that know which they are attempting label it: unwrapping a password-derived key
 * is a routine wrong password, while a part failing after the key already worked
 * means the file was modified.
 */
export function isKeyMismatch(error: unknown): boolean {
  return (
    error instanceof CryptoError && (error.code === 'WRONG_PASSWORD' || error.code === 'WRONG_KEY')
  )
}
