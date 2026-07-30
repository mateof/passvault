import { TkpakError } from './errors.js'

/**
 * Bounds on a hostile archive. Real files are nowhere near these — a ten-ticket PDF
 * export is two to six MiB — but a ZIP is attacker-controlled input and a reader
 * that allocates whatever the headers claim is a denial of service waiting to
 * happen.
 */
export const LIMITS = {
  manifestBytes: 1024 * 1024,
  payloadBytes: 8 * 1024 * 1024,
  blobBytes: 32 * 1024 * 1024,
  blobCount: 512,
  totalBytes: 512 * 1024 * 1024,
  keySlots: 32,
} as const

export function assertWithin(actual: number, limit: number, what: string): void {
  if (actual > limit) {
    throw new TkpakError('LIMIT_EXCEEDED', `${what}: ${actual} exceeds the limit of ${limit}`)
  }
}
