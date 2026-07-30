import { Algorithm } from '@node-rs/argon2'
import { describe, expect, it } from 'vitest'
import {
  ARGON2ID,
  DEFAULT_ARGON2_PARAMS,
  TEST_ARGON2_PARAMS,
  assertUsableParams,
  deriveKey,
  encodeSecret,
  randomSalt,
} from '@passvault/crypto'

describe('key derivation', () => {
  it('derives a 32-byte key', async () => {
    const key = await deriveKey('event password', randomSalt(), TEST_ARGON2_PARAMS)

    expect(key.length).toBe(32)
  })

  it('derives the same key from the same secret, salt and parameters', async () => {
    const salt = randomSalt()

    const first = await deriveKey('event password', salt, TEST_ARGON2_PARAMS)
    const second = await deriveKey('event password', salt, TEST_ARGON2_PARAMS)

    expect(first).toEqual(second)
  })

  it('derives a different key under a different salt', async () => {
    const first = await deriveKey('event password', randomSalt(), TEST_ARGON2_PARAMS)
    const second = await deriveKey('event password', randomSalt(), TEST_ARGON2_PARAMS)

    expect(first).not.toEqual(second)
  })

  it('derives a different key when the parameters change, which is why files carry them', async () => {
    const salt = randomSalt()

    const weak = await deriveKey('event password', salt, TEST_ARGON2_PARAMS)
    const stronger = await deriveKey('event password', salt, {
      ...TEST_ARGON2_PARAMS,
      iterations: 2,
    })

    expect(weak).not.toEqual(stronger)
  })
})

describe('secret encoding', () => {
  it('normalises to NFC so the same visible password matches across platforms', () => {
    const composed = 'contrasinal común'

    expect(encodeSecret(composed.normalize('NFD'))).toEqual(encodeSecret(composed))
  })
})

describe('parameter limits', () => {
  it('accepts the production defaults', () => {
    expect(() => assertUsableParams(DEFAULT_ARGON2_PARAMS)).not.toThrow()
  })

  it('rejects a memory cost that would exhaust a phone', () => {
    expect(() =>
      assertUsableParams({ ...DEFAULT_ARGON2_PARAMS, memoryKiB: 8_388_608 }),
    ).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
  })

  it('rejects an iteration count a hostile file could use to stall the reader', () => {
    expect(() => assertUsableParams({ ...DEFAULT_ARGON2_PARAMS, iterations: 1_000 })).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    )
  })

  it('rejects parameters below the usable minimum', () => {
    expect(() => assertUsableParams({ memoryKiB: 4, iterations: 1, parallelism: 1 })).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_INPUT' }),
    )
  })
})

describe('the inlined Argon2id identifier', () => {
  it('still matches the value the argon2 package uses', () => {
    // Pins the workaround in kdf.ts: the package types its algorithm enum as an
    // ambient const enum, so the number is inlined. If a release renumbers it, this
    // fails instead of quietly hashing with Argon2i.
    expect(ARGON2ID).toBe(Algorithm.Argon2id)
  })
})
