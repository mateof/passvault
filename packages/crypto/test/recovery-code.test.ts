import { describe, expect, it } from 'vitest'
import { generateRecoveryCode, normaliseRecoveryCode } from '@passvault/crypto'

describe('recovery codes', () => {
  it('is grouped in fours so it can be read off paper', () => {
    expect(generateRecoveryCode()).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
  })

  it('carries 160 bits, which is why it needs no stretching', () => {
    const code = normaliseRecoveryCode(generateRecoveryCode())

    expect(code.length).toBe(32)
  })

  it('never contains characters that are confused when copying', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(generateRecoveryCode()).not.toMatch(/[ILOU]/)
    }
  })

  it('is different every time', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode())
  })

  it('accepts a code retyped in lower case', () => {
    const code = generateRecoveryCode()

    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(normaliseRecoveryCode(code))
  })

  it('accepts a code retyped with spaces instead of dashes', () => {
    const code = generateRecoveryCode()

    expect(normaliseRecoveryCode(code.replace(/-/g, ' '))).toBe(normaliseRecoveryCode(code))
  })

  it('reads a letter O as the digit zero', () => {
    const code = normaliseRecoveryCode('0000-0000-0000-0000-0000-0000-0000-0000')

    expect(normaliseRecoveryCode('OOOO-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO')).toBe(code)
  })

  it('reads the letters I and L as the digit one', () => {
    const code = normaliseRecoveryCode('1111-1111-1111-1111-1111-1111-1111-1111')

    expect(normaliseRecoveryCode('IIII-LLLL-IIII-LLLL-IIII-LLLL-IIII-LLLL')).toBe(code)
  })

  it('rejects a code of the wrong length rather than deriving from a truncated one', () => {
    expect(() => normaliseRecoveryCode('ABCD-EFGH')).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_INPUT' }),
    )
  })
})
