import { describe, expect, it } from 'vitest'
import { blindIndex, blindIndexEquals, normalise, randomKey } from '@passvault/crypto'

const ADDRESS = 'ana@example.org'

describe('email blind index', () => {
  it('gives the same index for the same address under the same key', () => {
    const key = randomKey()

    expect(blindIndex(key, ADDRESS)).toBe(blindIndex(key, ADDRESS))
  })

  it('gives the same index regardless of case and surrounding whitespace', () => {
    const key = randomKey()

    expect(blindIndex(key, '  Ana@Example.ORG ')).toBe(blindIndex(key, ADDRESS))
  })

  it('gives different indexes for different addresses', () => {
    const key = randomKey()

    expect(blindIndex(key, ADDRESS)).not.toBe(blindIndex(key, 'brais@example.org'))
  })

  it('gives a different index for the same address under a different key', () => {
    expect(blindIndex(randomKey(), ADDRESS)).not.toBe(blindIndex(randomKey(), ADDRESS))
  })

  it('does not reveal the address it was built from', () => {
    expect(blindIndex(randomKey(), ADDRESS)).not.toContain('ana')
  })

  it('compares two indexes without leaking their difference through timing', () => {
    const key = randomKey()
    const index = blindIndex(key, ADDRESS)

    expect(blindIndexEquals(index, index)).toBe(true)
    expect(blindIndexEquals(index, blindIndex(key, 'brais@example.org'))).toBe(false)
  })
})

describe('address normalisation', () => {
  it('is applied to the value that gets encrypted as well, so the two cannot disagree', () => {
    expect(normalise('  Ana@Example.ORG ')).toBe(ADDRESS)
  })
})
