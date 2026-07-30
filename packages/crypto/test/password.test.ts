import { describe, expect, it } from 'vitest'
import {
  TEST_ARGON2_PARAMS,
  hashPassword,
  needsRehash,
  verifyAgainstAbsentAccount,
  verifyPassword,
} from '@passvault/crypto'

const PASSWORD = 'entradas do festival 2026'

describe('login password hashing', () => {
  it('accepts the password it was created from', async () => {
    const stored = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(true)
  })

  it('rejects a different password', async () => {
    const stored = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    await expect(verifyPassword(stored, 'entradas do festival 2027')).resolves.toBe(false)
  })

  it('never stores the password in a recoverable form', async () => {
    const stored = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    expect(stored).not.toContain('festival')
  })

  it('produces a different hash each time, because the salt is fresh', async () => {
    const first = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)
    const second = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    expect(first).not.toBe(second)
  })

  it('accepts a password typed in a different Unicode normalisation form', async () => {
    const composed = 'contrasinal común'
    const stored = await hashPassword(composed, TEST_ARGON2_PARAMS)

    await expect(verifyPassword(stored, composed.normalize('NFD'))).resolves.toBe(true)
  })

  it('treats a corrupted stored hash as a failed verification instead of throwing', async () => {
    await expect(verifyPassword('not-a-phc-string', PASSWORD)).resolves.toBe(false)
  })
})

describe('account enumeration', () => {
  it('always answers false for an address with no account', async () => {
    await expect(verifyAgainstAbsentAccount(PASSWORD)).resolves.toBe(false)
  })
})

describe('parameter upgrades', () => {
  it('flags a hash produced with weaker parameters than the current policy', async () => {
    const stored = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    expect(needsRehash(stored, { memoryKiB: 65_536, iterations: 3, parallelism: 1 })).toBe(true)
  })

  it('leaves a hash at the current policy alone', async () => {
    const stored = await hashPassword(PASSWORD, TEST_ARGON2_PARAMS)

    expect(needsRehash(stored, TEST_ARGON2_PARAMS)).toBe(false)
  })

  it('flags a hash whose format it cannot parse, because rehashing is the safe response', () => {
    expect(needsRehash('$2b$12$something.bcrypt.shaped')).toBe(true)
  })
})
