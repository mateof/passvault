import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP, as specified in RFC 6238, written directly against `node:crypto`.
 *
 * No library: the algorithm is thirty lines, and the widely used Node packages for it are
 * either deprecated or drag in a dependency tree far larger than the code they replace.
 *
 * HMAC-SHA1 and a 30-second step because that is what Google Authenticator and Microsoft
 * Authenticator implement. SHA-1 here is not a security choice to revisit — it is the wire
 * format, and "upgrading" it produces codes no authenticator app will match.
 */
export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6

/** One step either side, which covers clock drift and a user typing as a code rolls over. */
export const TOTP_WINDOW = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(new Uint8Array(randomBytes(bytes)))
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export function base32Decode(secret: string): Uint8Array {
  const cleaned = secret.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const output: number[] = []
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) {
      throw new Error(`'${character}' is not a base32 character`)
    }
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(output)
}

export function totpCode(secret: string, atMs: number = Date.now()): string {
  return codeForCounter(base32Decode(secret), Math.floor(atMs / 1000 / TOTP_STEP_SECONDS))
}

function codeForCounter(key: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(message).digest()
  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * Checks a code against the current step and its neighbours.
 *
 * Compared in constant time. A timing side channel on a six-digit code is not the most
 * pressing risk in this system, but the comparison is one line either way and doing it
 * properly means nobody has to reason about whether it matters.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number = Date.now(),
  window = TOTP_WINDOW,
): boolean {
  const trimmed = code.replace(/\s/g, '')
  if (!/^\d+$/.test(trimmed) || trimmed.length !== TOTP_DIGITS) {
    return false
  }
  const key = base32Decode(secret)
  const current = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS)
  const supplied = Buffer.from(trimmed)
  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = Buffer.from(codeForCounter(key, current + drift))
    if (candidate.length === supplied.length && timingSafeEqual(candidate, supplied)) {
      return true
    }
  }
  return false
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice — as a label prefix and as a parameter — because that is what the
 * de facto specification requires for apps to group accounts correctly.
 */
export function totpUri(options: { secret: string; accountName: string; issuer?: string }): string {
  const issuer = options.issuer ?? 'PassVault'
  const label = encodeURIComponent(`${issuer}:${options.accountName}`)
  const parameters = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${parameters.toString()}`
}
