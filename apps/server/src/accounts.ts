import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import {
  hashPassword,
  needsRehash,
  randomDigits,
  toBase64Url,
  verifyAgainstAbsentAccount,
  verifyPassword,
  type Argon2Params,
} from '@passvault/crypto'
import { newId, toInstant, type DatabaseHandle } from '@passvault/db'
import { isLocale, type Locale } from '@passvault/i18n'
import { adminSetupLinkFile, type ServerConfig } from './config.js'
import type { CryptoContext } from './crypto-context.js'
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from './errors.js'
import { sendLocalised, type Mailer } from './mailer.js'
import * as repo from './repository.js'
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js'
import { changePassphrase, createVault, VaultCache, unlockVault } from './vault.js'

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
    /** Null when the deployment file created it at boot and there is no administrator to name. */
    actorUserId: string | null
    email: string
    locale?: string
    initialPassword?: string
    isAdmin?: boolean
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
    isAdmin: input.isAdmin ?? false,
    // INVITED until the user has been through setup: the account exists but has no key
    // material, so it cannot hold anything yet. Setting a vault passphrase is what moves it
    // to ACTIVE, whichever of the two routes the user takes to get there.
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

  const setupToken = await sendPasswordSetupLink(deps, {
    userId,
    email: input.email,
    locale,
    ttlHours: input.setupTokenTtlHours ?? 72,
  })
  return { userId, setupToken }
}

/**
 * Mints a one-time link that lets somebody set their own password, and mails it.
 *
 * Shared by account creation, by the administration screen's "send the link again", and by the
 * bootstrap administrator an installation defines in its deployment file. One implementation
 * because the token's lifetime and the wording of the mail are the same fact in all three, and
 * because a second copy is how one of them ends up minting a token that never expires.
 *
 * The token is returned as well as sent: an installation with no SMTP server has no other way
 * to reach the user, and the caller decides whether to log it or show it.
 */
export async function sendPasswordSetupLink(
  deps: AccountsDeps,
  input: { userId: string; email: string; locale: Locale; ttlHours?: number },
): Promise<string> {
  const ttlHours = input.ttlHours ?? 72
  const setupToken = toBase64Url(new Uint8Array(randomBytes(32)))
  await repo.insertPasswordSetupToken(deps.db, {
    userId: input.userId,
    tokenHash: repo.hashToken(setupToken),
    ttlHours,
  })
  await sendLocalised(deps.mailer, {
    to: deps.crypto.normaliseEmail(input.email),
    locale: input.locale,
    subjectKey: 'registration.setupPassword.subject',
    bodyKey: 'registration.setupPassword.body',
    values: {
      link: setupUrl(deps, setupToken),
      expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
    },
  })
  return setupToken
}

/** The address of the set-a-password screen, in one place so the mail and the API agree. */
export const setupUrl = (deps: AccountsDeps, token: string): string =>
  `${deps.config.publicUrl}/set-password?token=${token}`

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

  if (await repo.findUserKeys(deps.db, user.id)) {
    // The account already has key material, so setup has been through once. Inserting a second
    // envelope violates the primary key, and what the user saw for that was a bare "something
    // went wrong" — the same wording as a crash, on a screen where the honest answer is that
    // this link has already been used.
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
  // The hint file exists only so somebody can find the link without the log. Once the link has
  // been redeemed it is a stale secret on disk, so it goes.
  rmSync(adminSetupLinkFile(deps.config), { force: true })
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
  input: { email: string; password: string; deviceId?: string; origin?: SessionOrigin },
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

  return issueSessionFor(deps, user.id, input.deviceId, input.origin)
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
  input: {
    challenge: string
    code: string
    method: 'totp' | 'email'
    deviceId?: string
    origin?: SessionOrigin
  },
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
  return issueSessionFor(deps, pending.userId, input.deviceId, input.origin)
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

/**
 * Mints a session.
 *
 * Exported so the passkey and provider flows end the same way a password login does. Three code
 * paths that each built their own session row is how one of them ends up missing the audit entry.
 */
export interface SessionOrigin {
  userAgent?: string | null
  ipAddress?: string | null
}

export async function issueSessionFor(
  deps: AccountsDeps,
  userId: string,
  deviceId?: string,
  origin?: SessionOrigin,
): Promise<LoginOutcome> {
  const token = toBase64Url(new Uint8Array(randomBytes(32)))
  // The administrator's chosen lifetime wins over the deployment default. Days rather than the
  // config's minutes/hours because the point of the setting is months: a personal ticket wallet
  // logged out every day is a wallet that asks for a password at the turnstile. When a long
  // lifetime is chosen the idle window is widened to match, so "lasts a year" is not quietly
  // undone by a thirty-minute inactivity timeout — the session slides forward as it is used.
  const settings = await repo.readRegistrationSettings(deps.db)
  const idleMinutes =
    settings.session_days != null
      ? settings.session_days * 24 * 60
      : deps.config.session.idleMinutes
  const hardHours =
    settings.session_days != null ? settings.session_days * 24 : deps.config.session.hardHours
  const session = await repo.insertSession(deps.db, {
    userId,
    token,
    deviceId: deviceId ?? null,
    idleMinutes,
    hardHours,
    // What opened the session and from where. The columns sat empty for a version because no
    // login path passed them, and every session listed as an unknown client from nowhere.
    userAgent: origin?.userAgent ?? null,
    ipAddress: origin?.ipAddress ?? null,
  })
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: 'session.created',
    subjectKind: 'session',
    subjectId: session.id,
  })
  return { status: 'complete', token, sessionId: session.id, userId }
}

