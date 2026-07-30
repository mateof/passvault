import {
  NONCE_BYTES,
  blindIndex,
  hkdf,
  normalise,
  open,
  randomNonce,
  seal,
} from '@passvault/crypto'
import type { ServerConfig } from './config.js'

/**
 * Field-level encryption and the blind index, bound to this installation's keys.
 *
 * Encryption is selective by design, as set out in docs/threat-model.md: barcodes,
 * documents, real names, notes and amounts are ciphertext, while identifiers, relations,
 * states and timestamps stay plaintext so the database can still be queried. Encrypting
 * everything would make the system unusable and protect little — knowing that user 7 holds
 * ticket 12 is far less damaging than holding the barcode.
 */
export class CryptoContext {
  constructor(
    readonly masterKey: Uint8Array,
    private readonly blindIndexKey: Uint8Array,
  ) {}

  static fromConfig(config: ServerConfig): CryptoContext {
    return new CryptoContext(config.masterKey, config.blindIndexKey)
  }

  /**
   * The searchable form of an email address.
   *
   * An HMAC rather than a hash: a plain SHA-256 of an email would fall to a dictionary of
   * candidate addresses in seconds. Also the column that carries uniqueness, since an
   * encrypted address cannot be constrained.
   */
  emailIndex(email: string): string {
    return blindIndex(this.blindIndexKey, email)
  }

  /** The value that gets encrypted, normalised the same way as its index so they cannot disagree. */
  normaliseEmail(email: string): string {
    return normalise(email)
  }

  /**
   * A key the server can use without the user present, derived per user from the master key.
   *
   * Needed because a handful of values must be readable outside a session, and encrypting them
   * under the user's data key would make the product not work rather than make it safer:
   *
   *   * the **email address**, because the server sends invitations, one-time codes and
   *     password-setup links — none of which happen while the user is signed in;
   *   * the **TOTP secret**, because it is checked during login, before any passphrase.
   *
   * What this protects: a stolen database alone yields neither, since the master key is not in
   * it. What it does not protect: the server operator, who holds both. That asymmetry is
   * deliberate and recorded in docs/threat-model.md — an operator who can send mail on your
   * behalf can necessarily read the address it goes to, and pretending otherwise would be a
   * comforting lie rather than a security property.
   *
   * Everything that is genuinely user data — barcodes, documents, names, notes, amounts — stays
   * under the user's data key and out of the operator's reach.
   */
  serverKey(userId: string, purpose: 'email' | 'totp-secret'): Uint8Array {
    return hkdf(
      this.masterKey,
      new Uint8Array(Buffer.from(userId, 'utf8')),
      `passvault/v1/server-field:${purpose}`,
    )
  }

  /**
   * Encrypts a column value.
   *
   * The associated data names the exact column and row, so a ciphertext cannot be moved:
   * pasting an encrypted display name into a barcode column, or one user's row into
   * another's, fails authentication rather than decrypting into the wrong place.
   */
  encryptField(dataKey: Uint8Array, value: string, field: FieldRef): Uint8Array {
    const nonce = randomNonce()
    const body = seal({
      key: dataKey,
      nonce,
      plaintext: new Uint8Array(Buffer.from(value, 'utf8')),
      aad: fieldAad(field),
    })
    return new Uint8Array(Buffer.concat([Buffer.from(nonce), Buffer.from(body)]))
  }

  decryptField(dataKey: Uint8Array, stored: Uint8Array, field: FieldRef): string {
    const plaintext = open({
      key: dataKey,
      nonce: stored.subarray(0, NONCE_BYTES),
      ciphertext: stored.subarray(NONCE_BYTES),
      aad: fieldAad(field),
    })
    return Buffer.from(plaintext).toString('utf8')
  }

  encryptBytes(dataKey: Uint8Array, value: Uint8Array, field: FieldRef): Uint8Array {
    const nonce = randomNonce()
    const body = seal({ key: dataKey, nonce, plaintext: value, aad: fieldAad(field) })
    return new Uint8Array(Buffer.concat([Buffer.from(nonce), Buffer.from(body)]))
  }

  decryptBytes(dataKey: Uint8Array, stored: Uint8Array, field: FieldRef): Uint8Array {
    return open({
      key: dataKey,
      nonce: stored.subarray(0, NONCE_BYTES),
      ciphertext: stored.subarray(NONCE_BYTES),
      aad: fieldAad(field),
    })
  }

  /** Optional variants, since most encrypted columns are nullable. */
  encryptOptional(
    dataKey: Uint8Array,
    value: string | null | undefined,
    field: FieldRef,
  ): Uint8Array | null {
    return value === null || value === undefined ? null : this.encryptField(dataKey, value, field)
  }

  decryptOptional(
    dataKey: Uint8Array,
    stored: Uint8Array | null | undefined,
    field: FieldRef,
  ): string | null {
    return stored === null || stored === undefined
      ? null
      : this.decryptField(dataKey, stored, field)
  }
}

export interface FieldRef {
  table: string
  column: string
  rowId: string
}

const fieldAad = (field: FieldRef): string =>
  `passvault/v1/field:${field.table}.${field.column}:${field.rowId}`
