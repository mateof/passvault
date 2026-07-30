import { describe, expect, it } from 'vitest'
import {
  ED25519_PUBLIC_BYTES,
  ED25519_SIGNATURE_BYTES,
  domainSeparated,
  generateSigningKeyPair,
  publicKeyFromPrivate,
  signBytes,
  verifyBytes,
} from '@passvault/crypto'
import { createHash } from 'node:crypto'

const message = new Uint8Array(Buffer.from('tkpak manifest digest', 'utf8'))

describe('Ed25519 signing', () => {
  it('generates public keys in the 32-byte form the interchange format stores', () => {
    expect(generateSigningKeyPair().publicKey.length).toBe(ED25519_PUBLIC_BYTES)
  })

  it('produces a 64-byte raw signature', () => {
    const { privateKey } = generateSigningKeyPair()

    expect(signBytes(privateKey, message).length).toBe(ED25519_SIGNATURE_BYTES)
  })

  it('verifies a signature against the matching public key', () => {
    const { publicKey, privateKey } = generateSigningKeyPair()

    expect(verifyBytes(publicKey, message, signBytes(privateKey, message))).toBe(true)
  })

  it('rejects a signature made by a different key', () => {
    const issuer = generateSigningKeyPair()
    const impostor = generateSigningKeyPair()

    expect(verifyBytes(issuer.publicKey, message, signBytes(impostor.privateKey, message))).toBe(
      false,
    )
  })

  it('rejects a signature over different content', () => {
    const { publicKey, privateKey } = generateSigningKeyPair()
    const signature = signBytes(privateKey, message)

    const altered = new Uint8Array(Buffer.from('tkpak manifest digest.', 'utf8'))

    expect(verifyBytes(publicKey, altered, signature)).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    const { publicKey } = generateSigningKeyPair()

    expect(verifyBytes(publicKey, message, new Uint8Array(32))).toBe(false)
  })

  it('derives the public key from the private key, so a device stores only the seed', () => {
    const { publicKey, privateKey } = generateSigningKeyPair()

    expect(publicKeyFromPrivate(privateKey)).toEqual(publicKey)
  })
})

describe('domain separation', () => {
  it('yields different signing input for the same digest under different domains', () => {
    const digest = new Uint8Array(createHash('sha256').update('manifest').digest())

    const asManifest = domainSeparated('tkpak/v1/manifest', digest)
    const asOperation = domainSeparated('passvault/v1/operation', digest)

    expect(Buffer.from(asManifest).equals(Buffer.from(asOperation))).toBe(false)
  })

  it('separates the domain from the digest with a zero byte so no domain is a prefix of another', () => {
    const digest = new Uint8Array([0xaa])

    const separated = domainSeparated('a', digest)

    expect(Array.from(separated)).toEqual([0x61, 0x00, 0xaa])
  })
})