export interface OidcLoginOutcome {
  login: LoginOutcome
  createdAccount: boolean
  /** True when the account has no vault yet, so the client must ask for a passphrase. */
  needsPassphrase: boolean
}

/**
 * Signing in through Google or Microsoft.
 *
 * Three paths, and the middle one is where account takeover lives:
 *
 *   1. The provider subject is already linked — sign in.
 *   2. It is not, but an account exists with that email address — link them, **only if the
 *      provider says the address is verified**. Without that check, anybody who can get a token
 *      from the provider carrying an unverified address of their choosing takes over the matching
 *      PassVault account. This is the classic OIDC account-linking vulnerability and the reason
 *      `email_verified` is not a nicety.
 *   3. Neither — a registration, subject to whichever mode the instance is in.
 *
 * The subject, not the address, is the join key. Addresses change hands; `sub` does not.
 */
export async function loginWithOidc(
  deps: AccountsDeps & { pending: PendingLogins },
  input: {
    provider: string
    subject: string
    email?: string
    emailVerified?: boolean
    displayName?: string
    invitationCode?: string
    origin?: SessionOrigin
    deviceId?: string
  },
): Promise<OidcLoginOutcome> {
  const existing = await deps.db.db
    .selectFrom('oidc_identities')
    .select('user_id')
    .where('provider', '=', input.provider)
    .where('subject', '=', input.subject)
    .executeTakeFirst()

  if (existing) {
    const user = await repo.findUserById(deps.db, existing.user_id)
    if (!user) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    if (user.status === 'SUSPENDED') {
      throw forbidden('auth.error.accountSuspended')
    }
    return {
      login: await issueSessionFor(deps, user.id, input.deviceId, input.origin),
      createdAccount: false,
      needsPassphrase: (await repo.findUserKeys(deps.db, user.id)) === undefined,
    }
  }

  if (!input.email) {
    // Without an address there is no way to place this identity, and creating an account with no
    // way to reach the user is worse than refusing.
    throw badRequest('registration.error.emailInUse')
  }

  const emailKey = deps.crypto.emailIndex(input.email)
  const byEmail = await repo.findUserByEmailIndex(deps.db, emailKey)

  if (byEmail) {
    if (input.emailVerified !== true) {
      throw forbidden('auth.error.invalidCredentials')
    }
    await linkIdentity(deps, byEmail.id, input.provider, input.subject)
    if (byEmail.status === 'INVITED') {
      // An administrator created the account and the user has now proved the address. Signing in
      // through a provider is a legitimate way to complete that.
      await repo.activateUser(deps.db, byEmail.id)
    }
    return {
      login: await issueSessionFor(deps, byEmail.id, input.deviceId, input.origin),
      createdAccount: false,
      needsPassphrase: (await repo.findUserKeys(deps.db, byEmail.id)) === undefined,
    }
  }

  const settings = await repo.readRegistrationSettings(deps.db)
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
      if ((await repo.countUsers(deps.db)) > 0) {
        throw forbidden('registration.error.closed')
      }
      break
  }

  const isFirstAccount = (await repo.countUsers(deps.db)) === 0
  const userId = await repo.insertUser(deps.db, {
    emailCipher: new Uint8Array(),
    emailKey,
    displayNameCipher: null,
    // No password: this account signs in through the provider. A vault passphrase is set
    // separately, which is exactly why the two secrets are separate.
    passwordHash: null,
    locale: deps.config.defaultLocale,
    isAdmin: isFirstAccount,
    status: 'ACTIVE',
  })
  await deps.db.db
    .updateTable('users')
    .set({ email_cipher: Buffer.from(encryptEmail(deps, userId, input.email)) })
    .where('id', '=', userId)
    .execute()
  await linkIdentity(deps, userId, input.provider, input.subject)
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: `account.created.${input.provider}`,
    subjectKind: 'user',
    subjectId: userId,
  })

  return {
    login: await issueSessionFor(deps, userId, input.deviceId, input.origin),
    createdAccount: true,
    needsPassphrase: true,
  }
}

