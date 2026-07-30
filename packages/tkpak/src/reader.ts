import { createHash, timingSafeEqual } from 'node:crypto'
import {
  CryptoError,
  agree,
  assertUsableParams,
  deriveKey,
  domainSeparated,
  fromBase64Url,
  open,
  sealedSlotKey,
  toBase64Url,
  unwrapKey,
  verifyBytes,
  type Argon2Params,
} from '@passvault/crypto'
import { MANIFEST_SIGNING_DOMAIN, blobAad, filekeyAad, payloadAad } from './aad.js'
import { unpackContainer, type ContainerParts } from './container.js'
import { TkpakError, malformed } from './errors.js'
import { parseManifest } from './parse-manifest.js'
import type {
  Argon2KeySlot,
  SealedKeySlot,
  TkpakBundle,
  TkpakDocument,
  TkpakManifest,
} from './types.js'

export interface TkpakInspection {
  manifest: TkpakManifest
  /** False when `signature.bin` does not verify. The caller decides whether to proceed. */
  signatureValid: boolean
  /** Ed25519 key that produced the signature. Trust in it comes from outside the file. */
  issuerPublicKey: Uint8Array
  canOpenWithPassword: boolean
  /** Recipient X25519 keys, base64url, for a reader to match against its own. */
  sealedFor: string[]
}

export interface OpenedTkpak {
  manifest: TkpakManifest
  bundle: TkpakBundle
  documents: Map<string, TkpakDocument>
  issuerPublicKey: Uint8Array
  signatureValid: boolean
}

/**
 * Reads what a file claims without needing any key, so the interface can say "four
 * tickets for Festival do Norte, needs a password" before asking for one.
 *
 * Everything returned other than `signatureValid` comes from cleartext and is
 * therefore unverified until the signature checks out.
 */
export function inspectTkpak(archive: Uint8Array): TkpakInspection {
  const parts = unpackContainer(archive)
  const manifest = parseManifest(parts.manifestBytes)
  const issuerPublicKey = fromBase64Url(manifest.issuer.publicKey)
  return {
    manifest,
    signatureValid: verifyManifestSignature(parts, issuerPublicKey),
    issuerPublicKey,
    canOpenWithPassword: manifest.keySlots.some((slot) => slot.kind === 'argon2id'),
    sealedFor: manifest.keySlots
      .filter((slot): slot is SealedKeySlot => slot.kind === 'x25519-sealed')
      .map((slot) => slot.recipientPublicKey),
  }
}

export interface OpenOptions {
  /**
   * Reject a file whose signature does not verify. On by default: a file that fails
   * this test was modified after being sealed, and importing it anyway is not a
   * decision to make silently.
   */
  requireValidSignature?: boolean
}

export async function openWithPassword(
  archive: Uint8Array,
  password: string,
  options: OpenOptions = {},
): Promise<OpenedTkpak> {
  const verified = verify(archive, options)
  const slots = verified.manifest.keySlots.filter(
    (slot): slot is Argon2KeySlot => slot.kind === 'argon2id',
  )
  if (slots.length === 0) {
    throw new TkpakError('NO_USABLE_KEY_SLOT', 'file has no password slot')
  }

  for (const slot of slots) {
    const params: Argon2Params = {
      memoryKiB: slot.memoryKiB,
      iterations: slot.iterations,
      parallelism: slot.parallelism,
    }
    // Enforced before deriving, not after: the point is to refuse to allocate the
    // memory a hostile file asked for.
    assertUsableParams(params)
    const kek = await deriveKey(password, fromBase64Url(slot.salt), params)
    const fileKey = tryUnwrap(kek, slot, verified.manifest.fileId)
    if (fileKey) {
      return decryptParts(verified, fileKey)
    }
  }
  throw new TkpakError('WRONG_PASSWORD', 'no password slot opened with the given password')
}

export function openWithRecipientKey(
  archive: Uint8Array,
  recipientPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  options: OpenOptions = {},
): OpenedTkpak {
  const verified = verify(archive, options)
  const encodedPublicKey = toBase64Url(recipientPublicKey)
  const slot = verified.manifest.keySlots.find(
    (candidate): candidate is SealedKeySlot =>
      candidate.kind === 'x25519-sealed' && candidate.recipientPublicKey === encodedPublicKey,
  )
  if (!slot) {
    throw new TkpakError('NO_USABLE_KEY_SLOT', 'file is not sealed to this recipient key')
  }

  const ephemeralPublicKey = fromBase64Url(slot.ephemeralPublicKey)
  const kek = sealedSlotKey(
    agree(recipientPrivateKey, ephemeralPublicKey),
    ephemeralPublicKey,
    recipientPublicKey,
  )
  const fileKey = tryUnwrap(kek, slot, verified.manifest.fileId)
  if (!fileKey) {
    // The slot named this key, so failing to unwrap it is not a wrong-key case: the
    // slot was altered.
    throw new TkpakError('DECRYPTION_FAILED', 'the key slot addressed to this key did not unwrap')
  }
  return decryptParts(verified, fileKey)
}

