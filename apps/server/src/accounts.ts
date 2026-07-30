import { randomBytes } from 'node:crypto'
import {
  hashPassword,
  needsRehash,
  randomDigits,
  toBase64Url,
  verifyAgainstAbsentAccount,
  verifyPassword,
  type Argon2Params,
} from '@passvault/crypto'
import { toInstant, type DatabaseHandle } from '@passvault/db'
import { isLocale, type Locale } from '@passvault/i18n'
import type { ServerConfig } from './config.js'
import type { CryptoContext } from './crypto-context.js'
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from './errors.js'
import { sendLocalised, type Mailer } from './mailer.js'
import * as repo from './repository.js'
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js'
import { createVault, VaultCache, unlockVault } from './vault.js'

export const MINIMUM_PASSPHRASE_LENGTH = 8

const EMAIL_FIELD = (userId: string) => ({
  table: 'users',
  column: 'email_cipher',
  rowId: userId,
})

const TOTP_FIELD = (userId: string) => ({
  table: 'totp_secrets',
  column: 'secret_cipher',
  rowId: userId,
})

function encryptEmail(deps: AccountsDeps, userId: string, email: string): Uint8Array {
  return deps.crypto.encryptField(
    deps.crypto.serverKey(userId, 'email'),
    deps.crypto.normaliseEmail(email),
    EMAIL_FIELD(userId),
  )
}

/** Reads a user's address for delivery. Possible without the user present, by design. */
export function readEmail(deps: AccountsDeps, userId: string, stored: Uint8Array): string {
  return deps.crypto.decryptField(
    deps.crypto.serverKey(userId, 'email'),
    stored,
    EMAIL_FIELD(userId),
  )
}

export interface AccountsDeps {
  db: DatabaseHandle
  crypto: CryptoContext
  config: ServerConfig
  mailer: Mailer
  vaults: VaultCache
  /** Lowered in tests so Argon2id does not dominate the run. */
  argon2Params?: Argon2Params
  now?: () => number
}

export interface RegisterInput {
  email: string
  password?: string
  passphrase: string
  displayName?: string
  locale?: string
  invitationCode?: string
}

export interface RegisterResult {
  userId: string
  recoveryCode: string
}

/**
 * Registration in the four modes the product defines.
 *
 * The mode is read on every attempt rather than cached, because an administrator closing
 * registration expects it to take effect now, not after a restart.
 */
export async function register(deps: AccountsDeps, input: RegisterInput): Promise<RegisterResult> {
  const settings = await repo.readRegistrationSettings(deps.db)
  const emailKey = deps.crypto.emailIndex(input.email)

  switch (settings.mode) {
    case 'OPEN':
      break
    case 'WHITELIST':
      if (!(await repo.isWhitelisted(deps.db, emailKey))) {
        throw forbidden('registration.error.notWhitelisted')
      }
      break
    case 'INVITATION':
      await consumeInvitationFor(deps, input.invitationCode, emailKey)
      break
    case 'CLOSED':
      // The one exception: an installation with no users at all lets the first account
      // through and makes it the administrator. Otherwise a fresh instance is unusable
      // without editing the database, and the alternative — a default password — is worse.
      if ((await repo.countUsers(deps.db)) > 0) {
        throw forbidden('registration.error.closed')
      }
      break
  }

  return createAccount(deps, input, {
    isAdmin: settings.mode === 'CLOSED',
    status: 'ACTIVE',
  })
}

