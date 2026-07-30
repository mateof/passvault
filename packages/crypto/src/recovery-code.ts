import { CryptoError } from './errors.js'
import { randomBytesOf } from './random.js'

/**
 * Crockford base32: no padding, and no characters a person can confuse when copying
 * from paper. `I`, `L`, `O` and `U` are absent from the alphabet — the first three
 * because they read as `1`, `1` and `0`, and `U` so that the encoding cannot spell
 * unfortunate words.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_BYTES = 20
const GROUP_SIZE = 4

/**
 * A 160-bit recovery code, the third way to unwrap a user's data key when the vault
 * passphrase is forgotten.
 *
 * A word list such as BIP39 would be friendlier to transcribe, but it would mean
 * shipping and agreeing on 2048 words in two implementations for a value the user
 * writes down once. 160 random bits need no stretching: the code is the key
 * material, so there is no password to guess.
 */
export function generateRecoveryCode(): string {
  return format(encode(randomBytesOf(CODE_BYTES)))
}

function encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

function format(code: string): string {
  const groups: string[] = []
  for (let index = 0; index < code.length; index += GROUP_SIZE) {
    groups.push(code.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Accepts a code as a person is likely to retype it: lower case, spaces instead of
 * dashes, and the substitutions Crockford defines for the excluded letters. A code
 * that fails to normalise is malformed, which the interface reports as "check the
 * code" rather than as a wrong code.
 */
export function normaliseRecoveryCode(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[ILU]/g, (letter) => (letter === 'U' ? 'V' : '1'))
    .replace(/O/g, '0')
  if (cleaned.length !== Math.ceil((CODE_BYTES * 8) / 5)) {
    throw new CryptoError('MALFORMED_INPUT', 'recovery code has the wrong length')
  }
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) {
      throw new CryptoError('MALFORMED_INPUT', `recovery code contains '${character}'`)
    }
  }
  return cleaned
}
