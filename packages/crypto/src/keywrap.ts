import { open, seal } from './aead.js'
import { type CryptoErrorCode } from './errors.js'
import { KEY_BYTES, randomNonce } from './random.js'

/** A 32-byte key encrypted under another key. 48 bytes of ciphertext plus its nonce. */
export interface WrappedKey {
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export function wrapKey(kek: Uint8Array, key: Uint8Array, aad: string): WrappedKey {
  const nonce = randomNonce()
  return { nonce, ciphertext: seal({ key: kek, nonce, plaintext: key, aad }) }
}

export function unwrapKey(
  kek: Uint8Array,
  wrapped: WrappedKey,
  aad: string,
  failureCode: CryptoErrorCode = 'WRONG_KEY',
): Uint8Array {
  const key = open({
    key: kek,
    nonce: wrapped.nonce,
    ciphertext: wrapped.ciphertext,
    aad,
    failureCode,
  })
  if (key.length !== KEY_BYTES) {
    // Reachable only if a slot was written by a broken implementation: the tag
    // verified, so the bytes are authentic, they are just not a key.
    throw new Error(`unwrapped key has ${key.length} bytes, expected ${KEY_BYTES}`)
  }
  return key
}
