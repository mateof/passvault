import { hashRaw } from '@node-rs/argon2'
import { CryptoError } from './errors.js'
import { KEY_BYTES } from './random.js'

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`.
 *
 * The package declares its algorithm enum as an ambient `const enum`, which cannot
 * be imported under `verbatimModuleSyntax`, so the value is inlined. It is pinned
 * against the package's own runtime export in `kdf.test.ts`: a renumbering in a
 * future release fails a test rather than silently switching us to Argon2i.
 */
export const ARGON2ID = 2

/**
 * Argon2id parameters. They travel with the data they protect — inside a `.tkpak`
 * manifest, or in a user's key envelope row — so they can be raised later without
 * invalidating anything already written. A reader honours what it reads.
 */
export interface Argon2Params {
  memoryKiB: number
  iterations: number
  parallelism: number
}

/** 64 MiB / 3 passes: the OWASP 2024 guidance, and comfortable on a mid-range phone. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
}

/**
 * Deliberately weak, for tests and reference vectors only.
 *
 * Using the production parameters would add seconds to every test run, which ends
 * with someone deleting the tests.
 */
export const TEST_ARGON2_PARAMS: Argon2Params = {
  memoryKiB: 8_192,
  iterations: 1,
  parallelism: 1,
}

const MAX_MEMORY_KIB = 1_048_576
const MAX_ITERATIONS = 16
const MAX_PARALLELISM = 16

/**
 * Rejects parameters a hostile file could use to exhaust memory. A phone asked for
 * 8 GiB of Argon2 memory does not fail gracefully, so the limit is enforced before
 * the allocation rather than after.
 */
export function assertUsableParams(params: Argon2Params): void {
  if (params.memoryKiB > MAX_MEMORY_KIB) {
    throw new CryptoError('LIMIT_EXCEEDED', `memoryKiB ${params.memoryKiB} exceeds the limit`)
  }
  if (params.iterations > MAX_ITERATIONS) {
    throw new CryptoError('LIMIT_EXCEEDED', `iterations ${params.iterations} exceeds the limit`)
  }
  if (params.parallelism > MAX_PARALLELISM) {
    throw new CryptoError('LIMIT_EXCEEDED', `parallelism ${params.parallelism} exceeds the limit`)
  }
  if (params.memoryKiB < 8 || params.iterations < 1 || params.parallelism < 1) {
    throw new CryptoError('MALFORMED_INPUT', 'Argon2 parameters are below the usable minimum')
  }
}

/**
 * Normalises a human-typed secret to NFC before encoding.
 *
 * The same accented password typed on an Android keyboard and on a desktop can
 * arrive as different byte sequences for what the user sees as identical text.
 * Fixing the normalisation form is what makes a password portable between the two
 * implementations of this format.
 */
export function encodeSecret(secret: string): Buffer {
  return Buffer.from(secret.normalize('NFC'), 'utf8')
}

/** Derives a 32-byte key-encryption key from a human secret. */
export async function deriveKey(
  secret: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Uint8Array> {
  assertUsableParams(params)
  // hashRaw returns the derived bytes; `hash` would return a PHC string, which is
  // what a stored verifier needs and a key never does.
  const derived = await hashRaw(encodeSecret(secret), {
    algorithm: ARGON2ID,
    salt: Buffer.from(salt),
    memoryCost: params.memoryKiB,
    timeCost: params.iterations,
    parallelism: params.parallelism,
    outputLen: KEY_BYTES,
  })
  return new Uint8Array(derived)
}
