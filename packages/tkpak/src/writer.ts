import { createHash } from 'node:crypto'
import {
  DEFAULT_ARGON2_PARAMS,
  agree,
  deriveKey,
  domainSeparated,
  generateAgreementKeyPair,
  publicKeyFromPrivate,
  randomKey,
  randomNonce,
  randomSalt,
  seal,
  sealedSlotKey,
  signBytes,
  toBase64Url,
  wrapKey,
  type Argon2Params,
} from '@passvault/crypto'
import { v7 as uuidv7 } from 'uuid'
import { MANIFEST_SIGNING_DOMAIN, blobAad, filekeyAad, payloadAad } from './aad.js'
import { packContainer } from './container.js'
import { TkpakError } from './errors.js'
import { LIMITS, assertWithin } from './limits.js'
import {
  TKPAK_FORMAT,
  TKPAK_VERSION,
  type TkpakBundle,
  type TkpakDocument,
  type TkpakKeySlot,
  type TkpakManifest,
  type TkpakPreview,
} from './types.js'

/**
 * How much of the event is written in the clear.
 *
 * `full` is the default because a recipient who cannot tell which of three forwarded
 * files is the right one is a real usability failure. `minimal` is for anyone who
 * would rather their messaging provider not learn which concerts they attend.
 */
export type PreviewMode = 'full' | 'minimal' | 'none'

export interface TkpakIssuerIdentity {
  deviceId: string
  /** Ed25519 private key. The public half is derived, so a device stores only this. */
  privateKey: Uint8Array
  displayName?: string
}

export interface TkpakWriteInput {
  issuer: TkpakIssuerIdentity
  bundle: Omit<TkpakBundle, 'fileId'>
  documents?: TkpakDocument[]
  /** Produces an `argon2id` slot. Required unless a recipient key is given. */
  password?: string
  argon2Params?: Argon2Params
  /** X25519 public key of the recipient. Produces an `x25519-sealed` slot. */
  recipientPublicKey?: Uint8Array
  preview?: PreviewMode
  fileId?: string
  createdAt?: string
}

export interface TkpakWriteResult {
  archive: Uint8Array
  manifest: TkpakManifest
  fileId: string
}

export async function writeTkpak(input: TkpakWriteInput): Promise<TkpakWriteResult> {
  if (!input.password && !input.recipientPublicKey) {
    throw new TkpakError(
      'NO_USABLE_KEY_SLOT',
      'a file needs a password, a recipient key, or both; writing one nobody can open is never intended',
    )
  }

  const fileId = input.fileId ?? uuidv7()
  const createdAt = input.createdAt ?? new Date().toISOString()
  const documents = input.documents ?? []
  assertWithin(documents.length, LIMITS.blobCount, 'documents')

  const fileKey = randomKey()
  const bundle: TkpakBundle = { ...input.bundle, fileId }

  const payloadNonce = randomNonce()
  const payloadCiphertext = seal({
    key: fileKey,
    nonce: payloadNonce,
    plaintext: new Uint8Array(Buffer.from(JSON.stringify(bundle), 'utf8')),
    aad: payloadAad(fileId),
  })
  assertWithin(payloadCiphertext.length, LIMITS.payloadBytes, 'payload')

  const blobs = new Map<string, Uint8Array>()
  const blobEntries: TkpakManifest['blobs'] = []
  for (const document of documents) {
    const nonce = randomNonce()
    const ciphertext = seal({
      key: fileKey,
      nonce,
      plaintext: document.bytes,
      aad: blobAad(fileId, document.id),
    })
    assertWithin(ciphertext.length, LIMITS.blobBytes, `blob ${document.id}`)
    blobs.set(document.id, ciphertext)
    blobEntries.push({
      id: document.id,
      mediaType: document.mediaType,
      nonce: toBase64Url(nonce),
      sha256: toBase64Url(sha256(ciphertext)),
      byteLength: ciphertext.length,
    })
  }

  const keySlots: TkpakKeySlot[] = []
  if (input.password !== undefined) {
    keySlots.push(
      await passwordSlot(
        fileId,
        fileKey,
        input.password,
        input.argon2Params ?? DEFAULT_ARGON2_PARAMS,
      ),
    )
  }
  if (input.recipientPublicKey) {
    keySlots.push(sealedSlot(fileId, fileKey, input.recipientPublicKey))
  }

  const manifest: TkpakManifest = {
    format: TKPAK_FORMAT,
    version: TKPAK_VERSION,
    fileId,
    createdAt,
    issuer: {
      deviceId: input.issuer.deviceId,
      publicKey: toBase64Url(publicKeyFromPrivate(input.issuer.privateKey)),
      ...(input.issuer.displayName ? { displayName: input.issuer.displayName } : {}),
    },
    keySlots,
    payload: {
      nonce: toBase64Url(payloadNonce),
      sha256: toBase64Url(sha256(payloadCiphertext)),
      byteLength: payloadCiphertext.length,
    },
    blobs: blobEntries,
    ...previewOf(bundle, input.preview ?? 'full'),
  }

  // The bytes written are the bytes signed. Serialise once and reuse, so no
  // reformatting can slip between signing and storing.
  const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  assertWithin(manifestBytes.length, LIMITS.manifestBytes, 'manifest')
  const signature = signBytes(
    input.issuer.privateKey,
    domainSeparated(MANIFEST_SIGNING_DOMAIN, sha256(manifestBytes)),
  )

  return {
    archive: packContainer({ manifestBytes, payload: payloadCiphertext, signature, blobs }),
    manifest,
    fileId,
  }
}

async function passwordSlot(
  fileId: string,
  fileKey: Uint8Array,
  password: string,
  params: Argon2Params,
): Promise<TkpakKeySlot> {
  const salt = randomSalt()
  const kek = await deriveKey(password, salt, params)
  const wrapped = wrapKey(kek, fileKey, filekeyAad(fileId))
  return {
    kind: 'argon2id',
    salt: toBase64Url(salt),
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    wrapNonce: toBase64Url(wrapped.nonce),
    wrappedFileKey: toBase64Url(wrapped.ciphertext),
  }
}

function sealedSlot(
  fileId: string,
  fileKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): TkpakKeySlot {
  // A fresh ephemeral pair per file, and the private half is never retained: the
  // sender cannot reopen the slot afterwards, only the recipient can.
  const ephemeral = generateAgreementKeyPair()
  const kek = sealedSlotKey(
    agree(ephemeral.privateKey, recipientPublicKey),
    ephemeral.publicKey,
    recipientPublicKey,
  )
  const wrapped = wrapKey(kek, fileKey, filekeyAad(fileId))
  return {
    kind: 'x25519-sealed',
    recipientPublicKey: toBase64Url(recipientPublicKey),
    ephemeralPublicKey: toBase64Url(ephemeral.publicKey),
    wrapNonce: toBase64Url(wrapped.nonce),
    wrappedFileKey: toBase64Url(wrapped.ciphertext),
  }
}

function previewOf(bundle: TkpakBundle, mode: PreviewMode): { preview?: TkpakPreview } {
  if (mode === 'none') {
    return {}
  }
  const preview: TkpakPreview = { ticketCount: bundle.tickets.length }
  if (mode === 'full') {
    preview.eventName = bundle.event.name
    if (bundle.event.startsAt) preview.eventStartsAt = bundle.event.startsAt
    if (bundle.event.venue) preview.venue = bundle.event.venue
  }
  return { preview }
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}
