import { CryptoError } from './errors.js'

const UNPADDED_BASE64URL = /^[A-Za-z0-9_-]*$/

/** Encodes bytes as base64url without padding, the only binary form the formats use. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Decodes base64url without padding.
 *
 * Standard base64 and padded input are rejected rather than quietly accepted:
 * `.tkpak` signatures cover the exact manifest bytes, so a reader that tolerates
 * several encodings of the same value would let a file round-trip into different
 * bytes than the ones that were signed.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (!UNPADDED_BASE64URL.test(text)) {
    throw new CryptoError('MALFORMED_INPUT', 'value is not unpadded base64url')
  }
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

/** Decodes and checks the length in one step, since most callers need a fixed-size key or nonce. */
export function fromBase64UrlExact(text: string, expectedBytes: number): Uint8Array {
  const bytes = fromBase64Url(text)
  if (bytes.length !== expectedBytes) {
    throw new CryptoError('MALFORMED_INPUT', `expected ${expectedBytes} bytes, got ${bytes.length}`)
  }
  return bytes
}
