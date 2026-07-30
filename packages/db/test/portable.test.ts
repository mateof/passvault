import { describe, expect, it } from 'vitest'
import {
  formatCents,
  fromBytes,
  fromCents,
  fromInstant,
  instantIn,
  isExpired,
  isInstant,
  newId,
  toBoolean,
  toBytes,
  toCents,
  toInstant,
  toInt,
} from '@passvault/db'

describe('identifiers', () => {
  it('is a UUID version 7', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('sorts in creation order as text, which is why the schema needs no sequence', () => {
    const first = newId()
    const second = newId()

    expect([second, first].sort()).toEqual([first, second])
  })
})

describe('stored instants', () => {
  it('is always 24 characters, so text order equals chronological order', () => {
    expect(toInstant(new Date('2026-08-14T19:00:00Z'))).toHaveLength(24)
  })

  it('keeps millisecond precision', () => {
    expect(toInstant(new Date(1_785_000_000_123))).toMatch(/\.123Z$/)
  })

  it('is always UTC, whatever the server timezone', () => {
    expect(toInstant(new Date('2026-08-14T19:00:00+02:00'))).toBe('2026-08-14T17:00:00.000Z')
  })

  it('reads back as the same moment', () => {
    const moment = new Date('2026-08-14T19:00:00.500Z')

    expect(fromInstant(toInstant(moment)).getTime()).toBe(moment.getTime())
  })

  it('orders lexicographically the same way it orders chronologically', () => {
    const earlier = toInstant(new Date('2026-08-14T19:00:00Z'))
    const later = toInstant(new Date('2026-09-01T08:30:00Z'))

    expect(earlier < later).toBe(true)
  })

  it('rejects a value that is not a stored instant', () => {
    expect(() => fromInstant('14/08/2026')).toThrow(TypeError)
  })

  it('recognises a well-formed stored instant', () => {
    expect(isInstant('2026-08-14T19:00:00.000Z')).toBe(true)
  })

  it('rejects a truncated instant, which would break fixed-width ordering', () => {
    expect(isInstant('2026-08-14T19:00:00Z')).toBe(false)
  })
})

describe('expiry', () => {
  it('is not expired before its instant', () => {
    expect(isExpired(instantIn(60))).toBe(false)
  })

  it('is expired after its instant', () => {
    expect(isExpired(instantIn(-1))).toBe(true)
  })
})

describe('stored booleans', () => {
  it('writes true as 1', () => {
    expect(toInt(true)).toBe(1)
  })

  it('writes false as 0', () => {
    expect(toInt(false)).toBe(0)
  })

  it('reads the integer SQLite and Oracle return', () => {
    expect(toBoolean(1)).toBe(true)
  })

  it('reads the boolean PostgreSQL returns', () => {
    expect(toBoolean(false)).toBe(false)
  })

  it("reads the string '0' as false, which plain truthiness would get wrong", () => {
    expect(toBoolean('0')).toBe(false)
  })

  it('reads a null flag as false rather than throwing', () => {
    expect(toBoolean(null)).toBe(false)
  })
})

describe('money', () => {
  it('stores an amount as integer cents', () => {
    expect(toCents(45)).toBe(4500)
  })

  it('rounds rather than truncating a fractional cent', () => {
    expect(toCents(4.005)).toBe(401)
  })

  it('reads cents back as an amount', () => {
    expect(fromCents(4500)).toBe(45)
  })

  it('adds without the error a float would introduce', () => {
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3))
  })

  it('formats for the reader locale', () => {
    expect(formatCents(4500, 'EUR', 'gl-ES')).toContain('45')
  })
})

describe('stored bytes', () => {
  it('reads the Buffer every driver returns', () => {
    expect(toBytes(Buffer.from([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('passes a Uint8Array through unchanged', () => {
    const bytes = new Uint8Array([9, 8, 7])

    expect(toBytes(bytes)).toBe(bytes)
  })

  it('round-trips through the write form', () => {
    const bytes = new Uint8Array([0, 255, 128])

    expect(toBytes(fromBytes(bytes))).toEqual(bytes)
  })

  it('rejects a value that is not bytes rather than producing an empty array', () => {
    expect(() => toBytes('not bytes')).toThrow(TypeError)
  })
})
