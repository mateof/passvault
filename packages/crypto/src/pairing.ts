import { createHash } from 'node:crypto'
import { agree, hkdf } from './agreement.js'

/**
 * Pairing two devices over a local network.
 *
 * Being on the same Wi-Fi authenticates nobody: on a café network any device can
 * advertise itself as `_passvault._tcp` under the name "Ana's PassVault". So the
 * two sides perform an X25519 agreement and then each derive six digits from the
 * transcript. The users compare the digits out of band — by looking at each other's
 * screens — and only then does anything transfer.
 *
 * An attacker who interposes themselves ends up with two different shared secrets,
 * one per side, and therefore cannot make both screens show the same digits. A
 * mismatch is a detected attack, not a glitch, and the interface says so.
 *
 * This is the short-authentication-string construction used by ZRTP. SPAKE2 would
 * let the sender dictate a PIN instead of both parties comparing one, which is
 * slightly nicer, but it would mean hand-writing an unusual protocol twice, in
 * TypeScript and in Kotlin. This uses only primitives both platforms already have.
 */
export const SAS_DIGITS = 6

const SAS_BYTES = 8

export interface PairingResult {
  /** Digits both users must compare before any data moves. */
  shortAuthenticationString: string
  /** Key for the transfer itself, available only after the users confirm. */
  sessionKey: Uint8Array
  transcriptHash: Uint8Array
}

export interface PairingInput {
  ownPrivateKey: Uint8Array
  ownPublicKey: Uint8Array
  peerPublicKey: Uint8Array
  /** True on the side that advertised the service, so both order the transcript identically. */
  isInitiator: boolean
}

export function completePairing({
  ownPrivateKey,
  ownPublicKey,
  peerPublicKey,
  isInitiator,
}: PairingInput): PairingResult {
  const sharedSecret = agree(ownPrivateKey, peerPublicKey)
  // Both sides must hash the keys in the same order or they derive different digits
  // and every honest pairing would look like an attack.
  const initiatorKey = isInitiator ? ownPublicKey : peerPublicKey
  const responderKey = isInitiator ? peerPublicKey : ownPublicKey
  const salt = new Uint8Array(
    Buffer.concat([Buffer.from(initiatorKey), Buffer.from(responderKey)]),
  )
  return {
    shortAuthenticationString: digitsFrom(hkdf(sharedSecret, salt, 'passvault/v1/sas', SAS_BYTES)),
    sessionKey: hkdf(sharedSecret, salt, 'passvault/v1/session'),
    transcriptHash: new Uint8Array(createHash('sha256').update(salt).digest()),
  }
}

/**
 * Maps eight bytes onto six decimal digits. Reducing 64 bits modulo a million
 * leaves a bias far below the 1-in-a-million an attacker already faces, whereas
 * doing the same with four bytes would be visible.
 */
function digitsFrom(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  const modulus = 10n ** BigInt(SAS_DIGITS)
  return (value % modulus).toString().padStart(SAS_DIGITS, '0')
}
