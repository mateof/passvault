import { createCipheriv, createDecipheriv } from 'node:crypto'
import { CryptoError, type CryptoErrorCode } from './errors.js'
import { KEY_BYTES, NONCE_BYTES } from './random.js'

export const TAG_BYTES = 16

const ALGORITHM = 'aes-256-gcm'

export interface SealInput {
  key: Uint8Array
  nonce: Uint8Array
  plaintext: Uint8Array
  /** Associated data, bound to the ciphertext but not encrypted. Always a domain string here. */
  aad: string
}

export interface OpenInput {
  key: Uint8Array
  nonce: Uint8Array
  /** Ciphertext with the 16-byte tag appended, exactly as `seal` returns it. */
  ciphertext: Uint8Array
  aad: string
  /**
   * Which failure a bad tag means for this caller. Unwrapping a password-derived
   * key uses `WRONG_PASSWORD`; opening a part whose key already worked uses the
   * default, because at that point a bad tag means the data was modified.
   */
  failureCode?: CryptoErrorCode
}

function assertKeyAndNonce(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', `key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(
      'MALFORMED_INPUT',
      `nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`,
    )
  }
}

/** AES-256-GCM. Returns ciphertext with the tag appended, which is how every part is stored. */
export function seal({ key, nonce, plaintext, aad }: SealInput): Uint8Array {
  assertKeyAndNonce(key, nonce)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]))
}

export function open({ key, nonce, ciphertext, aad, failureCode }: OpenInput): Uint8Array {
  assertKeyAndNonce(key, nonce)
  if (ciphertext.length < TAG_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', 'ciphertext is shorter than the authentication tag')
  }
  const split = ciphertext.length - TAG_BYTES
  const decipher = createDecipheriv(ALGORITHM, key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(ciphertext.subarray(split))
  try {
    return new Uint8Array(
      Buffer.concat([decipher.update(ciphertext.subarray(0, split)), decipher.final()]),
    )
  } catch {
    // Node throws a generic "unsupported state or unable to authenticate data".
    // The original message is dropped on purpose: it tells the caller nothing and
    // reads like a bug rather than a wrong password.
    throw new CryptoError(failureCode ?? 'DECRYPTION_FAILED', 'authentication tag did not verify')
  }
}
