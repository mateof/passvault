import {
  SLOT_RECOVERY_CODE,
  SLOT_VAULT_PASSPHRASE,
  addPasswordSlot,
  createDataKey,
  emptyEnvelope,
  generateRecoveryCode,
  isKeyMismatch,
  normaliseRecoveryCode,
  openSealedEnvelope,
  sealEnvelope,
  unlockWithPassword,
  type Argon2Params,
  type KeyEnvelope,
} from '@passvault/crypto'
import { locked, unauthorized } from './errors.js'

/**
 * Unwrapped data keys, held in memory for the life of a session.
 *
 * The vault passphrase is separate from the login credential, for the reason set out in
 * docs/security.md: a user who signs in with Google or a passkey presents no secret from
 * which a key can be derived, so a single uniform encryption scheme needs a secret of its
 * own. The consequence is that a session has to hold the unwrapped key somewhere, because
 * asking for the passphrase on every request is unusable.
 *
 * That is a real, accepted exposure and it is bounded rather than denied: an idle timeout,
 * a hard timeout, and eviction on logout. An attacker with code execution on a running
 * server reaches the keys of currently-active users. It is in the threat model as an
 * accepted risk, not as an oversight.
 */
export interface VaultSession {
  sessionId: string
  userId: string
  dataKey: Uint8Array
  idleExpiresAt: number
  hardExpiresAt: number
}

export interface VaultCacheOptions {
  idleMinutes: number
  hardHours: number
  /** Injected so tests can advance time instead of waiting. */
  now?: () => number
}

export class VaultCache {
  private readonly sessions = new Map<string, VaultSession>()
  /**
   * Event keys opened this session, keyed by session and event.
   *
   * So a member types an event password once rather than on every request. Bound to the session
   * rather than the user, so signing out on one device does not leave a key usable on another,
   * and cleared with the session it belongs to.
   */
  private readonly eventKeys = new Map<string, Uint8Array>()
  private readonly idleMs: number
  private readonly hardMs: number
  private readonly now: () => number

  constructor(options: VaultCacheOptions) {
    this.idleMs = options.idleMinutes * 60_000
    this.hardMs = options.hardHours * 3_600_000
    this.now = options.now ?? Date.now
  }

  unlock(sessionId: string, userId: string, dataKey: Uint8Array): VaultSession {
    const at = this.now()
    const session: VaultSession = {
      sessionId,
      userId,
      dataKey,
      idleExpiresAt: at + this.idleMs,
      hardExpiresAt: at + this.hardMs,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * Returns the key for a session, extending the idle window.
   *
   * Returns undefined rather than throwing when the session has no key: that is the
   * ordinary case of a signed-in user who has not entered their passphrase yet, and the
   * route layer turns it into a prompt.
   */
  get(sessionId: string): VaultSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return undefined
    }
    const at = this.now()
    if (at >= session.hardExpiresAt || at >= session.idleExpiresAt) {
      this.evict(sessionId)
      return undefined
    }
    session.idleExpiresAt = at + this.idleMs
    return session
  }

  require(sessionId: string): VaultSession {
    const session = this.get(sessionId)
    if (!session) {
      throw locked('vault.passphraseRequired')
    }
    return session
  }

  unlockEvent(sessionId: string, eventId: string, eventKey: Uint8Array): void {
    this.eventKeys.set(`${sessionId}:${eventId}`, eventKey)
  }

  /**
   * An event key opened earlier in this session.
   *
   * Returns nothing once the session's own key has expired, so an event key never outlives the
   * session that opened it — otherwise a timed-out session would still be able to read tickets.
   */
  getEventKey(sessionId: string, eventId: string): Uint8Array | undefined {
    if (!this.get(sessionId)) {
      return undefined
    }
    return this.eventKeys.get(`${sessionId}:${eventId}`)
  }

