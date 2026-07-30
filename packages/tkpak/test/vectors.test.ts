import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fromBase64Url } from '@passvault/crypto'
import { openWithPassword, openWithRecipientKey, type OpenedTkpak } from '@passvault/tkpak'

/**
 * The cross-implementation contract.
 *
 * These vectors are committed files that the Android app reads with its own Kotlin
 * implementation. If this suite and the Android one both pass, the two readers agree;
 * if one drifts, its tests fail rather than a user discovering that a file exported
 * from the phone cannot be opened on the server.
 *
 * Regenerate with `npm run vectors:generate` after an intentional format change, and
 * expect the Android suite to need the new files too.
 */
const VECTOR_DIR = fileURLToPath(new URL('../../../spec/vectors/', import.meta.url))

interface VectorIndex {
  version: number
  issuerPublicKey: string
  vectors: Vector[]
}

interface Vector {
  name: string
  description: string
  archive: string
  open:
    | { kind: 'password'; password: string }
    | { kind: 'recipient-key'; privateKey: string; publicKey: string }
  options?: { requireValidSignature?: boolean }
  expect:
    | {
        outcome: 'success'
        fileId: string
        eventName?: string
        ticketCount: number
        barcodes: { format: string; value: string }[]
        documents: { id: string; mediaType: string; sha256: string }[]
        signatureValid: boolean
      }
    | { outcome: 'error'; code: string }
}

const index = JSON.parse(await readFile(`${VECTOR_DIR}index.json`, 'utf8')) as VectorIndex

async function openVector(vector: Vector): Promise<OpenedTkpak> {
  const archive = new Uint8Array(await readFile(`${VECTOR_DIR}${vector.archive}`))
  const options = vector.options ?? {}
  if (vector.open.kind === 'password') {
    return openWithPassword(archive, vector.open.password, options)
  }
  return openWithRecipientKey(
    archive,
    fromBase64Url(vector.open.privateKey),
    fromBase64Url(vector.open.publicKey),
    options,
  )
}

describe('the reference vector set', () => {
  it('is present and non-empty, so a missing checkout does not pass silently', () => {
    expect(index.vectors.length).toBeGreaterThan(0)
  })

  it('is version 1', () => {
    expect(index.version).toBe(1)
  })
})

const successes = index.vectors.filter((vector) => vector.expect.outcome === 'success')
const failures = index.vectors.filter((vector) => vector.expect.outcome === 'error')

describe.each(successes)('vector $name', (vector) => {
  it(`opens: ${vector.description}`, async () => {
    await expect(openVector(vector)).resolves.toBeDefined()
  })

  it('reports the expected file id', async () => {
    const opened = await openVector(vector)

    expect(opened.bundle.fileId).toBe(
      vector.expect.outcome === 'success' ? vector.expect.fileId : undefined,
    )
  })

  it('reports the expected ticket count', async () => {
    const opened = await openVector(vector)

    expect(opened.bundle.tickets.length).toBe(
      vector.expect.outcome === 'success' ? vector.expect.ticketCount : -1,
    )
  })

  it('decodes every barcode exactly as it was written', async () => {
    if (vector.expect.outcome !== 'success') return
    const opened = await openVector(vector)

    expect(
      opened.bundle.tickets.flatMap((ticket) =>
        ticket.barcode ? [{ format: ticket.barcode.format, value: ticket.barcode.value }] : [],
      ),
    ).toEqual(vector.expect.barcodes)
  })

  it('returns every document byte for byte', async () => {
    if (vector.expect.outcome !== 'success') return
    const opened = await openVector(vector)

    const { createHash } = await import('node:crypto')
    const actual = [...opened.documents.values()].map((document) => ({
      id: document.id,
      mediaType: document.mediaType,
      sha256: createHash('sha256').update(document.bytes).digest('base64url'),
    }))
    expect(actual).toEqual(vector.expect.documents)
  })

  it('agrees on whether the signature is valid', async () => {
    if (vector.expect.outcome !== 'success') return
    const opened = await openVector(vector)

    expect(opened.signatureValid).toBe(vector.expect.signatureValid)
  })

  it('names the event in the preview when the vector says it should', async () => {
    if (vector.expect.outcome !== 'success') return
    const opened = await openVector(vector)

    expect(opened.manifest.preview?.eventName).toBe(vector.expect.eventName)
  })
})

describe.each(failures)('vector $name', (vector) => {
  it(`is rejected: ${vector.description}`, async () => {
    await expect(openVector(vector)).rejects.toThrowError(
      expect.objectContaining({
        code: vector.expect.outcome === 'error' ? vector.expect.code : 'unreachable',
      }),
    )
  })
})
