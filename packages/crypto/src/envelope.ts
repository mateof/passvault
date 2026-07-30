import { open, seal } from './aead.js'
import { fromBase64Url, fromBase64UrlExact, toBase64Url } from './base64url.js'
import { CryptoError } from './errors.js'
import {
  DEFAULT_ARGON2_PARAMS,
  assertUsableParams,
  deriveKey,
  type Argon2Params,
} from './kdf.js'
import { wrapKey, unwrapKey } from './keywrap.js'
import { KEY_BYTES, NONCE_BYTES, randomKey, randomNonce, randomSalt } from './random.js'

/**
 * How a data encryption key is protected, and why there are two layers.
 *
 * A user's data encryption key (DEK) encrypts their tickets. The DEK itself is
 * wrapped by one or more *slots* — a slot derived from the vault passphrase, another
 * from the recovery code — and the whole set of slots is then sealed again under the
 * server's master key before being stored.
 *
 * The nesting is what makes the guarantees hold together:
 *
 * - **Database alone** yields nothing: the outer layer needs the master key.
 * - **Database and master key** yield nothing: the inner slots need the passphrase.
 * - **Master key rotation** re-seals the outer layer only, so it needs no user
 *   secrets and no user has to log in for it to complete.
 *
 * Wrapping the DEK directly under the master key *in parallel* with the passphrase
 * — the obvious first design — would break the second guarantee, because either key
 * alone would then be enough. Wrapping it under a key derived from both at once
 * would break the third, since rotation would need every passphrase.
 */
export const ENVELOPE_VERSION = 1

export const SLOT_VAULT_PASSPHRASE = 'vault-passphrase'
export const SLOT_RECOVERY_CODE = 'recovery-code'
export const SLOT_EVENT_PASSWORD = 'event-password'
export const SLOT_CREATOR = 'creator'

export interface Argon2EnvelopeSlot {
  kind: 'argon2id'
  salt: string
  memoryKiB: number
  iterations: number
  parallelism: number
  nonce: string
  ciphertext: string
}

export interface RawKeyEnvelopeSlot {
  kind: 'raw-key'
  nonce: string
  ciphertext: string
}

export type EnvelopeSlot = Argon2EnvelopeSlot | RawKeyEnvelopeSlot

export interface KeyEnvelope {
  version: typeof ENVELOPE_VERSION
  slots: Record<string, EnvelopeSlot>
}

const ENVELOPE_AAD = 'passvault/v1/envelope'

const slotAad = (slotId: string): string => `passvault/v1/envelope-slot:${slotId}`

export function createDataKey(): Uint8Array {
  return randomKey()
}

export function emptyEnvelope(): KeyEnvelope {
  return { version: ENVELOPE_VERSION, slots: {} }
}

