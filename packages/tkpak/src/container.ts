import { unzipSync, zipSync } from 'fflate'
import { TkpakError } from './errors.js'
import { LIMITS, assertWithin } from './limits.js'

export const MANIFEST_ENTRY = 'manifest.json'
export const PAYLOAD_ENTRY = 'payload.bin'
export const SIGNATURE_ENTRY = 'signature.bin'
export const BLOB_PREFIX = 'blobs/'

export const blobEntryName = (blobId: string): string => `${BLOB_PREFIX}${blobId}.bin`

export interface ContainerParts {
  /**
   * The manifest exactly as stored. The signature covers these bytes, so a reader
   * must never hash a re-serialisation of the parsed object — that would make
   * verification depend on this implementation's JSON formatting.
   */
  manifestBytes: Uint8Array
  payload: Uint8Array
  signature: Uint8Array
  blobs: Map<string, Uint8Array>
}

/**
 * Writes the ZIP.
 *
 * Ciphertext is stored uncompressed: it is incompressible, so deflating it costs
 * time and saves nothing. The manifest is the one part worth compressing.
 */
export function packContainer(parts: {
  manifestBytes: Uint8Array
  payload: Uint8Array
  signature: Uint8Array
  blobs: Map<string, Uint8Array>
}): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    [MANIFEST_ENTRY]: [parts.manifestBytes, { level: 6 }],
    [PAYLOAD_ENTRY]: [parts.payload, { level: 0 }],
  }
  for (const [blobId, bytes] of parts.blobs) {
    entries[blobEntryName(blobId)] = [bytes, { level: 0 }]
  }
  entries[SIGNATURE_ENTRY] = [parts.signature, { level: 0 }]
  return zipSync(entries)
}

export function unpackContainer(archive: Uint8Array): ContainerParts {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive)
  } catch {
    throw new TkpakError('NOT_A_TKPAK', 'file is not a readable ZIP archive')
  }

  const manifestBytes = entries[MANIFEST_ENTRY]
  if (!manifestBytes) {
    throw new TkpakError('NOT_A_TKPAK', `archive has no ${MANIFEST_ENTRY}`)
  }
  assertWithin(manifestBytes.length, LIMITS.manifestBytes, MANIFEST_ENTRY)

  const payload = entries[PAYLOAD_ENTRY]
  if (!payload) {
    throw new TkpakError('NOT_A_TKPAK', `archive has no ${PAYLOAD_ENTRY}`)
  }
  assertWithin(payload.length, LIMITS.payloadBytes, PAYLOAD_ENTRY)

  const signature = entries[SIGNATURE_ENTRY]
  if (!signature) {
    throw new TkpakError('NOT_A_TKPAK', `archive has no ${SIGNATURE_ENTRY}`)
  }

  const blobs = new Map<string, Uint8Array>()
  let total = manifestBytes.length + payload.length + signature.length
  for (const [name, bytes] of Object.entries(entries)) {
    // Unknown entries are ignored rather than rejected, so a future version can add
    // parts without breaking readers that only verify what they understand.
    if (!name.startsWith(BLOB_PREFIX) || !name.endsWith('.bin')) {
      continue
    }
    assertWithin(bytes.length, LIMITS.blobBytes, name)
    total += bytes.length
    assertWithin(total, LIMITS.totalBytes, 'archive contents')
    blobs.set(name.slice(BLOB_PREFIX.length, -'.bin'.length), bytes)
    assertWithin(blobs.size, LIMITS.blobCount, 'blob count')
  }

  return { manifestBytes, payload, signature, blobs }
}
