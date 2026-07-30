import {
  CryptoError,
  ED25519_PUBLIC_BYTES,
  NONCE_BYTES,
  X25519_KEY_BYTES,
  fromBase64Url,
  fromBase64UrlExact,
} from '@passvault/crypto'
import { TkpakError, malformed } from './errors.js'
import { LIMITS, assertWithin } from './limits.js'
import {
  DOCUMENT_MEDIA_TYPES,
  TKPAK_FORMAT,
  TKPAK_VERSION,
  type DocumentMediaType,
  type TkpakBlobEntry,
  type TkpakKeySlot,
  type TkpakManifest,
  type TkpakPartDigest,
  type TkpakPreview,
} from './types.js'

const SHA256_BYTES = 32

type Unknown = Record<string, unknown>

function asObject(value: unknown, path: string): Unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(`${path} must be an object`)
  }
  return value as Unknown
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(`${path} must be an array`)
  }
  return value
}

function requireString(source: Unknown, key: string, path: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw malformed(`${path}.${key} must be a non-empty string`)
  }
  return value
}

function optionalString(source: Unknown, key: string, path: string): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw malformed(`${path}.${key} must be a string when present`)
  }
  return value
}

function requireInteger(source: Unknown, key: string, path: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`${path}.${key} must be a non-negative integer`)
  }
  return value
}

/** Bad base64url is a malformed manifest, not a cryptographic failure. */
function requireBytes(source: Unknown, key: string, path: string, exactBytes?: number): string {
  const encoded = requireString(source, key, path)
  try {
    if (exactBytes === undefined) {
      fromBase64Url(encoded)
    } else {
      fromBase64UrlExact(encoded, exactBytes)
    }
  } catch (error) {
    if (error instanceof CryptoError) {
      throw malformed(`${path}.${key}: ${error.message}`)
    }
    throw error
  }
  return encoded
}

function parsePartDigest(value: unknown, path: string): TkpakPartDigest {
  const source = asObject(value, path)
  return {
    nonce: requireBytes(source, 'nonce', path, NONCE_BYTES),
    sha256: requireBytes(source, 'sha256', path, SHA256_BYTES),
    byteLength: requireInteger(source, 'byteLength', path),
  }
}

function parseKeySlot(value: unknown, path: string): TkpakKeySlot {
  const source = asObject(value, path)
  const kind = requireString(source, 'kind', path)
  if (kind === 'argon2id') {
    return {
      kind,
      salt: requireBytes(source, 'salt', path),
      memoryKiB: requireInteger(source, 'memoryKiB', path),
      iterations: requireInteger(source, 'iterations', path),
      parallelism: requireInteger(source, 'parallelism', path),
      wrapNonce: requireBytes(source, 'wrapNonce', path, NONCE_BYTES),
      wrappedFileKey: requireBytes(source, 'wrappedFileKey', path),
    }
  }
  if (kind === 'x25519-sealed') {
    return {
      kind,
      recipientPublicKey: requireBytes(source, 'recipientPublicKey', path, X25519_KEY_BYTES),
      ephemeralPublicKey: requireBytes(source, 'ephemeralPublicKey', path, X25519_KEY_BYTES),
      wrapNonce: requireBytes(source, 'wrapNonce', path, NONCE_BYTES),
      wrappedFileKey: requireBytes(source, 'wrappedFileKey', path),
    }
  }
  // An unrecognised slot kind is not fatal on its own — a version 1 file may carry a
  // slot this reader cannot use alongside one it can — but it cannot be represented,
  // so it is reported and the caller falls back to another slot.
  throw malformed(`${path}.kind '${kind}' is not a supported key slot`)
}

function parseBlob(value: unknown, path: string): TkpakBlobEntry {
  const source = asObject(value, path)
  const mediaType = requireString(source, 'mediaType', path)
  if (!DOCUMENT_MEDIA_TYPES.includes(mediaType as DocumentMediaType)) {
    throw malformed(`${path}.mediaType '${mediaType}' is not a supported document type`)
  }
  return {
    ...parsePartDigest(value, path),
    id: requireString(source, 'id', path),
    mediaType: mediaType as DocumentMediaType,
  }
}

function parsePreview(value: unknown, path: string): TkpakPreview {
  const source = asObject(value, path)
  const preview: TkpakPreview = { ticketCount: requireInteger(source, 'ticketCount', path) }
  const eventName = optionalString(source, 'eventName', path)
  const eventStartsAt = optionalString(source, 'eventStartsAt', path)
  const venue = optionalString(source, 'venue', path)
  if (eventName !== undefined) preview.eventName = eventName
  if (eventStartsAt !== undefined) preview.eventStartsAt = eventStartsAt
  if (venue !== undefined) preview.venue = venue
  return preview
}

/**
 * Parses and validates a manifest.
 *
 * The order is the one the specification mandates: what the file claims to be, then
 * whether its numbers are sane, and only afterwards anything cryptographic. A reader
 * that verified a signature before checking the version would answer "corrupt file"
 * to a file from a newer release, which is both wrong and unhelpful.
 */
export function parseManifest(manifestBytes: Uint8Array): TkpakManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  } catch {
    throw malformed('manifest.json is not valid JSON')
  }
  const source = asObject(parsed, 'manifest')

  if (source.format !== TKPAK_FORMAT) {
    throw new TkpakError('NOT_A_TKPAK', `manifest.format is '${String(source.format)}'`)
  }
  const version = source.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw malformed('manifest.version must be a positive integer')
  }
  if (version > TKPAK_VERSION) {
    throw new TkpakError(
      'UNSUPPORTED_VERSION',
      `file is version ${version}, this reader supports up to ${TKPAK_VERSION}`,
    )
  }

  const issuerSource = asObject(source.issuer, 'manifest.issuer')
  const slots = asArray(source.keySlots, 'manifest.keySlots')
  if (slots.length === 0) {
    throw malformed('manifest.keySlots must not be empty')
  }
  assertWithin(slots.length, LIMITS.keySlots, 'manifest.keySlots')

  const blobs = asArray(source.blobs ?? [], 'manifest.blobs')
  assertWithin(blobs.length, LIMITS.blobCount, 'manifest.blobs')

  const manifest: TkpakManifest = {
    format: TKPAK_FORMAT,
    version,
    fileId: requireString(source, 'fileId', 'manifest'),
    createdAt: requireString(source, 'createdAt', 'manifest'),
    issuer: {
      deviceId: requireString(issuerSource, 'deviceId', 'manifest.issuer'),
      publicKey: requireBytes(issuerSource, 'publicKey', 'manifest.issuer', ED25519_PUBLIC_BYTES),
    },
    keySlots: slots.map((slot, index) => parseKeySlot(slot, `manifest.keySlots[${index}]`)),
    payload: parsePartDigest(source.payload, 'manifest.payload'),
    blobs: blobs.map((blob, index) => parseBlob(blob, `manifest.blobs[${index}]`)),
  }

  const displayName = optionalString(issuerSource, 'displayName', 'manifest.issuer')
  if (displayName !== undefined) {
    manifest.issuer.displayName = displayName
  }
  if (source.preview !== undefined && source.preview !== null) {
    manifest.preview = parsePreview(source.preview, 'manifest.preview')
  }

  const duplicateBlob = firstDuplicate(manifest.blobs.map((blob) => blob.id))
  if (duplicateBlob) {
    throw malformed(`manifest.blobs contains ${duplicateBlob} twice`)
  }

  return manifest
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      return value
    }
    seen.add(value)
  }
  return undefined
}