async function consumeInvitationFor(
  deps: AccountsDeps,
  code: string | undefined,
  emailKey: string,
): Promise<void> {
  if (!code) {
    throw forbidden('registration.error.invitationRequired')
  }
  const live = await repo.listLiveInvitations(deps.db)
  // Codes are stored as Argon2id hashes, so finding the matching one means verifying against
  // each live invitation. The set is small by nature — an invitation is short-lived and
  // created by hand — and the alternative, a lookup by plaintext code, would put the code
  // itself in the database.
  for (const invitation of live) {
    if (!(await verifyPassword(invitation.code_hash, code))) {
      continue
    }
    if (invitation.uses >= invitation.max_uses) {
      throw forbidden('registration.error.invitationUsedUp')
    }
    if (invitation.email_key !== null && invitation.email_key !== emailKey) {
      // Bound to somebody else's address. Reported as invalid rather than "wrong address",
      // which would confirm who it was for.
      throw forbidden('registration.error.invitationInvalid')
    }
    await repo.consumeInvitation(deps.db, invitation.id)
    return
  }
  throw forbidden('registration.error.invitationInvalid')
}

async function createAccount(
  deps: AccountsDeps,
  input: RegisterInput,
  options: { isAdmin: boolean; status: 'ACTIVE' | 'INVITED' },
): Promise<RegisterResult> {
  const emailKey = deps.crypto.emailIndex(input.email)
  if (await repo.findUserByEmailIndex(deps.db, emailKey)) {
    throw conflict('registration.error.emailInUse')
  }
  if (input.passphrase.length < MINIMUM_PASSPHRASE_LENGTH) {
    throw badRequest('vault.error.passphraseTooShort', { minimum: MINIMUM_PASSPHRASE_LENGTH })
  }

  const vault = await createVault(deps.crypto.masterKey, input.passphrase, deps.argon2Params)
  const locale: Locale =
    input.locale && isLocale(input.locale) ? input.locale : deps.config.defaultLocale

  const userId = await repo.insertUser(deps.db, {
    emailCipher: new Uint8Array(),
    emailKey,
    displayNameCipher: null,
    passwordHash: input.password ? await hashPassword(input.password, deps.argon2Params) : null,
    locale,
    isAdmin: options.isAdmin,
    status: options.status,
  })

  await deps.db.db
    .updateTable('users')
    .set({
      // Under a master-derived key rather than the user's, because the server has to read the
      // address to send mail when the user is not signed in. See CryptoContext.serverKey.
      email_cipher: Buffer.from(encryptEmail(deps, userId, input.email)),
      // The display name is real user data, so it stays under the user's own key.
      display_name_cipher: input.displayName
        ? Buffer.from(
            deps.crypto.encryptField(vault.dataKey, input.displayName, {
              table: 'users',
              column: 'display_name_cipher',
              rowId: userId,
            }),
          )
        : null,
      updated_at: toInstant(),
    })
    .where('id', '=', userId)
    .execute()

  await repo.saveUserKeys(deps.db, userId, vault.sealedEnvelope, true)
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: 'account.created',
    subjectKind: 'user',
    subjectId: userId,
  })

  return { userId, recoveryCode: vault.recoveryCode }
}

/**
 * An administrator creating an account, in either of the two forms the product defines.
 *
 * Option A sets an initial password the administrator chose. Option B sets none and returns a
 * one-time link so the user picks their own, which is the better default: it means the
 * administrator never knows the password, and there is no initial secret to communicate over
 * a channel neither of them controls.
 *
 * Both leave the vault passphrase unset. An administrator cannot choose it without being able
 * to read the user's data afterwards, which would defeat the entire key design.
 */
