import { createHmac, timingSafeEqual } from 'node:crypto'
import { toBase64Url } from './base64url.js'

/**
 * A searchable, non-reversible index over an encrypted column.
 *
 * Email addresses are stored as ciphertext, which cannot be looked up or made
 * unique. The blind index is an HMAC of the normalised address in a mirror column:
 * equality lookups and unique constraints work on it, and without the server's
 * HMAC key it cannot be reversed by hashing a list of candidate addresses — which a
 * plain SHA-256 of an email would not survive for a second.
 *
 * It is deterministic by construction, so it does reveal that two rows hold the
 * same address. That is exactly what the unique constraint needs.
 */
export function blindIndex(key: Uint8Array, value: string): string {
  return toBase64Url(new Uint8Array(createHmac('sha256', key).update(normalise(value)).digest()))
}

/**
 * Normalises before hashing so that `Ana@Example.ORG` and `ana@example.org` collide
 * as the same account. Applied to the value that gets encrypted too, otherwise the
 * stored address and its index could disagree.
 */
export function normalise(value: string): string {
  return value.normalize('NFC').trim().toLowerCase()
}

export function blindIndexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
