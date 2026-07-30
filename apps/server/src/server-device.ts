import { createHash } from 'node:crypto'
import { hkdf, publicKeyFromPrivate, signBytes, toBase64Url } from '@passvault/crypto'
import { toInstant, type DatabaseHandle } from '@passvault/db'
import { signingInput, type SignedOperation } from './operations.js'
import type { CryptoContext } from './crypto-context.js'

/**
 * The server, as a device in the log.
 *
 * Every operation is signed by the device that produced it, and until now the server produced
 * none: creating an event, adding tickets, assigning one and recording a payment all wrote rows
 * and recorded nothing. The consequence was invisible until a phone synchronised and received
 * zero operations for an event that plainly had tickets in it — the log was empty because only
 * things pushed into it ever went in.
 *
 * The signing key is derived from `MASTER_KEY` rather than stored. There is no new secret to
 * generate, back up or rotate, it survives a restart without a file, and losing it is losing the
 * key that already decrypts everything — so it adds no new way to lose data.
 *
 * The device id is derived from the public key, so an installation names itself the same way on
 * every boot and a phone that has seen its operations before still recognises them.
 */

const SIGNING_INFO = 'passvault/v1/server-device/signing'
const ID_DOMAIN = 'passvault/v1/server-device/id'

export interface ServerDevice {
  deviceId: string
  signingPrivateKey: Uint8Array
  signingPublicKey: Uint8Array
}

export function serverDeviceFrom(crypto: CryptoContext): ServerDevice {
  const signingPrivateKey = hkdf(crypto.masterKey, new Uint8Array(0), SIGNING_INFO)
  const signingPublicKey = publicKeyFromPrivate(signingPrivateKey)
  return { deviceId: deviceIdFor(signingPublicKey), signingPrivateKey, signingPublicKey }
}

/** A UUID shaped from the public key, so the name is stable and needs storing nowhere. */
function deviceIdFor(publicKey: Uint8Array): string {
  const digest = createHash('sha256').update(ID_DOMAIN).update(publicKey).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  // Version 4 and the RFC variant, so it is a well-formed UUID rather than sixteen bytes that
  // happen to be printed like one — the schema and every client validate the shape.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Makes sure the server's own device row exists.
 *
 * Without it the server's operations are quarantined by its own acceptance rules, which check the
 * signing key of whoever produced them — and it would be quarantining itself.
 */
export async function ensureServerDevice(
  db: DatabaseHandle,
  device: ServerDevice,
  userId: string | null,
): Promise<void> {
  const existing = await db.db
    .selectFrom('devices')
    .select('id')
    .where('id', '=', device.deviceId)
    .executeTakeFirst()
  if (existing) {
    return
  }
  await db.db
    .insertInto('devices')
    .values({
      id: device.deviceId,
      user_id: userId,
      name: 'PassVault server',
      signing_public_key: toBase64Url(device.signingPublicKey),
      agreement_public_key: toBase64Url(device.signingPublicKey),
      status: 'ACTIVE',
      created_at: toInstant(),
      last_seen_at: toInstant(),
    } as never)
    .execute()
}

/** Signs an operation as the server. */
export function signAsServer(
  device: ServerDevice,
  unsigned: Omit<SignedOperation, 'signature'>,
): SignedOperation {
  return {
    ...unsigned,
    signature: toBase64Url(signBytes(device.signingPrivateKey, signingInput(unsigned))),
  }
}
