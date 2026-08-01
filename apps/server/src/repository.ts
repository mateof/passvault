import { createHash } from 'node:crypto'
import { instantIn, newId, toInstant, type Database, type DatabaseHandle } from '@passvault/db'
import type { Locale } from '@passvault/i18n'
import type { Selectable } from 'kysely'

/**
 * Data access.
 *
 * Plain functions over a Kysely handle rather than classes: every one of these is a query
 * with no state of its own, and the indirection of a repository object would only hide which
 * columns are being read — which matters here, because reading an encrypted column when a
 * plaintext one would do is the mistake that leaks data into logs.
 */
export type UserRow = Selectable<Database['users']>
export type SessionRow = Selectable<Database['sessions']>
export type RegistrationSettingsRow = Selectable<Database['registration_settings']>

export interface NewUser {
  emailCipher: Uint8Array
  emailKey: string
  displayNameCipher: Uint8Array | null
  passwordHash: string | null
  locale: Locale
  isAdmin: boolean
  status: 'ACTIVE' | 'INVITED'
}

export async function insertUser(handle: DatabaseHandle, user: NewUser): Promise<string> {
  const id = newId()
  const now = toInstant()
  await handle.db
    .insertInto('users')
    .values({
      id,
      email_cipher: Buffer.from(user.emailCipher),
      email_key: user.emailKey,
      display_name_cipher: user.displayNameCipher ? Buffer.from(user.displayNameCipher) : null,
      password_hash: user.passwordHash,
      status: user.status,
      locale: user.locale,
      is_admin: user.isAdmin ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return id
}

export async function findUserByEmailIndex(
  handle: DatabaseHandle,
  emailKey: string,
): Promise<UserRow | undefined> {
  return handle.db
    .selectFrom('users')
    .selectAll()
    .where('email_key', '=', emailKey)
    .executeTakeFirst()
}

export async function findUserById(
  handle: DatabaseHandle,
  id: string,
): Promise<UserRow | undefined> {
  return handle.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
}

/**
 * Every account, for the administration screen.
 *
 * Whether a user has key material is part of the answer and comes from a join rather than a
 * second query per row: an account created by an administrator or through a provider has no
 * vault until the user sets a passphrase, and "signed in but holding nothing" is the state an
 * administrator most often has to explain.
 */
export async function listUsers(handle: DatabaseHandle) {
  return handle.db
    .selectFrom('users')
    .leftJoin('user_keys', 'user_keys.user_id', 'users.id')
    .select([
      'users.id',
      'users.email_cipher',
      'users.handle',
      'users.status',
      'users.locale',
      'users.is_admin',
      'users.password_hash',
      'users.created_at',
      'user_keys.passphrase_set_at',
    ])
    .orderBy('users.created_at', 'asc')
    .execute()
}

export async function countUsers(handle: DatabaseHandle): Promise<number> {
  const row = await handle.db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

export async function updatePasswordHash(
  handle: DatabaseHandle,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await handle.db
    .updateTable('users')
    .set({ password_hash: passwordHash, updated_at: toInstant() })
    .where('id', '=', userId)
    .execute()
}

export async function countAdmins(handle: DatabaseHandle): Promise<number> {
  const row = await handle.db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .where('is_admin', '=', 1)
    .where('status', '!=', 'SUSPENDED')
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

export async function setUserAdmin(
  handle: DatabaseHandle,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  await handle.db
    .updateTable('users')
    .set({ is_admin: isAdmin ? 1 : 0, updated_at: toInstant() })
    .where('id', '=', userId)
    .execute()
}

export async function setUserStatus(
  handle: DatabaseHandle,
  userId: string,
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED',
): Promise<void> {
  await handle.db
    .updateTable('users')
    .set({ status, updated_at: toInstant() })
    .where('id', '=', userId)
    .execute()
}

/**
 * Moves an account out of INVITED once it has been through setup.
 *
 * Only from INVITED, which is not a detail: without that clause the same call would silently
 * un-suspend an account the moment its owner set a vault passphrase.
 */
export async function activateUser(handle: DatabaseHandle, userId: string): Promise<void> {
  await handle.db
    .updateTable('users')
    .set({ status: 'ACTIVE', updated_at: toInstant() })
    .where('id', '=', userId)
    .where('status', '=', 'INVITED')
    .execute()
}

export async function saveUserKeys(
  handle: DatabaseHandle,
  userId: string,
  sealedEnvelope: Uint8Array,
  hasRecoverySlot: boolean,
): Promise<void> {
  const now = toInstant()
  await handle.db
    .insertInto('user_keys')
    .values({
      user_id: userId,
      sealed_envelope: Buffer.from(sealedEnvelope),
      has_recovery_slot: hasRecoverySlot ? 1 : 0,
      passphrase_set_at: now,
      updated_at: now,
    })
    .execute()
}

export async function replaceUserKeys(
  handle: DatabaseHandle,
  userId: string,
  sealedEnvelope: Uint8Array,
): Promise<void> {
  await handle.db
    .updateTable('user_keys')
    .set({ sealed_envelope: Buffer.from(sealedEnvelope), updated_at: toInstant() })
    .where('user_id', '=', userId)
    .execute()
}

export async function findUserKeys(
  handle: DatabaseHandle,
  userId: string,
): Promise<Uint8Array | undefined> {
  const row = await handle.db
    .selectFrom('user_keys')
    .select('sealed_envelope')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row ? new Uint8Array(row.sealed_envelope) : undefined
}

/**
 * Sessions store only a hash of the bearer token.
 *
 * SHA-256 without a salt, deliberately: the token is 32 random bytes, so there is nothing to
 * brute-force and a slow hash would only add latency to every authenticated request. That
 * reasoning does not transfer to passwords, which is why those use Argon2id.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url')

export async function insertSession(
  handle: DatabaseHandle,
  options: {
    userId: string
    token: string
    deviceId?: string | null
    idleMinutes: number
    hardHours: number
    /**
     * Where this was opened from, so somebody reading their own list of sessions can tell the
     * phone in their pocket from the laptop they left at work. Absent when a proxy strips it,
     * which is a reason to show less rather than to refuse a sign-in.
     */
    userAgent?: string | null
    ipAddress?: string | null
  },
): Promise<SessionRow> {
  const id = newId()
  const now = toInstant()
  const row = {
    id,
    user_id: options.userId,
    token_hash: hashToken(options.token),
    device_id: options.deviceId ?? null,
    created_at: now,
    idle_expires_at: instantIn(options.idleMinutes * 60),
    hard_expires_at: instantIn(options.hardHours * 3600),
    revoked_at: null,
    user_agent: options.userAgent?.slice(0, 200) ?? null,
    ip_address: options.ipAddress?.slice(0, 64) ?? null,
    last_seen_at: now,
    label_cipher: null,
  }
  await handle.db.insertInto('sessions').values(row).execute()
  return row
}

export async function findLiveSession(
  handle: DatabaseHandle,
  token: string,
): Promise<SessionRow | undefined> {
  const now = toInstant()
  return (
    handle.db
      .selectFrom('sessions')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .where('revoked_at', 'is', null)
      // Fixed-width ISO-8601 text, so a string comparison is a chronological comparison. This
      // is the property the whole instant convention exists for.
      .where('idle_expires_at', '>', now)
      .where('hard_expires_at', '>', now)
      .executeTakeFirst()
  )
}

export async function touchSession(
  handle: DatabaseHandle,
  sessionId: string,
  idleMinutes: number,
): Promise<void> {
  await handle.db
    .updateTable('sessions')
    // Both in one statement, since this already runs on every authenticated request and a
    // second UPDATE for a timestamp would double the busiest write in the server.
    .set({ idle_expires_at: instantIn(idleMinutes * 60), last_seen_at: toInstant() })
    .where('id', '=', sessionId)
    .execute()
}

export async function revokeSession(handle: DatabaseHandle, sessionId: string): Promise<void> {
  await handle.db
    .updateTable('sessions')
    .set({ revoked_at: toInstant() })
    .where('id', '=', sessionId)
    .execute()
}

export async function revokeSessionsOfUser(handle: DatabaseHandle, userId: string): Promise<void> {
  await handle.db
    .updateTable('sessions')
    .set({ revoked_at: toInstant() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute()
}

/**
 * The settings row if it has ever been written, without creating it.
 *
 * The distinction matters exactly once: at boot, "no row" means nobody has configured this
 * installation and the deployment file may seed it. Once a row exists, the environment stops
 * being authoritative — see `BootstrapConfig`.
 */
export async function findRegistrationSettings(
  handle: DatabaseHandle,
): Promise<RegistrationSettingsRow | undefined> {
  return handle.db
    .selectFrom('registration_settings')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirst()
}

export async function readRegistrationSettings(
  handle: DatabaseHandle,
): Promise<RegistrationSettingsRow> {
  const existing = await findRegistrationSettings(handle)
  if (existing) {
    return existing
  }
  // Closed by default. A fresh instance reachable from the internet must not accept signups
  // until its owner decides to, and the first-run bootstrap opens exactly one door.
  const row = {
    id: 1,
    mode: 'CLOSED' as const,
    allow_password_login: 1 as const,
    require_second_factor: 0 as const,
    // Null follows the deployment default; an administrator sets a number of days to override it.
    session_days: null,
    updated_at: toInstant(),
    updated_by: null,
  }
  await handle.db.insertInto('registration_settings').values(row).execute()
  return row
}

export async function writeRegistrationSettings(
  handle: DatabaseHandle,
  changes: {
    mode?: RegistrationSettingsRow['mode']
    allowPasswordLogin?: boolean
    requireSecondFactor?: boolean
    /** Days a session lasts, or null to hand it back to the deployment's own default. */
    sessionDays?: number | null
    /** Null when the deployment file wrote it at boot and there is no administrator to blame. */
    updatedBy: string | null
  },
): Promise<void> {
  await readRegistrationSettings(handle)
  await handle.db
    .updateTable('registration_settings')
    .set({
      ...(changes.mode ? { mode: changes.mode } : {}),
      ...(changes.allowPasswordLogin === undefined
        ? {}
        : { allow_password_login: changes.allowPasswordLogin ? 1 : 0 }),
      ...(changes.requireSecondFactor === undefined
        ? {}
        : { require_second_factor: changes.requireSecondFactor ? 1 : 0 }),
      ...(changes.sessionDays === undefined ? {} : { session_days: changes.sessionDays }),
      updated_at: toInstant(),
      updated_by: changes.updatedBy,
    })
    .where('id', '=', 1)
    .execute()
}

export async function isWhitelisted(handle: DatabaseHandle, emailKey: string): Promise<boolean> {
  const row = await handle.db
    .selectFrom('email_whitelist')
    .select('id')
    .where('email_key', '=', emailKey)
    .executeTakeFirst()
  return row !== undefined
}

export async function addToWhitelist(
  handle: DatabaseHandle,
  options: {
    /** Chosen by the caller, because the ciphertext is sealed against this identifier. */
    id: string
    emailKey: string
    emailCipher: Uint8Array
    /** Null when the deployment file seeded the entry before any account existed. */
    addedBy: string | null
  },
): Promise<void> {
  await handle.db
    .insertInto('email_whitelist')
    .values({
      id: options.id,
      email_key: options.emailKey,
      email_cipher: Buffer.from(options.emailCipher),
      added_by: options.addedBy,
      created_at: toInstant(),
    })
    .execute()
}

export async function listWhitelist(handle: DatabaseHandle) {
  return handle.db.selectFrom('email_whitelist').selectAll().orderBy('created_at', 'asc').execute()
}

export async function removeFromWhitelist(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db.deleteFrom('email_whitelist').where('id', '=', id).execute()
}

export async function insertInvitation(
  handle: DatabaseHandle,
  options: {
    codeHash: string
    emailKey: string | null
    createdBy: string
    maxUses: number
    ttlHours: number
  },
): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('invitations')
    .values({
      id,
      code_hash: options.codeHash,
      email_key: options.emailKey,
      created_by: options.createdBy,
      max_uses: options.maxUses,
      uses: 0,
      expires_at: instantIn(options.ttlHours * 3600),
      revoked_at: null,
      created_at: toInstant(),
    })
    .execute()
  return id
}

export async function listLiveInvitations(handle: DatabaseHandle) {
  return handle.db
    .selectFrom('invitations')
    .selectAll()
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', toInstant())
    .execute()
}

/**
 * Every invitation, spent and expired ones included.
 *
 * Deliberately not filtered the way `listLiveInvitations` is: an administrator looking at this
 * screen is usually asking "did the link I sent get used", and a list that hides everything
 * already used cannot answer that.
 */
export async function listInvitations(handle: DatabaseHandle) {
  return handle.db.selectFrom('invitations').selectAll().orderBy('created_at', 'desc').execute()
}

export async function revokeInvitation(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .updateTable('invitations')
    .set({ revoked_at: toInstant() })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute()
}

export async function consumeInvitation(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .updateTable('invitations')
    .set((eb) => ({ uses: eb('uses', '+', 1) }))
    .where('id', '=', id)
    .execute()
}

export async function insertPasswordSetupToken(
  handle: DatabaseHandle,
  options: { userId: string; tokenHash: string; ttlHours: number },
): Promise<string> {
  const id = newId()
  await handle.db
    .insertInto('password_setup_tokens')
    .values({
      id,
      user_id: options.userId,
      token_hash: options.tokenHash,
      expires_at: instantIn(options.ttlHours * 3600),
      consumed_at: null,
      created_at: toInstant(),
    })
    .execute()
  return id
}

export async function findLivePasswordSetupToken(handle: DatabaseHandle, token: string) {
  return handle.db
    .selectFrom('password_setup_tokens')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', toInstant())
    .executeTakeFirst()
}

export async function consumePasswordSetupToken(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .updateTable('password_setup_tokens')
    .set({ consumed_at: toInstant() })
    .where('id', '=', id)
    .execute()
}

export async function saveTotpSecret(
  handle: DatabaseHandle,
  userId: string,
  secretCipher: Uint8Array,
): Promise<void> {
  await handle.db.deleteFrom('totp_secrets').where('user_id', '=', userId).execute()
  await handle.db
    .insertInto('totp_secrets')
    .values({
      user_id: userId,
      secret_cipher: Buffer.from(secretCipher),
      confirmed_at: null,
      created_at: toInstant(),
    })
    .execute()
}

export async function findTotpSecret(handle: DatabaseHandle, userId: string) {
  return handle.db
    .selectFrom('totp_secrets')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst()
}

export async function confirmTotpSecret(handle: DatabaseHandle, userId: string): Promise<void> {
  await handle.db
    .updateTable('totp_secrets')
    .set({ confirmed_at: toInstant() })
    .where('user_id', '=', userId)
    .execute()
}

export async function insertOtpChallenge(
  handle: DatabaseHandle,
  options: { userId: string; codeHash: string; purpose: string; ttlMinutes: number },
): Promise<string> {
  const id = newId()
  // Only one live challenge per purpose: a new code invalidates the previous one, so a user
  // who requests two cannot be confused about which is valid.
  await handle.db
    .deleteFrom('email_otp_challenges')
    .where('user_id', '=', options.userId)
    .where('purpose', '=', options.purpose)
    .execute()
  await handle.db
    .insertInto('email_otp_challenges')
    .values({
      id,
      user_id: options.userId,
      code_hash: options.codeHash,
      purpose: options.purpose,
      attempts: 0,
      expires_at: instantIn(options.ttlMinutes * 60),
      consumed_at: null,
      created_at: toInstant(),
    })
    .execute()
  return id
}

export async function findLiveOtpChallenge(
  handle: DatabaseHandle,
  userId: string,
  purpose: string,
) {
  return handle.db
    .selectFrom('email_otp_challenges')
    .selectAll()
    .where('user_id', '=', userId)
    .where('purpose', '=', purpose)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', toInstant())
    .executeTakeFirst()
}

export async function recordOtpAttempt(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .updateTable('email_otp_challenges')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', id)
    .execute()
}

export async function consumeOtpChallenge(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .updateTable('email_otp_challenges')
    .set({ consumed_at: toInstant() })
    .where('id', '=', id)
    .execute()
}

export async function recordAudit(
  handle: DatabaseHandle,
  entry: {
    actorUserId?: string | null
    actorDeviceId?: string | null
    action: string
    subjectKind?: string | null
    subjectId?: string | null
  },
): Promise<void> {
  await handle.db
    .insertInto('audit_events')
    .values({
      id: newId(),
      actor_user_id: entry.actorUserId ?? null,
      actor_device_id: entry.actorDeviceId ?? null,
      action: entry.action,
      subject_kind: entry.subjectKind ?? null,
      subject_id: entry.subjectId ?? null,
      detail_cipher: null,
      created_at: toInstant(),
    })
    .execute()
}
