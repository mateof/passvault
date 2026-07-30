/**
 * Generates the cross-implementation reference vectors in `spec/vectors`.
 *
 * These files are the only thing keeping the TypeScript and Kotlin readers from
 * drifting apart. Both run the same vectors: this repository in
 * `packages/tkpak/test/vectors.test.ts`, the Android app in its own suite. A change
 * to the format that is not reflected here will pass one side's tests and fail the
 * other's, which is the outcome we want — silent incompatibility is the failure mode
 * to avoid.
 *
 * Run with `npm run vectors:generate`. The output is committed. Regenerating produces
 * different ciphertext, since nonces and salts are random, which is expected: the
 * vectors assert what a reader must conclude, not any particular byte string.
 *
 * Usage: tsx packages/tkpak/scripts/generate-vectors.ts
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  TEST_ARGON2_PARAMS,
  domainSeparated,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  signBytes,
  toBase64Url,
} from '@passvault/crypto'
import { v7 as uuidv7 } from 'uuid'
import { packContainer, unpackContainer, writeTkpak } from '../src/index.js'
import type { TkpakBundle, TkpakDocument, TkpakManifest } from '../src/types.js'

const VECTOR_DIR = fileURLToPath(new URL('../../../spec/vectors/', import.meta.url))

const PASSWORD = 'sempre en Galiza'
const UNICODE_PASSWORD = 'entradas cómodas ñ'

interface ExpectedSuccess {
  outcome: 'success'
  fileId: string
  eventName?: string
  ticketCount: number
  barcodes: { format: string; value: string }[]
  documents: { id: string; mediaType: string; sha256: string }[]
  signatureValid: boolean
}

interface ExpectedError {
  outcome: 'error'
  code: string
}

interface VectorDescriptor {
  name: string
  description: string
  archive: string
  open:
    | { kind: 'password'; password: string }
    | { kind: 'recipient-key'; privateKey: string; publicKey: string }
  options?: { requireValidSignature?: boolean }
  expect: ExpectedSuccess | ExpectedError
}

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest())

function ticket(index: number, format: string, extra: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    label: `Grada A 14-${String.fromCharCode(65 + index)}`,
    barcode: { format, value: `8412-VECT-${String(index + 1).padStart(4, '0')}` },
    assignmentMode: 'ASSIGNED' as const,
    assignment: { state: 'ASSIGNED' as const, holderLabel: `Holder ${index + 1}` },
    ...extra,
  }
}

function bundleOf(ticketCount: number, extra: Record<string, unknown> = {}) {
  const formats = ['QR_CODE', 'AZTEC', 'PDF_417', 'CODE_128']
  return {
    exportedAt: '2026-07-30T10:15:00.000Z',
    event: {
      id: uuidv7(),
      name: 'Festival do Norte 2026',
      venue: 'Recinto Ferial, Vilagarcía',
      startsAt: '2026-08-14T19:00:00.000Z',
      timeZone: 'Europe/Madrid',
      defaultAssignmentMode: 'ASSIGNED' as const,
      passwordProtected: true,
    },
    tickets: Array.from({ length: ticketCount }, (_unused, index) =>
      ticket(index, formats[index % formats.length]!),
    ),
    operations: [],
    ...extra,
  } as Omit<TkpakBundle, 'fileId'>
}

function pdfDocument(page: number): TkpakDocument {
  const bytes = Buffer.concat([
    Buffer.from(`%PDF-1.7\n% reference vector page ${page}\n`, 'ascii'),
    Buffer.alloc(256, 0x20),
    Buffer.from('\n%%EOF\n', 'ascii'),
  ])
  return { id: uuidv7(), mediaType: 'application/pdf', bytes: new Uint8Array(bytes) }
}

function pkpassDocument(): TkpakDocument {
  // A ZIP-shaped placeholder. The pkpass vector exists to check that a reader carries
  // the media type through, not to exercise Apple's signature verification, which
  // belongs to the ingestion tests.
  const bytes = packContainer({
    manifestBytes: new Uint8Array(Buffer.from('{"pass":"placeholder"}', 'utf8')),
    payload: new Uint8Array(Buffer.alloc(16)),
    signature: new Uint8Array(Buffer.alloc(64)),
    blobs: new Map(),
  })
  return { id: uuidv7(), mediaType: 'application/vnd.apple.pkpass', bytes }
}

function expectSuccess(
  bundle: Omit<TkpakBundle, 'fileId'>,
  fileId: string,
  documents: TkpakDocument[],
  options: { eventName?: string } = {},
): ExpectedSuccess {
  return {
    outcome: 'success',
    fileId,
    ...(options.eventName === undefined ? {} : { eventName: options.eventName }),
    ticketCount: bundle.tickets.length,
    barcodes: bundle.tickets.flatMap((entry) =>
      entry.barcode ? [{ format: entry.barcode.format, value: entry.barcode.value }] : [],
    ),
    documents: documents.map((document) => ({
      id: document.id,
      mediaType: document.mediaType,
      sha256: toBase64Url(sha256(document.bytes)),
    })),
    signatureValid: true,
  }
}

const descriptors: VectorDescriptor[] = []
const files = new Map<string, Uint8Array>()

function record(descriptor: VectorDescriptor, archive: Uint8Array): void {
  descriptors.push(descriptor)
  files.set(descriptor.archive, archive)
}

async function main(): Promise<void> {
  const issuer = { deviceId: uuidv7(), ...generateSigningKeyPair() }
  const identity = { deviceId: issuer.deviceId, privateKey: issuer.privateKey, displayName: 'Mateo' }

  // 01 — the minimal file: one ticket, one password slot, no documents.
  {
    const bundle = bundleOf(1)
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    record(
      {
        name: '01-single-ticket-password',
        description: 'One ticket, one argon2id key slot, no documents.',
        archive: '01-single-ticket-password.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: expectSuccess(bundle, fileId, [], { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
  }

  // 02 — the common real case: several tickets, one PDF page each.
  {
    const documents = [pdfDocument(1), pdfDocument(2), pdfDocument(3)]
    const bundle = bundleOf(4)
    documents.forEach((document, index) => {
      bundle.tickets[index]!.documentBlobId = document.id
      bundle.tickets[index]!.documentPage = index + 1
    })
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      documents,
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    record(
      {
        name: '02-multi-ticket-pdf-blobs',
        description: 'Four tickets and three PDF page documents.',
        archive: '02-multi-ticket-pdf-blobs.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: expectSuccess(bundle, fileId, documents, { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
  }

  // 03 — sealed to a recipient key, no password involved.
  {
    const recipient = generateAgreementKeyPair()
    const bundle = bundleOf(2)
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      recipientPublicKey: recipient.publicKey,
    })
    record(
      {
        name: '03-sealed-to-recipient',
        description: 'Only an x25519-sealed slot. Opens with the recipient key alone.',
        archive: '03-sealed-to-recipient.tkpak',
        open: {
          kind: 'recipient-key',
          privateKey: toBase64Url(recipient.privateKey),
          publicKey: toBase64Url(recipient.publicKey),
        },
        expect: expectSuccess(bundle, fileId, [], { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
  }

  // 04 — both slots over one file key, so the ciphertext is stored once.
  {
    const recipient = generateAgreementKeyPair()
    const bundle = bundleOf(2)
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
      recipientPublicKey: recipient.publicKey,
    })
    record(
      {
        name: '04-dual-slot-password',
        description: 'Password and sealed slot wrapping the same file key; opened by password.',
        archive: '04-dual-slot.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: expectSuccess(bundle, fileId, [], { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
    descriptors.push({
      name: '04-dual-slot-recipient',
      description: 'The same file as 04-dual-slot-password, opened by the recipient key instead.',
      archive: '04-dual-slot.tkpak',
      open: {
        kind: 'recipient-key',
        privateKey: toBase64Url(recipient.privateKey),
        publicKey: toBase64Url(recipient.publicKey),
      },
      expect: expectSuccess(bundle, fileId, [], { eventName: 'Festival do Norte 2026' }),
    })
  }

  // 05 — an Apple Wallet pass carried as a document.
  {
    const document = pkpassDocument()
    const bundle = bundleOf(1)
    bundle.tickets[0]!.documentBlobId = document.id
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      documents: [document],
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    record(
      {
        name: '05-pkpass-blob',
        description: 'An Apple Wallet pass as a document blob.',
        archive: '05-pkpass-blob.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: expectSuccess(bundle, fileId, [document], { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
  }

  // 06 — a flipped payload byte. Caught by the manifest digest, before any key work.
  {
    const { archive } = await writeTkpak({
      issuer: identity,
      bundle: bundleOf(1),
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    const parts = unpackContainer(archive)
    const payload = Uint8Array.from(parts.payload)
    payload[0] ^= 0x01
    record(
      {
        name: '06-tampered-payload',
        description: 'One payload byte flipped; the digest in the signed manifest catches it.',
        archive: '06-tampered-payload.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: { outcome: 'error', code: 'DIGEST_MISMATCH' },
      },
      packContainer({ ...parts, payload }),
    )
  }

  // 07 — the cleartext preview edited after signing.
  {
    const { archive } = await writeTkpak({
      issuer: identity,
      bundle: bundleOf(1),
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    const parts = unpackContainer(archive)
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.preview = { ticketCount: 99, eventName: 'Somebody else’s event' }
    record(
      {
        name: '07-tampered-manifest',
        description: 'Preview edited after signing; the signature no longer verifies.',
        archive: '07-tampered-manifest.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: { outcome: 'error', code: 'BAD_SIGNATURE' },
      },
      packContainer({
        ...parts,
        manifestBytes: new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')),
      }),
    )
  }

  // 08 — a file from a future release.
  {
    const { archive } = await writeTkpak({
      issuer: identity,
      bundle: bundleOf(1),
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    const parts = unpackContainer(archive)
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.version = 2
    const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    record(
      {
        name: '08-future-version',
        description:
          'Version 2, correctly signed. A version 1 reader must say so before anything else.',
        archive: '08-future-version.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: { outcome: 'error', code: 'UNSUPPORTED_VERSION' },
      },
      packContainer({
        ...parts,
        manifestBytes,
        signature: signBytes(
          issuer.privateKey,
          domainSeparated('tkpak/v1/manifest', sha256(manifestBytes)),
        ),
      }),
    )
  }

  // 09 — a password with combining accents, written decomposed.
  {
    const bundle = bundleOf(1)
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      password: UNICODE_PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    record(
      {
        name: '09-unicode-password',
        description:
          'Sealed with an NFC password and opened with its NFD form. Both must normalise alike.',
        archive: '09-unicode-password.tkpak',
        open: { kind: 'password', password: UNICODE_PASSWORD.normalize('NFD') },
        expect: expectSuccess(bundle, fileId, [], { eventName: 'Festival do Norte 2026' }),
      },
      archive,
    )
  }

  // 10 — minimal preview, for a sender who does not want the event named in the clear.
  {
    const bundle = bundleOf(3)
    const { archive, fileId } = await writeTkpak({
      issuer: identity,
      bundle,
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
      preview: 'minimal',
    })
    record(
      {
        name: '10-minimal-preview',
        description: 'Preview holds the ticket count and nothing else.',
        archive: '10-minimal-preview.tkpak',
        open: { kind: 'password', password: PASSWORD },
        expect: expectSuccess(bundle, fileId, []),
      },
      archive,
    )
  }

  // 11 — payload modified, digest updated, re-signed by the real issuer key. Everything
  // a reader checks before decrypting agrees, so only the GCM tag is left.
  {
    const { archive } = await writeTkpak({
      issuer: identity,
      bundle: bundleOf(1),
      password: PASSWORD,
      argon2Params: TEST_ARGON2_PARAMS,
    })
    const parts = unpackContainer(archive)
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    const payload = Uint8Array.from(parts.payload)
    payload[0] ^= 0x01
    manifest.payload.sha256 = toBase64Url(sha256(payload))
    const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    record(
      {
        name: '11-resigned-tampered-payload',
        description:
          'Payload altered, digest updated and re-signed. Reaches decryption, where the tag fails.',
        archive: '11-resigned-tampered-payload.tkpak',
        open: { kind: 'password', password: PASSWORD },
        options: { requireValidSignature: false },
        expect: { outcome: 'error', code: 'DECRYPTION_FAILED' },
      },
      packContainer({
        ...parts,
        payload,
        manifestBytes,
        signature: signBytes(
          issuer.privateKey,
          domainSeparated('tkpak/v1/manifest', sha256(manifestBytes)),
        ),
      }),
    )
  }

  await mkdir(VECTOR_DIR, { recursive: true })
  for (const [name, bytes] of files) {
    await writeFile(new URL(name, `file://${VECTOR_DIR.replace(/\\/g, '/')}`), bytes)
  }
  await writeFile(
    `${VECTOR_DIR}index.json`,
    `${JSON.stringify(
      {
        format: 'tkpak',
        version: 1,
        generatedBy: 'packages/tkpak/scripts/generate-vectors.ts',
        issuerPublicKey: toBase64Url(issuer.publicKey),
        note: 'Argon2 parameters are deliberately weak so tests stay fast. Never reuse these keys or passwords.',
        vectors: descriptors,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`Wrote ${files.size} archives and ${descriptors.length} vectors to spec/vectors/`)
}

await main()