export async function adminCreateAccount(
  deps: AccountsDeps,
  input: {
    actorUserId: string
    email: string
    locale?: string
    initialPassword?: string
    setupTokenTtlHours?: number
  },
): Promise<{ userId: string; setupToken?: string }> {
  const emailKey = deps.crypto.emailIndex(input.email)
  if (await repo.findUserByEmailIndex(deps.db, emailKey)) {
    throw conflict('registration.error.emailInUse')
  }
  const locale: Locale =
    input.locale && isLocale(input.locale) ? input.locale : deps.config.defaultLocale

  const userId = await repo.insertUser(deps.db, {
    emailCipher: new Uint8Array(),
    emailKey,
    displayNameCipher: null,
    passwordHash: input.initialPassword
      ? await hashPassword(input.initialPassword, deps.argon2Params)
      : null,
    locale,
    isAdmin: false,
    // INVITED until the user has been through setup: the account exists but has no key
    // material, so it cannot hold anything yet.
    status: 'INVITED',
  })

  await deps.db.db
    .updateTable('users')
    .set({ email_cipher: Buffer.from(encryptEmail(deps, userId, input.email)) })
    .where('id', '=', userId)
    .execute()

  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: input.initialPassword ? 'account.created.with-password' : 'account.created.with-token',
    subjectKind: 'user',
    subjectId: userId,
  })

  if (input.initialPassword) {
    return { userId }
  }

  const setupToken = toBase64Url(new Uint8Array(randomBytes(32)))
  await repo.insertPasswordSetupToken(deps.db, {
    userId,
    tokenHash: repo.hashToken(setupToken),
    ttlHours: input.setupTokenTtlHours ?? 72,
  })
  await sendLocalised(deps.mailer, {
    to: deps.crypto.normaliseEmail(input.email),
    locale,
    subjectKey: 'registration.setupPassword.subject',
    bodyKey: 'registration.setupPassword.body',
    values: {
      link: `${deps.config.publicUrl}/set-password?token=${setupToken}`,
      expiresAt: new Date(Date.now() + (input.setupTokenTtlHours ?? 72) * 3_600_000),
    },
  })
  return { userId, setupToken }
}

/** Completes an administrator-created account: the user sets their password and passphrase. */
export async function completeSetup(
  deps: AccountsDeps,
  input: { token: string; password: string; passphrase: string; email: string },
): Promise<{ userId: string; recoveryCode: string }> {
  const setup = await repo.findLivePasswordSetupToken(deps.db, input.token)
  if (!setup) {
    throw badRequest('registration.error.setupTokenInvalid')
  }
  const user = await repo.findUserById(deps.db, setup.user_id)
  if (!user) {
    throw badRequest('registration.error.setupTokenInvalid')
  }
  if (user.email_key !== deps.crypto.emailIndex(input.email)) {
    // The token alone must not be enough to take over an account whose address the holder
    // does not know.
    throw badRequest('registration.error.setupTokenInvalid')
  }

  if (input.passphrase.length < MINIMUM_PASSPHRASE_LENGTH) {
    throw badRequest('vault.error.passphraseTooShort', { minimum: MINIMUM_PASSPHRASE_LENGTH })
  }
  const vault = await createVault(deps.crypto.masterKey, input.passphrase, deps.argon2Params)
  await repo.updatePasswordHash(
    deps.db,
    user.id,
    await hashPassword(input.password, deps.argon2Params),
  )
  await repo.saveUserKeys(deps.db, user.id, vault.sealedEnvelope, true)
  await repo.activateUser(deps.db, user.id)
  await repo.consumePasswordSetupToken(deps.db, setup.id)
  await repo.recordAudit(deps.db, {
    actorUserId: user.id,
    action: 'account.setup.completed',
    subjectKind: 'user',
    subjectId: user.id,
  })

  return { userId: user.id, recoveryCode: vault.recoveryCode }
}

export interface PendingLogin {
  userId: string
  methods: ('totp' | 'email')[]
  expiresAt: number
}

/**
 * Half-finished logins, waiting on a second factor.
 *
 * In memory rather than in a table, with the trade-off stated: a restart invalidates a login
 * in flight, and more than one instance needs a shared store. For a self-hosted single process
 * — which is what this is — a table would add a migration and a cleanup job to hold state that
 * is valid for five minutes.
 */
export class PendingLogins {
  private readonly entries = new Map<string, PendingLogin>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(userId: string, methods: ('totp' | 'email')[]): string {
    const token = toBase64Url(new Uint8Array(randomBytes(32)))
    this.entries.set(token, { userId, methods, expiresAt: this.now() + this.ttlMs })
    return token
  }

  take(token: string): PendingLogin | undefined {
    const entry = this.entries.get(token)
    if (!entry) {
      return undefined
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(token)
      return undefined
    }
    return entry
  }

