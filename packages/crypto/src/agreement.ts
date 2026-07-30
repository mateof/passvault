import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto'
import { CryptoError } from './errors.js'
import { KEY_BYTES } from './random.js'

export const X25519_KEY_BYTES = 32

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export interface AgreementKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateAgreementKeyPair(): AgreementKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: new Uint8Array(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length),
    ),
    privateKey: new Uint8Array(
      privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length),
    ),
  }
}

function toPublicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_KEY_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', `X25519 public key must be ${X25519_KEY_BYTES} bytes`)
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  })
}

function toPrivateKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_KEY_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', `X25519 private key must be ${X25519_KEY_BYTES} bytes`)
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * Raw X25519 shared secret. Never used as a key directly — it is not uniformly
 * distributed and carries no context, so it always goes through HKDF first.
 */
export function agree(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return new Uint8Array(
    diffieHellman({
      privateKey: toPrivateKeyObject(privateKey),
      publicKey: toPublicKeyObject(peerPublicKey),
    }),
  )
}

export function hkdf(
  inputKey: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = KEY_BYTES,
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', inputKey, salt, Buffer.from(info, 'utf8'), length))
}

/**
 * The key-encryption key of a `.tkpak` `x25519-sealed` slot.
 *
 * Both public keys go into the HKDF salt so the derived key is bound to the exact
 * pair of parties. Deriving from the shared secret alone would let the same key
 * appear in a context the sender never intended.
 */
export function sealedSlotKey(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const salt = Buffer.concat([Buffer.from(ephemeralPublicKey), Buffer.from(recipientPublicKey)])
  return hkdf(sharedSecret, new Uint8Array(salt), 'tkpak/v1/seal')
}