async function linkIdentity(
  deps: AccountsDeps,
  userId: string,
  provider: string,
  subject: string,
): Promise<void> {
  await deps.db.db
    .insertInto('oidc_identities')
    .values({
      id: newId(),
      user_id: userId,
      provider,
      subject,
      created_at: toInstant(),
    })
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: userId,
    action: `identity.linked.${provider}`,
    subjectKind: 'user',
    subjectId: userId,
  })
}

/**
 * Sets a vault passphrase, or changes an existing one.
 *
 * The path that matters is the first one: an account created through a provider, a passkey or an
 * administrator has no vault at all until this is called. Until then it can sign in and see
 * nothing, which is the correct state rather than a bug — there is no key, so there is nothing to
 * decrypt.
 *
 * Changing an existing passphrase re-wraps the data key rather than re-encrypting anything, so it
 * is a single row update whatever the size of the wallet.
 */
export async function setVaultPassphrase(
  deps: AccountsDeps,
  input: {
    userId: string
    sessionId: string
    passphrase: string
    currentPassphrase?: string
  },
): Promise<{ created: boolean; recoveryCode?: string }> {
  if (input.passphrase.length < MINIMUM_PASSPHRASE_LENGTH) {
    throw badRequest('vault.error.passphraseTooShort', { minimum: MINIMUM_PASSPHRASE_LENGTH })
  }
  const existing = await repo.findUserKeys(deps.db, input.userId)

  if (!existing) {
    const vault = await createVault(deps.crypto.masterKey, input.passphrase, deps.argon2Params)
    await repo.saveUserKeys(deps.db, input.userId, vault.sealedEnvelope, true)
    // An account an administrator created sits at INVITED until it has key material. This is
    // the moment it acquires some, whether the user arrived through a setup link or signed in
    // with a password the administrator set and chose their passphrase afterwards.
    await repo.activateUser(deps.db, input.userId)
    deps.vaults.unlock(input.sessionId, input.userId, vault.dataKey)
    await repo.recordAudit(deps.db, {
      actorUserId: input.userId,
      action: 'vault.created',
      subjectKind: 'user',
      subjectId: input.userId,
    })
    return { created: true, recoveryCode: vault.recoveryCode }
  }

  if (!input.currentPassphrase) {
    // Changing a passphrase needs the old one. A session alone must not be enough, or a stolen
    // token would let somebody lock the owner out of their own data.
    throw badRequest('vault.passphraseRequired')
  }
  const resealed = await changePassphrase(
    deps.crypto.masterKey,
    existing,
    input.currentPassphrase,
    input.passphrase,
    deps.argon2Params,
  )
  await repo.replaceUserKeys(deps.db, input.userId, resealed)
  const dataKey = await unlockVault(deps.crypto.masterKey, resealed, input.passphrase)
  deps.vaults.unlock(input.sessionId, input.userId, dataKey)
  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    action: 'vault.passphrase.changed',
    subjectKind: 'user',
    subjectId: input.userId,
  })
  return { created: false }
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
