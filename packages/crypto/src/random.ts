import { randomBytes, randomInt } from 'node:crypto'

export const KEY_BYTES = 32
export const NONCE_BYTES = 12
export const SALT_BYTES = 16

export function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES))
}

/**
 * A fresh 96-bit nonce per encryption.
 *
 * Always random, never a counter: a counter would have to be persisted and shared
 * across every file a device ever writes, and reusing a nonce under the same key
 * breaks GCM completely. At 96 bits the collision probability is negligible for
 * the number of parts one device will ever encrypt.
 */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_BYTES))
}

export function randomSalt(): Uint8Array {
  return new Uint8Array(randomBytes(SALT_BYTES))
}

export function randomBytesOf(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length))
}

/** Uniform digit string for out-of-band codes, without the modulo bias of `random() % 10`. */
export function randomDigits(count: number): string {
  let digits = ''
  for (let index = 0; index < count; index += 1) {
    digits += String(randomInt(0, 10))
  }
  return digits
}
