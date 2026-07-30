import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { NONCE_BYTES, randomNonce, seal, open, toBase64Url } from '@passvault/crypto'
import { newId, toInstant } from '@passvault/db'
import type { DocumentMediaType } from '@passvault/tkpak'
import { badRequest, notFound } from './errors.js'
import type { EventDeps } from './events.js'

/**
 * Ticket documents on disk, encrypted, outside the database.
 *
 * A thirty-megabyte PDF in a row makes every backup slower, every `SELECT *` dangerous and
 * several engines unhappy. So the row holds metadata and a path, and the bytes live in a file
 * that is ciphertext before it is written — the filesystem never sees a readable ticket.
 */
const MEDIA_TYPES: Record<DocumentMediaType, 'PDF' | 'PNG' | 'JPEG' | 'PKPASS'> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'application/vnd.apple.pkpass': 'PKPASS',
}

const FROM_STORED: Record<string, DocumentMediaType> = {
  PDF: 'application/pdf',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  PKPASS: 'application/vnd.apple.pkpass',
}

const blobAad = (blobId: string): string => `passvault/v1/blob:${blobId}`

export interface StoredBlob {
  id: string
  mediaType: DocumentMediaType
  byteLength: number
}

export async function storeBlob(
  deps: EventDeps & { blobDir: string },
  input: {
    eventId: string
    eventKey: Uint8Array
    mediaType: DocumentMediaType
    bytes: Uint8Array
  },
): Promise<StoredBlob> {
  const id = newId()
  const nonce = randomNonce()
  const ciphertext = seal({
    key: input.eventKey,
    nonce,
    plaintext: input.bytes,
    aad: blobAad(id),
  })

  // Sharded by the first two characters of the id, so a busy event does not end up with tens of
  // thousands of files in one directory — which several filesystems handle badly.
  const relative = join(id.slice(0, 2), `${id}.bin`)
  const absolute = resolve(deps.blobDir, relative)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, ciphertext)

  await deps.db.db
    .insertInto('blobs')
    .values({
      id,
      event_id: input.eventId,
      media_type: MEDIA_TYPES[input.mediaType],
      byte_length: ciphertext.length,
      // Of the ciphertext, so integrity is checkable without the key.
      sha256: toBase64Url(new Uint8Array(createHash('sha256').update(ciphertext).digest())),
      nonce: toBase64Url(nonce),
      storage_path: relative.replace(/\\/g, '/'),
      created_at: toInstant(),
    })
    .execute()

  return { id, mediaType: input.mediaType, byteLength: input.bytes.length }
}

export async function readBlob(
  deps: EventDeps & { blobDir: string },
  input: { blobId: string; eventKey: Uint8Array },
): Promise<{ mediaType: DocumentMediaType; bytes: Uint8Array }> {
  const row = await deps.db.db
    .selectFrom('blobs')
    .selectAll()
    .where('id', '=', input.blobId)
    .executeTakeFirst()
  if (!row) {
    throw notFound()
  }

  const stored = new Uint8Array(await readFile(resolve(deps.blobDir, row.storage_path)))
  const digest = toBase64Url(new Uint8Array(createHash('sha256').update(stored).digest()))
  if (digest !== row.sha256) {
    // The file changed underneath us. Reported rather than decrypted, so a corrupted or swapped
    // file does not surface as a confusing authentication failure.
    throw badRequest('ingest.error.damagedFile')
  }

  const mediaType = FROM_STORED[row.media_type]
  if (!mediaType) {
    throw badRequest('ingest.error.unsupportedFile')
  }

  return {
    mediaType,
    bytes: open({
      key: input.eventKey,
      // The nonce is a column rather than a prefix on the file, so the ciphertext on disk is
      // exactly what the digest covers.
      nonce: decodeNonce(row.nonce),
      ciphertext: stored,
      aad: blobAad(row.id),
    }),
  }
}

function decodeNonce(encoded: string): Uint8Array {
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.length !== NONCE_BYTES) {
    throw badRequest('ingest.error.damagedFile')
  }
  return new Uint8Array(bytes)
}
