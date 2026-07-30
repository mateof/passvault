import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  domainSeparated,
  generateSigningKeyPair,
  publicKeyFromPrivate,
  randomNonce,
  seal,
  signBytes,
  toBase64Url,
} from '@passvault/crypto'
import {
  openWithPassword,
  packContainer,
  unpackContainer,
  writeTkpak,
  type TkpakManifest,
} from '@passvault/tkpak'
import { ARGON2, EVENT_PASSWORD, aBundle, anIssuer } from './fixtures.js'

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest())

async function aSignedFile() {
  const issuer = anIssuer()
  const { archive } = await writeTkpak({
    issuer,
    bundle: aBundle(),
    password: EVENT_PASSWORD,
    argon2Params: ARGON2,
  })
  return { issuer, archive, parts: unpackContainer(archive) }
}

/**
 * Rebuilds an archive around a modified manifest and signs it with `privateKey`.
 *
 * This is what an attacker can do: change the file and sign it with a key of their
 * own. What they cannot do is sign it with the original issuer's key, which is the
 * whole point of the signature.
 */
function repackAndSign(
  manifest: TkpakManifest,
  privateKey: Uint8Array,
  parts: ReturnType<typeof unpackContainer>,
): Uint8Array {
  const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  return packContainer({
    manifestBytes,
    payload: parts.payload,
    blobs: parts.blobs,
    signature: signBytes(privateKey, domainSeparated('tkpak/v1/manifest', sha256(manifestBytes))),
  })
}

describe('a file altered after it was sealed', () => {
  it('is rejected when a byte of the payload is flipped', async () => {
    const { archive, parts } = await aSignedFile()
    const payload = Uint8Array.from(parts.payload)
    payload[0] ^= 0x01

    const tampered = packContainer({ ...parts, payload })

    // Caught by the digest in the manifest, before any key is derived: the attacker
    // cannot update the digest without also re-signing.
    await expect(openWithPassword(tampered, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'DIGEST_MISMATCH' }),
    )
  })

  it('is rejected when the cleartext preview is edited', async () => {
    const { archive, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.preview = { ticketCount: 40, eventName: 'A different event' }

    const tampered = packContainer({
      ...parts,
      manifestBytes: new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')),
    })

    await expect(openWithPassword(tampered, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'BAD_SIGNATURE' }),
    )
  })

  it('is rejected when re-signed by a different key', async () => {
    const { parts } = await aSignedFile()
    const impostor = generateSigningKeyPair()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.preview = { ticketCount: 1 }

    // The impostor signs with their own key but leaves the issuer key in place,
    // because changing it would be visible to anyone who knows the sender.
    const tampered = repackAndSign(manifest, impostor.privateKey, parts)

    await expect(openWithPassword(tampered, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'BAD_SIGNATURE' }),
    )
  })

  it('is accepted only if the impostor also replaces the issuer key, which no recipient should trust', async () => {
    const { issuer, parts } = await aSignedFile()
    const impostor = generateSigningKeyPair()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.issuer.publicKey = toBase64Url(impostor.publicKey)

    const forged = repackAndSign(manifest, impostor.privateKey, parts)
    const opened = await openWithPassword(forged, EVENT_PASSWORD)

    // The signature is now internally consistent, so the format itself cannot object.
    // What changed is the key it points at, and recognising that key is what the
    // recipient's app does — hence the unverified sender warning.
    expect(opened.issuerPublicKey).not.toEqual(publicKeyFromPrivate(issuer.privateKey))
  })

  it('carries the impostor key rather than the original one, which is what a recipient can detect', async () => {
    const { parts } = await aSignedFile()
    const impostor = generateSigningKeyPair()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.issuer.publicKey = toBase64Url(impostor.publicKey)

    const forged = repackAndSign(manifest, impostor.privateKey, parts)
    const opened = await openWithPassword(forged, EVENT_PASSWORD)

    expect(opened.issuerPublicKey).toEqual(impostor.publicKey)
  })

  it('falls back to the authentication tag when signature checking is waived', async () => {
    const { issuer, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    const payload = Uint8Array.from(parts.payload)
    payload[0] ^= 0x01
    manifest.payload.sha256 = toBase64Url(sha256(payload))

    // Digest updated and re-signed by the real issuer key: everything the reader checks
    // before decrypting now agrees. The GCM tag is the last line of defence.
    const tampered = repackAndSign(manifest, issuer.privateKey, { ...parts, payload })

    await expect(
      openWithPassword(tampered, EVENT_PASSWORD, { requireValidSignature: false }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'DECRYPTION_FAILED' }))
  })

  it('is rejected when the payload was replaced with one naming a different file', async () => {
    const { issuer, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    // Encrypting under the right file key is not something an attacker can do; this
    // case exists to prove the explicit check turns a confusing tag failure into a
    // clear diagnosis when an implementation gets its own writer wrong.
    const nonce = randomNonce()
    const bogus = seal({
      key: new Uint8Array(32),
      nonce,
      plaintext: new Uint8Array(Buffer.from(JSON.stringify({ fileId: 'somebody-else' }), 'utf8')),
      aad: `tkpak/v1/payload:${manifest.fileId}`,
    })
    manifest.payload = {
      nonce: toBase64Url(nonce),
      sha256: toBase64Url(sha256(bogus)),
      byteLength: bogus.length,
    }
    manifest.keySlots = []

    const rebuilt = repackAndSign(manifest, issuer.privateKey, { ...parts, payload: bogus })

    await expect(openWithPassword(rebuilt, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'MALFORMED_MANIFEST' }),
    )
  })
})