interface VerifiedContainer {
  parts: ContainerParts
  manifest: TkpakManifest
  issuerPublicKey: Uint8Array
  signatureValid: boolean
}

function verify(archive: Uint8Array, options: OpenOptions): VerifiedContainer {
  const parts = unpackContainer(archive)
  const manifest = parseManifest(parts.manifestBytes)
  const issuerPublicKey = fromBase64Url(manifest.issuer.publicKey)
  const signatureValid = verifyManifestSignature(parts, issuerPublicKey)
  if (!signatureValid && options.requireValidSignature !== false) {
    throw new TkpakError('BAD_SIGNATURE', 'signature.bin does not verify against the issuer key')
  }

  assertDigest(parts.payload, manifest.payload.sha256, manifest.payload.byteLength, 'payload.bin')
  for (const blob of manifest.blobs) {
    const bytes = parts.blobs.get(blob.id)
    if (!bytes) {
      throw malformed(`manifest lists blob ${blob.id} but the archive does not contain it`)
    }
    assertDigest(bytes, blob.sha256, blob.byteLength, `blobs/${blob.id}.bin`)
  }

  return { parts, manifest, issuerPublicKey, signatureValid }
}

function verifyManifestSignature(parts: ContainerParts, issuerPublicKey: Uint8Array): boolean {
  return verifyBytes(
    issuerPublicKey,
    domainSeparated(MANIFEST_SIGNING_DOMAIN, sha256(parts.manifestBytes)),
    parts.signature,
  )
}

function assertDigest(
  bytes: Uint8Array,
  expectedSha256: string,
  expectedLength: number,
  what: string,
): void {
  if (bytes.length !== expectedLength) {
    throw new TkpakError(
      'DIGEST_MISMATCH',
      `${what} is ${bytes.length} bytes, manifest says ${expectedLength}`,
    )
  }
  const actual = Buffer.from(sha256(bytes))
  const expected = Buffer.from(fromBase64Url(expectedSha256))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TkpakError('DIGEST_MISMATCH', `${what} does not match the digest in the manifest`)
  }
}

function tryUnwrap(
  kek: Uint8Array,
  slot: Argon2KeySlot | SealedKeySlot,
  fileId: string,
): Uint8Array | undefined {
  try {
    return unwrapKey(
      kek,
      { nonce: fromBase64Url(slot.wrapNonce), ciphertext: fromBase64Url(slot.wrappedFileKey) },
      filekeyAad(fileId),
      'WRONG_PASSWORD',
    )
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'WRONG_PASSWORD') {
      return undefined
    }
    throw error
  }
}

function decryptParts(verified: VerifiedContainer, fileKey: Uint8Array): OpenedTkpak {
  const { manifest, parts } = verified
  // Past this point the key is known to be right, so a tag failure means the file was
  // modified rather than that the password was wrong. The distinction is what lets the
  // interface say "this file has been altered" instead of "try again".
  const payloadBytes = open({
    key: fileKey,
    nonce: fromBase64Url(manifest.payload.nonce),
    ciphertext: parts.payload,
    aad: payloadAad(manifest.fileId),
  })

  let bundle: TkpakBundle
  try {
    bundle = JSON.parse(Buffer.from(payloadBytes).toString('utf8')) as TkpakBundle
  } catch {
    throw malformed('decrypted payload is not valid JSON')
  }
  if (bundle.fileId !== manifest.fileId) {
    throw new TkpakError(
      'FILE_ID_MISMATCH',
      `payload names file ${bundle.fileId}, manifest names ${manifest.fileId}`,
    )
  }

  const documents = new Map<string, TkpakDocument>()
  for (const blob of manifest.blobs) {
    const ciphertext = parts.blobs.get(blob.id)
    if (!ciphertext) {
      throw malformed(`blob ${blob.id} disappeared between verification and decryption`)
    }
    documents.set(blob.id, {
      id: blob.id,
      mediaType: blob.mediaType,
      bytes: open({
        key: fileKey,
        nonce: fromBase64Url(blob.nonce),
        ciphertext,
        aad: blobAad(manifest.fileId, blob.id),
      }),
    })
  }

  return {
    manifest,
    bundle,
    documents,
    issuerPublicKey: verified.issuerPublicKey,
    signatureValid: verified.signatureValid,
  }
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}