  consume(token: string): void {
    this.entries.delete(token)
  }
}

export type LoginOutcome =
  | { status: 'complete'; token: string; sessionId: string; userId: string }
  | { status: 'second-factor'; challenge: string; methods: ('totp' | 'email')[] }

export async function loginWithPassword(
  deps: AccountsDeps & { pending: PendingLogins },
  input: { email: string; password: string; deviceId?: string },
): Promise<LoginOutcome> {
  const settings = await repo.readRegistrationSettings(deps.db)
  if (settings.allow_password_login === 0) {
    throw forbidden('auth.error.passwordLoginDisabled')
  }

  const user = await repo.findUserByEmailIndex(deps.db, deps.crypto.emailIndex(input.email))
  if (!user || !user.password_hash) {
    // The same work as a real verification, so response time does not distinguish an address
    // with an account from one without.
    await verifyAgainstAbsentAccount(input.password)
    throw unauthorized('auth.error.invalidCredentials')
  }
  if (user.status === 'SUSPENDED') {
    throw forbidden('auth.error.accountSuspended')
  }
  if (!(await verifyPassword(user.password_hash, input.password))) {
    throw unauthorized('auth.error.invalidCredentials')
  }
  if (needsRehash(user.password_hash, deps.argon2Params)) {
    // The password is in hand and known correct, which is the only moment it can be rehashed
    // at stronger parameters without asking the user for anything.
    await repo.updatePasswordHash(
      deps.db,
      user.id,
      await hashPassword(input.password, deps.argon2Params),
    )
  }

  const totp = await repo.findTotpSecret(deps.db, user.id)
  const methods: ('totp' | 'email')[] = []
  if (totp?.confirmed_at) {
    methods.push('totp')
  }
  if (settings.require_second_factor === 1 && methods.length === 0) {
    methods.push('email')
  }

  if (methods.length > 0) {
    const challenge = deps.pending.issue(user.id, methods)
    if (methods.includes('email')) {
      await sendEmailOtp(deps, user.id)
    }
    return { status: 'second-factor', challenge, methods }
  }

  return issueSession(deps, user.id, input.deviceId)
}

export async function sendEmailOtp(deps: AccountsDeps, userId: string): Promise<string> {
  const user = await repo.findUserById(deps.db, userId)
  if (!user) {
    throw unauthorized('auth.error.invalidCredentials')
  }
  const code = randomDigits(deps.config.otp.length)
  await repo.insertOtpChallenge(deps.db, {
    userId,
    // Argon2id on a six-digit code, because a leaked table of short codes would otherwise be
    // trivially reversible.
    codeHash: await hashPassword(code, deps.argon2Params),
    purpose: 'second_factor',
    ttlMinutes: deps.config.otp.ttlMinutes,
  })
  await sendLocalised(deps.mailer, {
    to: readEmail(deps, user.id, new Uint8Array(user.email_cipher)),
    locale: isLocale(user.locale) ? user.locale : deps.config.defaultLocale,
    subjectKey: 'auth.otp.subject',
    bodyKey: 'auth.otp.body',
    values: { code, minutes: deps.config.otp.ttlMinutes },
  })
  return code
}

