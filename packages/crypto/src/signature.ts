import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { CryptoError } from './errors.js'

export const ED25519_PUBLIC_BYTES = 32
export const ED25519_PRIVATE_BYTES = 32
export const ED25519_SIGNATURE_BYTES = 64

/**
 * Node exposes Ed25519 keys as DER structures, while the `.tkpak` format stores
 * bare 32-byte keys — the form every other language uses. Both DER wrappers are
 * fixed-length prefixes for this curve, so converting is a matter of prepending or
 * dropping a known header rather than parsing ASN.1.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface SigningKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: rawPublicKey(publicKey),
    privateKey: rawPrivateKey(privateKey),
  }
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'spki' })
  return new Uint8Array(der.subarray(SPKI_PREFIX.length))
}

function rawPrivateKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'pkcs8' })
  return new Uint8Array(der.subarray(PKCS8_PREFIX.length))
}

function toPublicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== ED25519_PUBLIC_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', `Ed25519 public key must be ${ED25519_PUBLIC_BYTES} bytes`)
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  })
}

function toPrivateKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== ED25519_PRIVATE_BYTES) {
    throw new CryptoError(
      'MALFORMED_INPUT',
      `Ed25519 private key must be ${ED25519_PRIVATE_BYTES} bytes`,
    )
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** Derives the public key from a private one, so a device needs to store only the seed. */
export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return rawPublicKey(createPublicKey(toPrivateKeyObject(privateKey)))
}

export function signBytes(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, toPrivateKeyObject(privateKey)))
}

export function verifyBytes(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return false
  }
  return verify(null, message, toPublicKeyObject(publicKey), signature)
}

/**
 * Prefixes a message with a domain string before signing.
 *
 * Without it, a signature produced for one purpose could be replayed as a valid
 * signature for another — a manifest digest presented as a sync operation, say.
 * The separator is a zero byte so no domain string can be a prefix of another.
 */
export function domainSeparated(domain: string, digest: Uint8Array): Uint8Array {
  const prefix = Buffer.from(domain, 'utf8')
  return new Uint8Array(Buffer.concat([prefix, Buffer.of(0x00), Buffer.from(digest)]))
}
