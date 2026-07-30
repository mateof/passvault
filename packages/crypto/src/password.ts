import { hash, verify } from '@node-rs/argon2'
import { ARGON2ID, DEFAULT_ARGON2_PARAMS, encodeSecret, type Argon2Params } from './kdf.js'

/**
 * Hashes a login password.
 *
 * Distinct from `deriveKey` in intent even though both use Argon2id: this produces
 * a verifier that is stored and never used as a key, while `deriveKey` produces a
 * key that is used and never stored. Keeping them in separate functions makes the
 * difference visible at every call site.
 */
export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  return hash(encodeSecret(password), {
    algorithm: ARGON2ID,
    memoryCost: params.memoryKiB,
    timeCost: params.iterations,
    parallelism: params.parallelism,
  })
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, encodeSecret(password))
  } catch {
    // A malformed stored hash must not crash a login attempt; it is a failed
    // verification, and the surrounding code logs the account for repair.
    return false
  }
}

/**
 * A hash of a random value, used to spend the same work on a login attempt for an
 * address that has no account.
 *
 * Without it, the response time distinguishes "no such user" from "wrong password"
 * and the login endpoint becomes an account enumeration oracle. Generated once per
 * process at the current parameters so the timing matches real verifications.
 */
let dummyHash: Promise<string> | undefined

export function dummyPasswordHash(params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<string> {
  dummyHash ??= hashPassword(`absent-account-${Math.random()}`, params)
  return dummyHash
}

export async function verifyAgainstAbsentAccount(password: string): Promise<false> {
  await verifyPassword(await dummyPasswordHash(), password)
  return false
}

const PHC_PARAMS = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/

/**
 * True when a stored hash was produced with weaker parameters than the current
 * defaults, so a successful login can transparently upgrade it. Also true for a
 * hash this code cannot parse, since rehashing is the safe response to an
 * unrecognised format.
 */
export function needsRehash(stored: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  const match = PHC_PARAMS.exec(stored)
  if (!match) {
    return true
  }
  const [, memory, time, parallelism] = match
  return (
    Number(memory) < params.memoryKiB ||
    Number(time) < params.iterations ||
    Number(parallelism) < params.parallelism
  )
}