export async function completeSecondFactor(
  deps: AccountsDeps & { pending: PendingLogins },
  input: { challenge: string; code: string; method: 'totp' | 'email'; deviceId?: string },
): Promise<LoginOutcome> {
  const pending = deps.pending.take(input.challenge)
  if (!pending) {
    throw unauthorized('auth.error.expiredOtp')
  }
  if (!pending.methods.includes(input.method)) {
    throw badRequest('auth.error.secondFactorRequired')
  }

  if (input.method === 'totp') {
    const secret = await repo.findTotpSecret(deps.db, pending.userId)
    if (!secret?.confirmed_at) {
      throw badRequest('auth.error.secondFactorRequired')
    }
    const plain = deps.crypto.decryptField(
      deps.crypto.serverKey(pending.userId, 'totp-secret'),
      new Uint8Array(secret.secret_cipher),
      TOTP_FIELD(pending.userId),
    )
    if (!verifyTotp(plain, input.code, deps.now?.() ?? Date.now())) {
      throw unauthorized('auth.error.invalidOtp')
    }
  } else {
    const challenge = await repo.findLiveOtpChallenge(deps.db, pending.userId, 'second_factor')
    if (!challenge) {
      throw unauthorized('auth.error.expiredOtp')
    }
    if (challenge.attempts >= deps.config.otp.maxAttempts) {
      throw tooManyRequests('auth.error.tooManyAttempts', { minutes: deps.config.otp.ttlMinutes })
    }
    await repo.recordOtpAttempt(deps.db, challenge.id)
    if (!(await verifyPassword(challenge.code_hash, input.code))) {
      throw unauthorized('auth.error.invalidOtp')
    }
    await repo.consumeOtpChallenge(deps.db, challenge.id)
  }

  deps.pending.consume(input.challenge)
  return issueSession(deps, pending.userId, input.deviceId)
}

/**
 * Starts TOTP enrolment.
 *
 * The secret is stored unconfirmed. An unconfirmed secret must never satisfy a second factor,
 * or an interrupted enrolment would lock the user out of their own account with a code they
 * never successfully scanned.
 */
export async function beginTotpEnrolment(
  deps: AccountsDeps,
  userId: string,
  accountName: string,
): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret()
  await repo.saveTotpSecret(
    deps.db,
    userId,
    deps.crypto.encryptField(
      deps.crypto.serverKey(userId, 'totp-secret'),
      secret,
      TOTP_FIELD(userId),
    ),
  )
  return { secret, uri: totpUri({ secret, accountName }) }
}

export async function confirmTotpEnrolment(
  deps: AccountsDeps,
  userId: string,
  code: string,
): Promise<void> {
  const stored = await repo.findTotpSecret(deps.db, userId)
  if (!stored) {
    throw badRequest('auth.error.secondFactorRequired')
  }
  const secret = deps.crypto.decryptField(
    deps.crypto.serverKey(userId, 'totp-secret'),
    new Uint8Array(stored.secret_cipher),
    TOTP_FIELD(userId),
  )
  if (!verifyTotp(secret, code, deps.now?.() ?? Date.now())) {
    throw unauthorized('auth.error.invalidOtp')
  }
  await repo.confirmTotpSecret(deps.db, userId)
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: 'totp.confirmed',
    subjectKind: 'user',
    subjectId: userId,
  })
}

async function issueSession(
  deps: AccountsDeps,
  userId: string,
  deviceId?: string,
): Promise<LoginOutcome> {
  const token = toBase64Url(new Uint8Array(randomBytes(32)))
  const session = await repo.insertSession(deps.db, {
    userId,
    token,
    deviceId: deviceId ?? null,
    idleMinutes: deps.config.session.idleMinutes,
    hardHours: deps.config.session.hardHours,
  })
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: 'session.created',
    subjectKind: 'session',
    subjectId: session.id,
  })
  return { status: 'complete', token, sessionId: session.id, userId }
}

/**
 * Unlocks the vault for a session.
 *
 * Separate from login on purpose. Signing in proves who you are; this decrypts your data, and
 * the two use different secrets — see docs/security.md for why federated login leaves no
 * password to derive a key from.
 */
export async function unlockSessionVault(
  deps: AccountsDeps,
  input: { sessionId: string; userId: string; passphrase: string },
): Promise<void> {
  const sealed = await repo.findUserKeys(deps.db, input.userId)
  if (!sealed) {
    throw badRequest('vault.error.notSet')
  }
  const dataKey = await unlockVault(deps.crypto.masterKey, sealed, input.passphrase)
  deps.vaults.unlock(input.sessionId, input.userId, dataKey)
  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    action: 'vault.unlocked',
    subjectKind: 'session',
    subjectId: input.sessionId,
  })
}
