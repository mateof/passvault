export { TAG_BYTES, open, seal, type OpenInput, type SealInput } from './aead.js'
export {
  X25519_KEY_BYTES,
  agree,
  generateAgreementKeyPair,
  hkdf,
  sealedSlotKey,
  type AgreementKeyPair,
} from './agreement.js'
export { fromBase64Url, fromBase64UrlExact, toBase64Url } from './base64url.js'
export { blindIndex, blindIndexEquals, normalise } from './blind-index.js'
export {
  ENVELOPE_VERSION,
  SLOT_CREATOR,
  SLOT_EVENT_PASSWORD,
  SLOT_RECOVERY_CODE,
  SLOT_VAULT_PASSPHRASE,
  addKeySlot,
  addPasswordSlot,
  assertMasterKey,
  createDataKey,
  emptyEnvelope,
  hasSlot,
  openSealedEnvelope,
  removeSlot,
  resealEnvelope,
  sealEnvelope,
  unlockWithKey,
  unlockWithPassword,
  type Argon2EnvelopeSlot,
  type EnvelopeSlot,
  type KeyEnvelope,
  type RawKeyEnvelopeSlot,
} from './envelope.js'
export { CryptoError, isKeyMismatch, type CryptoErrorCode } from './errors.js'
export {
  ARGON2ID,
  DEFAULT_ARGON2_PARAMS,
  TEST_ARGON2_PARAMS,
  assertUsableParams,
  deriveKey,
  encodeSecret,
  type Argon2Params,
} from './kdf.js'
export { unwrapKey, wrapKey, type WrappedKey } from './keywrap.js'
export { SAS_DIGITS, completePairing, type PairingInput, type PairingResult } from './pairing.js'
export {
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  verifyAgainstAbsentAccount,
  verifyPassword,
} from './password.js'
export {
  KEY_BYTES,
  NONCE_BYTES,
  SALT_BYTES,
  randomBytesOf,
  randomDigits,
  randomKey,
  randomNonce,
  randomSalt,
} from './random.js'
export { generateRecoveryCode, normaliseRecoveryCode } from './recovery-code.js'
export {
  ED25519_PRIVATE_BYTES,
  ED25519_PUBLIC_BYTES,
  ED25519_SIGNATURE_BYTES,
  domainSeparated,
  generateSigningKeyPair,
  publicKeyFromPrivate,
  signBytes,
  verifyBytes,
  type SigningKeyPair,
} from './signature.js'
