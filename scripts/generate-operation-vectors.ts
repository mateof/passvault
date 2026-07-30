import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { publicKeyFromPrivate, signBytes, toBase64Url } from '@passvault/crypto'
import { canonicalBytes, signingInput, type SignedOperation } from '../apps/server/src/operations.js'

/**
 * Reference vectors for the signed operation log.
 *
 * The same idea as `spec/vectors` for `.tkpak`, and for the same reason: the operation format is
 * implemented twice, and a divergence in how the canonical form is built shows up as the other side
 * rejecting a perfectly honest signature. These vectors make that a failing test rather than two
 * users watching a transfer fail for no visible reason.
 *
 * The canonical form is where the divergence would be, so the vectors deliberately include the
 * cases that differ between serialisers: accented text a stricter encoder would escape, an
 * explicit null, keys given out of order, nesting, and an empty body.
 */

// Fixed, so the output is reproducible. Never a real key.
const SIGNING_PRIVATE_KEY = new Uint8Array(32).fill(7)

const DEVICE_ID = '0192f5c0-2222-7000-8000-ddddeeeeffff'
const EVENT_ID = '0192f5b1-4444-7000-8000-444455556666'

interface VectorSpec {
  name: string
  description: string
  operation: Omit<SignedOperation, 'signature'>
}

const specs: VectorSpec[] = [
  {
    name: 'minimal',
    description: 'The smallest operation: no actor, empty body.',
    operation: {
      operationId: '0192f5d0-1111-7000-8000-aaaabbbbcccc',
      deviceId: DEVICE_ID,
      actorUserId: null,
      lamport: 1,
      wallClock: '2026-07-30T10:15:00.000Z',
      scope: { kind: 'event', id: EVENT_ID },
      type: 'ticket.unassign',
      body: {},
    },
  },
  {
    name: 'keys-out-of-order',
    description:
      'Body keys given in an order that is not sorted, to pin that both sides sort before hashing.',
    operation: {
      operationId: '0192f5d0-2222-7000-8000-aaaabbbbcccc',
      deviceId: DEVICE_ID,
      actorUserId: '0192f5b0-3333-7000-8000-111122223333',
      lamport: 42,
      wallClock: '2026-07-30T10:15:00.000Z',
      scope: { kind: 'event', id: EVENT_ID },
      type: 'ticket.assign',
      body: { zeta: 1, alpha: 2, Mid: 3, mid: 4, '': 5 },
    },
  },
  {
    name: 'galician-text',
    description:
      'Accented and non-ASCII text left literal, which is where a stricter escaper would diverge.',
    operation: {
      operationId: '0192f5d0-3333-7000-8000-aaaabbbbcccc',
      deviceId: DEVICE_ID,
      actorUserId: null,
      lamport: 7,
      wallClock: '2026-07-30T10:15:00.000Z',
      scope: { kind: 'event', id: EVENT_ID },
      type: 'event.update',
      body: { name: 'Festival do Norte 2026 — Coruña', venue: 'Recinto Ferial · A Grela' },
    },
  },
  {
    name: 'escapes-and-nesting',
    description: 'Control characters, quotes and backslashes, plus a nested object and an array.',
    operation: {
      operationId: '0192f5d0-4444-7000-8000-aaaabbbbcccc',
      deviceId: DEVICE_ID,
      actorUserId: null,
      lamport: 99,
      wallClock: '2026-07-30T10:15:00.000Z',
      scope: { kind: 'event', id: EVENT_ID },
      type: 'ticket.add',
      body: {
        label: 'a "quoted" \\ backslash\nnewline\ttab',
        nested: { inner: [1, 'two', null, true, false] },
        empty: {},
        emptyList: [],
      },
    },
  },
  {
    name: 'claim-request',
    description: 'A claim request, the operation the whole authority mechanism exists for.',
    operation: {
      operationId: '0192f5d0-5555-7000-8000-aaaabbbbcccc',
      deviceId: DEVICE_ID,
      actorUserId: '0192f5b0-3333-7000-8000-111122223333',
      lamport: 12,
      wallClock: '2026-07-30T10:15:00.000Z',
      scope: { kind: 'event', id: EVENT_ID },
      type: 'claim.request',
      body: {
        ticketId: '0192f5b2-5555-7000-8000-777788889999',
        coupon: 'Q0FGRUJBQkVDQUZFQkFCRQ',
      },
    },
  },
]

const publicKey = publicKeyFromPrivate(SIGNING_PRIVATE_KEY)

const vectors = specs.map((spec) => {
  const canonical = canonicalBytes(spec.operation)
  const input = signingInput(spec.operation)
  return {
    name: spec.name,
    description: spec.description,
    operation: spec.operation,
    canonical: Buffer.from(canonical).toString('utf8'),
    canonicalSha256: toBase64Url(new Uint8Array(createHash('sha256').update(canonical).digest())),
    signingInputSha256: toBase64Url(
      new Uint8Array(createHash('sha256').update(input).digest()),
    ),
    signature: toBase64Url(signBytes(SIGNING_PRIVATE_KEY, input)),
  }
})

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'spec', 'vectors')
await mkdir(target, { recursive: true })
await writeFile(
  join(target, 'operations.json'),
  `${JSON.stringify(
    {
      format: 'passvault-operations',
      version: 1,
      domain: 'passvault/v1/operation',
      generatedBy: 'scripts/generate-operation-vectors.ts',
      note: 'Signing key is fixed and deliberately trivial so output is reproducible. Never reuse it.',
      signingPrivateKey: toBase64Url(SIGNING_PRIVATE_KEY),
      signingPublicKey: toBase64Url(publicKey),
      vectors,
    },
    null,
    2,
  )}\n`,
)

console.log(`wrote ${vectors.length} operation vectors`)