/** Adds a slot openable by a human secret: a vault passphrase, an event password, a recovery code. */
export async function addPasswordSlot(
  envelope: KeyEnvelope,
  slotId: string,
  dataKey: Uint8Array,
  secret: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<KeyEnvelope> {
  assertUsableParams(params)
  const salt = randomSalt()
  const kek = await deriveKey(secret, salt, params)
  const wrapped = wrapKey(kek, dataKey, slotAad(slotId))
  return withSlot(envelope, slotId, {
    kind: 'argon2id',
    salt: toBase64Url(salt),
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    nonce: toBase64Url(wrapped.nonce),
    ciphertext: toBase64Url(wrapped.ciphertext),
  })
}

/**
 * Adds a slot openable by a key the holder already has.
 *
 * Used so an event organiser can reopen their own password-protected event with
 * their user DEK instead of retyping the event password, and so a device can hold a
 * slot keyed by hardware-backed key material.
 */
export function addKeySlot(
  envelope: KeyEnvelope,
  slotId: string,
  dataKey: Uint8Array,
  kek: Uint8Array,
): KeyEnvelope {
  const wrapped = wrapKey(kek, dataKey, slotAad(slotId))
  return withSlot(envelope, slotId, {
    kind: 'raw-key',
    nonce: toBase64Url(wrapped.nonce),
    ciphertext: toBase64Url(wrapped.ciphertext),
  })
}

function withSlot(envelope: KeyEnvelope, slotId: string, slot: EnvelopeSlot): KeyEnvelope {
  return { version: ENVELOPE_VERSION, slots: { ...envelope.slots, [slotId]: slot } }
}

export function removeSlot(envelope: KeyEnvelope, slotId: string): KeyEnvelope {
  const slots = { ...envelope.slots }
  delete slots[slotId]
  return { version: ENVELOPE_VERSION, slots }
}

export function hasSlot(envelope: KeyEnvelope, slotId: string): boolean {
  return Object.hasOwn(envelope.slots, slotId)
}

function requireSlot(envelope: KeyEnvelope, slotId: string): EnvelopeSlot {
  const slot = envelope.slots[slotId]
  if (!slot) {
    throw new CryptoError('MALFORMED_INPUT', `envelope has no slot '${slotId}'`)
  }
  return slot
}

export async function unlockWithPassword(
  envelope: KeyEnvelope,
  slotId: string,
  secret: string,
): Promise<Uint8Array> {
  const slot = requireSlot(envelope, slotId)
  if (slot.kind !== 'argon2id') {
    throw new CryptoError('MALFORMED_INPUT', `slot '${slotId}' is not opened by a password`)
  }
  const params: Argon2Params = {
    memoryKiB: slot.memoryKiB,
    iterations: slot.iterations,
    parallelism: slot.parallelism,
  }
  const kek = await deriveKey(secret, fromBase64Url(slot.salt), params)
  return unwrapKey(
    kek,
    {
      nonce: fromBase64UrlExact(slot.nonce, NONCE_BYTES),
      ciphertext: fromBase64Url(slot.ciphertext),
    },
    slotAad(slotId),
    'WRONG_PASSWORD',
  )
}

export function unlockWithKey(
  envelope: KeyEnvelope,
  slotId: string,
  kek: Uint8Array,
): Uint8Array {
  const slot = requireSlot(envelope, slotId)
  if (slot.kind !== 'raw-key') {
    throw new CryptoError('MALFORMED_INPUT', `slot '${slotId}' is not opened by a key`)
  }
  return unwrapKey(
    kek,
    {
      nonce: fromBase64UrlExact(slot.nonce, NONCE_BYTES),
      ciphertext: fromBase64Url(slot.ciphertext),
    },
    slotAad(slotId),
    'WRONG_KEY',
  )
}

/** The outer, server-held layer. What actually gets stored in the database. */
export function sealEnvelope(envelope: KeyEnvelope, masterKey: Uint8Array): Uint8Array {
  const nonce = randomNonce()
  const body = seal({
    key: masterKey,
    nonce,
    plaintext: new Uint8Array(Buffer.from(JSON.stringify(envelope), 'utf8')),
    aad: ENVELOPE_AAD,
  })
  return new Uint8Array(Buffer.concat([Buffer.from(nonce), Buffer.from(body)]))
}

export function openSealedEnvelope(sealed: Uint8Array, masterKey: Uint8Array): KeyEnvelope {
  if (sealed.length <= NONCE_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', 'sealed envelope is too short')
  }
  const plaintext = open({
    key: masterKey,
    nonce: sealed.subarray(0, NONCE_BYTES),
    ciphertext: sealed.subarray(NONCE_BYTES),
    aad: ENVELOPE_AAD,
    failureCode: 'WRONG_KEY',
  })
  const parsed = JSON.parse(Buffer.from(plaintext).toString('utf8')) as KeyEnvelope
  if (parsed.version !== ENVELOPE_VERSION) {
    throw new CryptoError('MALFORMED_INPUT', `unsupported envelope version ${parsed.version}`)
  }
  return parsed
}

/**
 * Re-seals the outer layer under a new master key.
 *
 * Rotation touches no slot and needs no user secret, which is the whole reason the
 * layers are nested: rotating the master key of an instance with a thousand users
 * is a loop over rows, not a request that each of them log in.
 */
export function resealEnvelope(
  sealed: Uint8Array,
  currentMasterKey: Uint8Array,
  nextMasterKey: Uint8Array,
): Uint8Array {
  return sealEnvelope(openSealedEnvelope(sealed, currentMasterKey), nextMasterKey)
}

export function assertMasterKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('MALFORMED_INPUT', `master key must be ${KEY_BYTES} bytes`)
  }
}