describe('a file this reader cannot handle', () => {
  it('reports an unsupported version before anything else, so a newer file gets a useful message', async () => {
    const { issuer, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.version = 2

    const future = repackAndSign(manifest, issuer.privateKey, parts)

    await expect(openWithPassword(future, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    )
  })

  it('rejects Argon2 parameters that would exhaust a phone', async () => {
    const { issuer, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    const slot = manifest.keySlots[0]!
    if (slot.kind !== 'argon2id') throw new Error('fixture should produce a password slot')
    slot.memoryKiB = 8_388_608

    const hostile = repackAndSign(manifest, issuer.privateKey, parts)

    await expect(openWithPassword(hostile, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    )
  })

  it('rejects something that is not a ZIP at all', async () => {
    const notAnArchive = new Uint8Array(Buffer.from('this is a text file', 'utf8'))

    await expect(openWithPassword(notAnArchive, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_A_TKPAK' }),
    )
  })

  it('rejects a ZIP with no manifest', async () => {
    const { parts } = await aSignedFile()
    const withoutManifest = packContainer({ ...parts, manifestBytes: new Uint8Array() })

    // fflate stores a zero-length entry, which parses as an empty manifest rather than
    // a missing one; either way the file is not a tkpak.
    await expect(openWithPassword(withoutManifest, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'MALFORMED_MANIFEST' }),
    )
  })

  it('rejects a manifest that is not JSON', async () => {
    const { parts } = await aSignedFile()
    const garbled = packContainer({
      ...parts,
      manifestBytes: new Uint8Array(Buffer.from('{ not json', 'utf8')),
    })

    await expect(openWithPassword(garbled, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'MALFORMED_MANIFEST' }),
    )
  })

  it('rejects a manifest listing a blob the archive does not contain', async () => {
    const { issuer, parts } = await aSignedFile()
    const manifest = JSON.parse(Buffer.from(parts.manifestBytes).toString('utf8')) as TkpakManifest
    manifest.blobs = [
      {
        id: 'missing-blob',
        mediaType: 'application/pdf',
        nonce: toBase64Url(randomNonce()),
        sha256: toBase64Url(sha256(new Uint8Array())),
        byteLength: 0,
      },
    ]

    const incomplete = repackAndSign(manifest, issuer.privateKey, parts)

    await expect(openWithPassword(incomplete, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'MALFORMED_MANIFEST' }),
    )
  })
})