  evict(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      // Overwriting is not a guarantee — the engine may have copied the bytes — but it costs
      // nothing and removes the obvious copy from a heap dump.
      session.dataKey.fill(0)
      this.sessions.delete(sessionId)
    }
    for (const key of [...this.eventKeys.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.eventKeys.get(key)?.fill(0)
        this.eventKeys.delete(key)
      }
    }
  }

  evictUser(userId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        this.evict(sessionId)
      }
    }
  }

  /** Drops everything expired. Called on a timer so idle keys do not sit around until reuse. */
  sweep(): number {
    const at = this.now()
    let removed = 0
    for (const [sessionId, session] of this.sessions) {
      if (at >= session.hardExpiresAt || at >= session.idleExpiresAt) {
        this.evict(sessionId)
        removed += 1
      }
    }
    return removed
  }

  get size(): number {
    return this.sessions.size
  }
}

export interface CreatedVault {
  sealedEnvelope: Uint8Array
  dataKey: Uint8Array
  recoveryCode: string
}

/**
 * Creates a user's key material.
 *
 * The recovery code is returned once and never stored in a form that can produce it again —
 * only a slot it can open. A user who loses both the passphrase and the code has
 * unrecoverable data, which is stated at signup rather than in small print.
 */
export async function createVault(
  masterKey: Uint8Array,
  passphrase: string,
  params?: Argon2Params,
): Promise<CreatedVault> {
  const dataKey = createDataKey()
  const recoveryCode = generateRecoveryCode()
  let envelope: KeyEnvelope = await addPasswordSlot(
    emptyEnvelope(),
    SLOT_VAULT_PASSPHRASE,
    dataKey,
    passphrase,
    params,
  )
  envelope = await addPasswordSlot(
    envelope,
    SLOT_RECOVERY_CODE,
    dataKey,
    normaliseRecoveryCode(recoveryCode),
    params,
  )
  return { sealedEnvelope: sealEnvelope(envelope, masterKey), dataKey, recoveryCode }
}

export async function unlockVault(
  masterKey: Uint8Array,
  sealedEnvelope: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  const envelope = openSealedEnvelope(sealedEnvelope, masterKey)
  try {
    return await unlockWithPassword(envelope, SLOT_VAULT_PASSPHRASE, passphrase)
  } catch (error) {
    if (isKeyMismatch(error)) {
      throw unauthorized('vault.error.wrongPassphrase')
    }
    throw error
  }
}

export async function unlockVaultWithRecoveryCode(
  masterKey: Uint8Array,
  sealedEnvelope: Uint8Array,
  recoveryCode: string,
): Promise<Uint8Array> {
  const envelope = openSealedEnvelope(sealedEnvelope, masterKey)
  let normalised: string
  try {
    normalised = normaliseRecoveryCode(recoveryCode)
  } catch {
    // A malformed code is a typo, reported as "check the code" rather than "wrong code".
    throw unauthorized('vault.error.invalidRecoveryCode')
  }
  try {
    return await unlockWithPassword(envelope, SLOT_RECOVERY_CODE, normalised)
  } catch (error) {
    if (isKeyMismatch(error)) {
      throw unauthorized('vault.error.invalidRecoveryCode')
    }
    throw error
  }
}

/**
 * Replaces the passphrase slot, keeping the same data key.
 *
 * Re-wrapping rather than re-encrypting: the data key does not change, so nothing stored has
 * to be touched. Changing a passphrase on a wallet with thousands of tickets is a single row
 * update.
 */
export async function changePassphrase(
  masterKey: Uint8Array,
  sealedEnvelope: Uint8Array,
  currentPassphrase: string,
  nextPassphrase: string,
  params?: Argon2Params,
): Promise<Uint8Array> {
  const dataKey = await unlockVault(masterKey, sealedEnvelope, currentPassphrase)
  const envelope = openSealedEnvelope(sealedEnvelope, masterKey)
  const updated = await addPasswordSlot(
    envelope,
    SLOT_VAULT_PASSPHRASE,
    dataKey,
    nextPassphrase,
    params,
  )
  return sealEnvelope(updated, masterKey)
}
