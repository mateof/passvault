import { v7 as uuidv7 } from 'uuid'

/**
 * The value conventions that let one schema work on six engines.
 *
 * Each of these exists because a native type behaves differently somewhere. Reaching
 * for the native type is the tempting mistake: it works until the day someone points
 * `DATABASE_URL` at another engine and the sort order silently changes.
 */

export type Uuid = string

/** Time-ordered identifier, generated in the application so no engine sequence is involved. */
export function newId(): Uuid {
  return uuidv7()
}

const INSTANT_LENGTH = 24

/**
 * ISO-8601 UTC with millisecond precision, always exactly 24 characters.
 *
 * Fixed width is the point: lexicographic comparison equals chronological comparison,
 * so `ORDER BY created_at` and range scans behave identically on every engine without a
 * date type, and a value read back is the value written — no timezone conversion by a
 * driver, no truncation to seconds, no local-time surprise.
 */
export function toInstant(date: Date = new Date()): string {
  return date.toISOString()
}

export function fromInstant(value: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`'${value}' is not a stored instant`)
  }
  return parsed
}

export function isInstant(value: string): boolean {
  return (
    value.length === INSTANT_LENGTH &&
    value.endsWith('Z') &&
    !Number.isNaN(new Date(value).getTime())
  )
}

/** Instant shifted by a number of seconds, for expiry columns. */
export function instantIn(seconds: number, from: Date = new Date()): string {
  return toInstant(new Date(from.getTime() + seconds * 1000))
}

export function isExpired(instant: string, now: Date = new Date()): boolean {
  return fromInstant(instant).getTime() <= now.getTime()
}

/**
 * Booleans as 0 and 1.
 *
 * SQLite has no boolean type, Oracle has none either, and MySQL's is an alias for
 * TINYINT. Drivers therefore return `1`, `true` or `'1'` depending on the engine, so
 * reading goes through `toBoolean` rather than relying on truthiness — `'0'` is truthy
 * in JavaScript, which would invert every flag on one engine and nowhere else.
 */
export function toInt(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true'
  }
  if (value === null || value === undefined) {
    return false
  }
  throw new TypeError(`cannot read ${typeof value} as a stored boolean`)
}

/**
 * Money as integer cents.
 *
 * Never a float: 0.1 + 0.2 is not 0.3, and a shared bill that does not add up is a
 * bug users notice immediately.
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100)
}

export function fromCents(cents: number): number {
  return cents / 100
}

export function formatCents(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}

/**
 * Binary values as `Uint8Array` regardless of driver.
 *
 * better-sqlite3 returns Buffer, pg returns Buffer, mysql2 returns Buffer, tedious
 * returns Buffer, oracledb returns Buffer or a Lob. Normalising on read keeps every
 * caller from having to know which.
 */
export function toBytes(value: unknown): Uint8Array {
  if (Buffer.isBuffer(value)) {
    // A Buffer is a Uint8Array subclass, so returning it unchanged would satisfy the
    // type while leaking the subclass into anything comparing by prototype. A view over
    // the same memory normalises without copying, which matters for a 30 MiB document.
    // The byteOffset is not decoration: a Buffer usually points into a pooled
    // ArrayBuffer, and ignoring it would return the whole pool.
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof Uint8Array) {
    return value
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value)
  }
  throw new TypeError(`cannot read ${typeof value} as stored bytes`)
}

export function fromBytes(value: Uint8Array): Buffer {
  return Buffer.from(value)
}
