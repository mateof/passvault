import { randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { hashPassword, toBase64Url, type Argon2Params } from '@passvault/crypto'
import { migrateToLatest, newId, openDatabase, toInstant, type DatabaseHandle } from '@passvault/db'
import {
  createTranslator,
  resolveLocale,
  type Locale,
  type MessageKey,
  type MessageValues,
} from '@passvault/i18n'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import {
  PendingLogins,
  adminCreateAccount,
  beginTotpEnrolment,
  completeSecondFactor,
  completeSetup,
  confirmTotpEnrolment,
  loginWithOidc,
  loginWithPassword,
  readEmail,
  register,
  setVaultPassphrase,
  unlockSessionVault,
  type AccountsDeps,
} from './accounts.js'
import {
  addWhitelistEntry,
  changeUser,
  listInvitations,
  listUsers,
  listWhitelist,
  resendSetupLink,
} from './administration.js'
import { applyBootstrap } from './bootstrap.js'
import { loadConfig, type ServerConfig } from './config.js'
import { CryptoContext } from './crypto-context.js'
import {
  INGEST_LIMITS,
  IngestError,
  createPdfJsRasterizer,
  detectMediaType,
  propose,
  type IngestErrorCode,
  type PageRasterizer,
} from '@passvault/ingest'
import { TkpakError, type DocumentMediaType } from '@passvault/tkpak'

/**
 * Ingestion failures mapped onto message keys.
 *
 * Written out rather than derived from the code, because the codes and the catalogue keys are
 * separate vocabularies on purpose: the code is a stable API contract and the wording is free to
 * change. An exhaustive record means adding a code without a message fails the build.
 */
const INGEST_MESSAGE_KEYS: Record<IngestErrorCode, MessageKey> = {
  UNSUPPORTED_FILE: 'ingest.error.unsupportedFile',
  FILE_TOO_LARGE: 'ingest.error.fileTooLarge',
  ENCRYPTED_PDF: 'ingest.error.encryptedPdf',
  DAMAGED_FILE: 'ingest.error.damagedFile',
  TOO_MANY_PAGES: 'ingest.error.fileTooLarge',
  PKPASS_SIGNATURE_INVALID: 'ingest.error.pkpassSignatureInvalid',
  PKPASS_MALFORMED: 'ingest.error.damagedFile',
  RASTERIZER_UNAVAILABLE: 'error.unexpected',
}
import { readBlob, storeBlob } from './blobs.js'
import { assertHandle, findPerson, requirePerson, setHandle } from './directory.js'
import {
  acceptInvitation,
  declineInvitation,
  invite,
  listInvitations as listEventInvitations,
  withdrawInvitations,
} from './invitations.js'
import { countUnread, listNotices, markRead } from './notifications.js'
import { listSessions, revokeOtherSessions, revokeSession } from './sessions.js'
import {
  TAG_COLOURS,
  createTag,
  deleteTag,
  listTags,
  setEventTags,
  tagsByEvent,
  updateTag,
} from './tags.js'
import { AppError, badRequest, forbidden, notFound, unauthorized } from './errors.js'
import {
  addMember,
  createGroup,
  deleteGroup,
  listGroups,
  listMembers,
  removeMember,
  renameGroup,
} from './groups.js'
import { exportEvent, importArchive, inspectArchive, type TransferDeps } from './transfer.js'
import {
  EVENT_COLOURS,
  EVENT_ICONS,
  createEvent,
  findEvent,
  grantAccess,
  listAccess,
  hasAccess,
  listEventDocuments,
  listEventsForUser,
  openEventKey,
  projectEvent,
  revokeAccess,
  setEventAppearance,
  suggestEventCover,
  type EventDeps,
} from './events.js'
import {
  adoptEventFromLog,
  listQuarantined,
  nextLamport,
  pullOperations,
  pushOperations,
  recordOperation,
  registerDevice,
} from './operations.js'
import {
  addTickets,
  assignTicket,
  claimFreeTicket,
  ensureDevice,
  issueClaimCoupons,
  projectTickets,
  reconcileTicket,
  setPayment,
  submitClaim,
  withdrawTicket,
} from './tickets.js'
import { createMailer, type Mailer } from './mailer.js'
import * as repo from './repository.js'
import {
  OidcClient,
  OidcFlows,
  createPkcePair,
  newNonce,
  providerSettings,
  type OidcFetcher,
  type OidcProviderName,
} from './oidc.js'
import { VaultCache } from './vault.js'
import {
  WebAuthnChallenges,
  beginPasskeyLogin,
  beginPasskeyRegistration,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  listCredentials,
  removeCredential,
} from './webauthn.js'

/**
 * Says what is wrong with a request body, in the user's language.
 *
 * The two secrets get their own wording because they are the two fields a user actually gets
 * wrong, and "too_small on password" is not something to put in front of anybody. Everything
 * else falls back to a generic message: the field paths are an API contract in English, and
 * translating every one of them would be a second catalogue that drifts from the first.
 */
function validationMessage(error: z.ZodError): { key: MessageKey; values?: MessageValues } {
  for (const issue of error.issues) {
    if (issue.code !== 'too_small') {
      continue
    }
    const field = issue.path.at(-1)
    if (field === 'passphrase') {
      return {
        key: 'vault.error.passphraseTooShort',
        values: { minimum: Number(issue.minimum) },
      }
    }
    if (field === 'password') {
      return { key: 'auth.error.passwordTooShort', values: { minimum: Number(issue.minimum) } }
    }
  }
  return { key: 'error.validation' }
}

export interface BuildOptions {
  config?: ServerConfig
  mailer?: Mailer
  /** Lowered in tests so Argon2id does not dominate the run. */
  argon2Params?: Argon2Params
  logger?: boolean
  /** Injected so the provider flow can be exercised without a network. */
  oidcFetcher?: OidcFetcher
}

export interface PassVaultServer {
  app: FastifyInstance
  db: DatabaseHandle
  config: ServerConfig
  vaults: VaultCache
  close: () => Promise<void>
}

declare module 'fastify' {
  interface FastifyRequest {
    locale: Locale
    session?: repo.SessionRow
  }
}

export async function buildServer(options: BuildOptions = {}): Promise<PassVaultServer> {
  const config = options.config ?? loadConfig()
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 * 1024 })

  const db = await openDatabase(config.databaseUrl)
  await migrateToLatest(db)

  const crypto = CryptoContext.fromConfig(config)
  const vaults = new VaultCache({
    idleMinutes: config.session.idleMinutes,
    hardHours: config.session.hardHours,
  })
  const mailer = options.mailer ?? createMailer(config, (message) => app.log.warn(message))
  const pending = new PendingLogins()

  const deps: AccountsDeps & { pending: PendingLogins } = {
    db,
    crypto,
    config,
    mailer,
    vaults,
    pending,
    ...(options.argon2Params ? { argon2Params: options.argon2Params } : {}),
  }

  // What the deployment file asked for — an administrator, a registration mode, an allow list —
  // applied before the first request rather than left for somebody to do through a browser.
  const bootstrapped = await applyBootstrap(deps)
  for (const note of bootstrapped.notes) {
    app.log.info(note)
  }
  for (const warning of bootstrapped.warnings) {
    app.log.warn(warning)
  }

  if (config.generatedSecrets.length > 0) {
    app.log.warn(
      `Generated encryption keys in ${config.generatedSecrets.join(', ')}. Move them into ` +
        'MASTER_KEY and BLIND_INDEX_KEY and delete the file: while it sits beside the database, ' +
        'anybody who copies the data directory has both the ciphertext and the key.',
    )
  }

  // Expired keys are swept on a timer rather than only when a session is next used, so an
  // abandoned session does not keep its key in memory until the process restarts.
  const sweeper = setInterval(() => vaults.sweep(), 60_000)
  sweeper.unref()

  app.addHook('onRequest', async (request) => {
    request.locale = resolveLocale({ acceptLanguage: request.headers['accept-language'] ?? null })
  })

  app.setErrorHandler((error, request, reply) => {
    const { t } = createTranslator(request.locale)
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: error.messageKey,
        message: t(error.messageKey, error.values),
      })
    }
    // Errors raised by the packages carry their own codes, and every one of those codes has a
    // translated message. Letting them fall through to the generic handler would waste that and
    // report "something went wrong" for a wrong password.
    if (error instanceof TkpakError) {
      const key = `tkpak.error.${error.code}` as MessageKey
      return reply
        .status(error.code === 'WRONG_PASSWORD' ? 401 : 400)
        .send({ error: key, message: t(key) })
    }
    if (error instanceof IngestError) {
      const key = INGEST_MESSAGE_KEYS[error.code]
      return reply.status(400).send({
        error: key,
        message: t(key, { maxMegabytes: Math.floor(INGEST_LIMITS.fileBytes / 1024 / 1024) }),
      })
    }
    if (error instanceof z.ZodError) {
      // Reported as what it is. This said "an unexpected error occurred" — the wording reserved
      // for a crash — so a password one character short of the rule read to the user as the
      // server being broken, on a screen that had never told them the rule in the first place.
      const { key, values } = validationMessage(error)
      return reply.status(400).send({
        error: 'validation',
        message: t(key, values),
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      })
    }
    // Anything unrecognised is logged in full and reported as a generic failure: an internal
    // message can carry a query, a path or a key fragment, and none of that belongs in a
    // response.
    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({ error: 'unexpected', message: t('error.unexpected') })
  })

  await app.register(fastifyCookie)

  /**
   * The session, kept where a refresh does not lose it.
   *
   * The browser used to hold its token in a JavaScript variable, on the reasoning that local
   * storage is readable by any injected script. The reasoning was half right and the conclusion
   * was wrong: a script injected into a single-page application can read a variable in a module
   * closure just as easily, and can simply make requests as the user in either case. What it
   * bought was not safety — it was a session that ended every time somebody pressed F5, taking
   * the open vault with it and asking for two secrets again.
   *
   * An httpOnly cookie is what actually helps: script cannot read it at all, so a token cannot be
   * exfiltrated and used somewhere else later. `sameSite: lax` is what keeps that from trading an
   * exfiltration risk for a cross-site request one — a form on another site cannot make the
   * browser attach this to a POST.
   *
   * `secure` follows the public URL rather than being hard-coded: a cookie marked secure is never
   * sent over http, so hard-coding it would silently break every installation reached at
   * http://nas.local — which is the ordinary case on a home network.
   */
  const SESSION_COOKIE = 'passvault_session'
  const secureCookies = config.publicUrl.startsWith('https://')

  const setSessionCookie = (reply: FastifyReply, token: string): void => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
      // Matched to the session's own hard expiry. A cookie that outlives the row it names is a
      // browser that thinks it is signed in and a server that disagrees on every request.
      maxAge: config.session.hardHours * 3600,
    })
  }

  const clearSessionCookie = (reply: FastifyReply): void => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
  }

  const sessionOf = async (request: FastifyRequest): Promise<repo.SessionRow> => {
    const header = request.headers.authorization
    // The header first, because that is what the Android app sends and it is explicit. The cookie
    // is the browser's, and is never the only thing a client has to think about.
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : request.cookies[SESSION_COOKIE]
    if (!token) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const session = await repo.findLiveSession(db, token)
    if (!session) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    await repo.touchSession(db, session.id, config.session.idleMinutes)
    request.session = session
    return session
  }

  const adminOf = async (request: FastifyRequest): Promise<repo.SessionRow> => {
    const session = await sessionOf(request)
    const user = await repo.findUserById(db, session.user_id)
    if (!user || user.is_admin !== 1) {
      throw forbidden()
    }
    return session
  }

  /**
   * The web interface, served by the same process that serves the API.
   *
   * One origin for both, which is not a convenience: the browser's WebAuthn ceremony is bound
   * to an origin, and a front end on a different host than its API would need CORS, a second
   * certificate and a second name for the same installation. It also means `PUBLIC_URL` is the
   * whole answer to "where is PassVault", which is what the phone, the tunnel and the relying
   * party identifier all read.
   *
   * Absent in development, where Vite serves the front end and proxies here — so a missing
   * bundle is normal and must not stop the server. It is only fatal when somebody expected a
   * web interface and got a 404, which is exactly what happened the first time this was
   * deployed, and the log line below is what would have said so.
   */
  const webRoot = resolve(
    process.env.WEB_ROOT ??
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'),
  )
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false })
    // Anything that is not the API and not a file falls through to the application, because a
    // single-page front end owns its own routes: /events/x is a screen, not a missing file.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found' })
      }
      return reply.sendFile('index.html')
    })
    app.log.info(`serving the web interface from ${webRoot}`)
  } else {
    app.log.warn(
      `no web interface at ${webRoot}: the API answers but the root will be 404. ` +
        'Build it with `npm run build --workspace @passvault/web` or set WEB_ROOT.',
    )
  }

  /**
   * Digital asset links, which is what makes a passkey work in the Android app.
   *
   * A passkey is bound to an origin. The app is not a browser, so Android has to be told that this
   * package, signed with this certificate, speaks for this domain — and the only place it will
   * look is `https://<domain>/.well-known/assetlinks.json`. Without it the credential manager
   * refuses before showing anything, which reads to the user as the fingerprint sensor being
   * broken.
   *
   * Served from a file rather than generated, because the certificate fingerprint in it comes from
   * a keystore this process has never seen and must not.
   */
  app.get('/.well-known/assetlinks.json', async (request, reply) => {
    // The same path the WebAuthn origins are derived from, so the file that grants the app
    // access and the file that is served can never be two different files.
    if (!existsSync(config.assetLinksFile)) {
      return reply.status(404).send({ error: 'not_found' })
    }
    return reply.type('application/json').send(readFileSync(config.assetLinksFile, 'utf8'))
  })

  app.get('/api/v1/health', async () => ({ status: 'ok' }))

  app.get('/api/v1/registration/settings', async () => {
    const settings = await repo.readRegistrationSettings(db)
    const userCount = await repo.countUsers(db)
    return {
      mode: settings.mode,
      allowPasswordLogin: settings.allow_password_login === 1,
      requireSecondFactor: settings.require_second_factor === 1,
      // A closed instance with no users still accepts the first account, which becomes the
      // administrator. Advertised so a client can show the right screen instead of a refusal.
      acceptingFirstAdmin: settings.mode === 'CLOSED' && userCount === 0,
    }
  })

  const registerBody = z.object({
    email: z.string().email(),
    password: z.string().min(10).optional(),
    passphrase: z.string().min(8),
    displayName: z.string().min(1).max(120).optional(),
    locale: z.string().optional(),
    invitationCode: z.string().optional(),
  })

  app.post('/api/v1/registration', async (request, reply) => {
    const body = registerBody.parse(request.body)
    const result = await register(deps, body)
    // The recovery code is returned exactly once and never recoverable afterwards. The client
    // has to show it and say so.
    return reply.status(201).send({
      userId: result.userId,
      recoveryCode: result.recoveryCode,
      recoveryCodeWarning: createTranslator(request.locale).t('vault.warning.noRecovery'),
    })
  })

  const completeSetupBody = z.object({
    token: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(10),
    passphrase: z.string().min(8),
  })

  app.post('/api/v1/registration/complete-setup', async (request) => {
    const body = completeSetupBody.parse(request.body)
    const result = await completeSetup(deps, body)
    return {
      userId: result.userId,
      recoveryCode: result.recoveryCode,
      recoveryCodeWarning: createTranslator(request.locale).t('vault.warning.noRecovery'),
    }
  })

  const loginBody = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/auth/login', async (request, reply) => {
    const outcome = await loginWithPassword(deps, loginBody.parse(request.body))
    if (outcome.status !== 'complete') {
      return { status: outcome.status, challenge: outcome.challenge, methods: outcome.methods }
    }
    setSessionCookie(reply, outcome.token)
    return { status: outcome.status, token: outcome.token, userId: outcome.userId }
  })

  const secondFactorBody = z.object({
    challenge: z.string().min(1),
    code: z.string().min(1),
    method: z.enum(['totp', 'email']),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/auth/second-factor', async (request, reply) => {
    const outcome = await completeSecondFactor(deps, secondFactorBody.parse(request.body))
    if (outcome.status !== 'complete') {
      throw unauthorized('auth.error.secondFactorRequired')
    }
    setSessionCookie(reply, outcome.token)
    return { status: outcome.status, token: outcome.token, userId: outcome.userId }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await sessionOf(request)
    vaults.evict(session.id)
    await repo.revokeSession(db, session.id)
    // Both, or signing out leaves a browser holding a cookie for a session that no longer
    // exists — which reads as being signed in until the first request fails.
    clearSessionCookie(reply)
    return reply.status(204).send()
  })

  app.get('/api/v1/me', async (request) => {
    const session = await sessionOf(request)
    const user = await repo.findUserById(db, session.user_id)
    if (!user) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const vault = vaults.get(session.id)
    return {
      userId: user.id,
      locale: user.locale,
      isAdmin: user.is_admin === 1,
      status: user.status,
      // Whether the vault is open is part of the session state a client needs, since almost
      // every other endpoint depends on it.
      vaultUnlocked: vault !== undefined,
      // And whether there is a vault at all, which is a different question with a different
      // screen behind it. An account created by an administrator, by a provider or by a passkey
      // has none until its owner chooses a passphrase, and asking such a user to "unlock" is
      // asking for a secret that does not exist yet.
      vaultConfigured: (await repo.findUserKeys(db, user.id)) !== undefined,
    }
  })

  const unlockBody = z.object({ passphrase: z.string().min(1) })

  app.post('/api/v1/vault/unlock', async (request) => {
    const session = await sessionOf(request)
    await unlockSessionVault(deps, {
      sessionId: session.id,
      userId: session.user_id,
      passphrase: unlockBody.parse(request.body).passphrase,
    })
    return { vaultUnlocked: true }
  })

  app.post('/api/v1/vault/lock', async (request) => {
    const session = await sessionOf(request)
    vaults.evict(session.id)
    return { vaultUnlocked: false }
  })

  app.post('/api/v1/totp/enrol', async (request) => {
    const session = await sessionOf(request)
    const user = await repo.findUserById(db, session.user_id)
    if (!user) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    // Named by address rather than by identifier. This is the label an authenticator shows in a
    // list of a dozen accounts, and "PassVault (019fb9a3-55e8-…)" tells its owner nothing about
    // which account it is for. The server can read the address without the user present — that is
    // what the master-derived key is for — and it is the user's own.
    return beginTotpEnrolment(
      deps,
      session.user_id,
      user.email_cipher.length > 0
        ? readEmail(deps, user.id, new Uint8Array(user.email_cipher))
        : user.id,
    )
  })

  const totpConfirmBody = z.object({ code: z.string().min(6).max(8) })

  app.post('/api/v1/totp/confirm', async (request) => {
    const session = await sessionOf(request)
    await confirmTotpEnrolment(deps, session.user_id, totpConfirmBody.parse(request.body).code)
    return { confirmed: true }
  })

  const settingsBody = z.object({
    mode: z.enum(['OPEN', 'WHITELIST', 'INVITATION', 'CLOSED']).optional(),
    allowPasswordLogin: z.boolean().optional(),
    requireSecondFactor: z.boolean().optional(),
  })

  app.put('/api/v1/admin/registration', async (request) => {
    const session = await adminOf(request)
    const body = settingsBody.parse(request.body)
    await repo.writeRegistrationSettings(db, { ...body, updatedBy: session.user_id })
    const settings = await repo.readRegistrationSettings(db)
    return {
      mode: settings.mode,
      allowPasswordLogin: settings.allow_password_login === 1,
      requireSecondFactor: settings.require_second_factor === 1,
      // Whether the environment will overwrite this on the next restart is part of the answer:
      // an administrator who changes a setting that a deployment file re-applies at boot needs
      // to know that now, not after the container is next recreated.
      enforcedByEnvironment: config.bootstrap.enforce,
    }
  })

  app.get('/api/v1/admin/users', async (request) => {
    await adminOf(request)
    return { users: await listUsers(deps) }
  })

  const userChangeBody = z.object({
    isAdmin: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })

  app.patch('/api/v1/admin/users/:id', async (request) => {
    const session = await adminOf(request)
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const body = userChangeBody.parse(request.body)
    return changeUser(deps, { actorUserId: session.user_id, userId: id, ...body })
  })

  app.post('/api/v1/admin/users/:id/setup-link', async (request) => {
    const session = await adminOf(request)
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    return resendSetupLink(deps, { actorUserId: session.user_id, userId: id })
  })

  const whitelistBody = z.object({ email: z.string().email() })

  app.get('/api/v1/admin/whitelist', async (request) => {
    await adminOf(request)
    return { entries: await listWhitelist(deps) }
  })

  app.post('/api/v1/admin/whitelist', async (request, reply) => {
    const session = await adminOf(request)
    const { email } = whitelistBody.parse(request.body)
    const entry = await addWhitelistEntry(deps, { email, addedBy: session.user_id })
    return reply.status(201).send(entry)
  })

  app.delete('/api/v1/admin/whitelist/:id', async (request, reply) => {
    const session = await adminOf(request)
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    await repo.removeFromWhitelist(db, id)
    await repo.recordAudit(db, {
      actorUserId: session.user_id,
      action: 'whitelist.removed',
      subjectKind: 'whitelist',
      subjectId: id,
    })
    return reply.status(204).send()
  })

  const invitationBody = z.object({
    email: z.string().email().optional(),
    maxUses: z.number().int().min(1).max(100).default(1),
    ttlHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(72),
  })

  app.post('/api/v1/admin/invitations', async (request, reply) => {
    const session = await adminOf(request)
    const body = invitationBody.parse(request.body)
    const code = toBase64Url(new Uint8Array(randomBytes(16)))
    const id = await repo.insertInvitation(db, {
      codeHash: await hashPassword(code, options.argon2Params),
      emailKey: body.email ? crypto.emailIndex(body.email) : null,
      createdBy: session.user_id,
      maxUses: body.maxUses,
      ttlHours: body.ttlHours,
    })
    // The code appears once, here. Only its hash is stored, so it cannot be shown again.
    return reply.status(201).send({
      invitationId: id,
      code,
      url: `${config.publicUrl}/register?invitation=${code}`,
    })
  })

  app.get('/api/v1/admin/invitations', async (request) => {
    await adminOf(request)
    return { invitations: await listInvitations(deps) }
  })

  app.delete('/api/v1/admin/invitations/:id', async (request, reply) => {
    const session = await adminOf(request)
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    await repo.revokeInvitation(db, id)
    await repo.recordAudit(db, {
      actorUserId: session.user_id,
      action: 'invitation.revoked',
      subjectKind: 'invitation',
      subjectId: id,
    })
    return reply.status(204).send()
  })

  const adminUserBody = z.object({
    email: z.string().email(),
    locale: z.string().optional(),
    initialPassword: z.string().min(10).optional(),
    isAdmin: z.boolean().optional(),
  })

  app.post('/api/v1/admin/users', async (request, reply) => {
    const session = await adminOf(request)
    const body = adminUserBody.parse(request.body)
    const created = await adminCreateAccount(deps, { actorUserId: session.user_id, ...body })
    return reply.status(201).send({
      userId: created.userId,
      // Option B returns a link; option A returns nothing, because the administrator already
      // knows the password they chose.
      ...(created.setupToken
        ? { setupUrl: `${config.publicUrl}/set-password?token=${created.setupToken}` }
        : {}),
    })
  })

  // ── Delegated sign-in and passkeys ────────────────────────────────────────────

  const oidcClients = new Map<OidcProviderName, OidcClient>()
  for (const name of ['google', 'microsoft'] as const) {
    const credentials = config.oidc[name]
    if (credentials) {
      oidcClients.set(
        name,
        new OidcClient(name, providerSettings(name, credentials), options.oidcFetcher),
      )
    }
  }
  const oidcFlows = new OidcFlows()
  const challenges = new WebAuthnChallenges()
  const webAuthnDeps = { ...deps, challenges }

  /** What a provider is called on a button. Not derived from the key, which is an identifier. */
  const PROVIDER_NAMES: Record<OidcProviderName, string> = {
    google: 'Google',
    microsoft: 'Microsoft',
  }

  app.get('/api/v1/auth/providers', async () => ({
    // So a client knows which buttons to show rather than offering a provider this instance has
    // no credentials for. An identifier *and* a name: this answered with bare strings, so every
    // client that rendered a button rendered an empty one pointing at `undefined`.
    providers: [...oidcClients.keys()].map((id) => ({ id, name: PROVIDER_NAMES[id] })),
    passkeys: true,
  }))

  const providerParams = z.object({ provider: z.enum(['google', 'microsoft']) })
  const startBody = z.object({
    redirectUri: z.string().url(),
    invitationCode: z.string().optional(),
  })

  app.post('/api/v1/auth/oidc/:provider/start', async (request) => {
    const { provider } = providerParams.parse(request.params)
    const client = oidcClients.get(provider)
    if (!client) {
      throw notFound()
    }
    const body = startBody.parse(request.body)
    const pkce = createPkcePair()
    const nonce = newNonce()
    const state = oidcFlows.start({
      provider,
      verifier: pkce.verifier,
      nonce,
      redirectUri: body.redirectUri,
      ...(body.invitationCode ? { invitationCode: body.invitationCode } : {}),
    })
    return {
      state,
      authorizationUrl: await client.authorizationUrl({
        redirectUri: body.redirectUri,
        state,
        nonce,
        challenge: pkce.challenge,
      }),
    }
  })

  const callbackBody = z.object({
    state: z.string().min(1),
    code: z.string().min(1),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/auth/oidc/callback', async (request, reply) => {
    const body = callbackBody.parse(request.body)
    // Single use, and unknown state is refused. This is what stops a callback being replayed or
    // forged from another site.
    const flow = oidcFlows.take(body.state)
    if (!flow) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const client = oidcClients.get(flow.provider)
    if (!client) {
      throw notFound()
    }
    const claims = await client.exchangeCode({
      code: body.code,
      verifier: flow.verifier,
      redirectUri: flow.redirectUri,
      nonce: flow.nonce,
    })
    const outcome = await loginWithOidc(deps, {
      provider: flow.provider,
      subject: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.email_verified === undefined ? {} : { emailVerified: claims.email_verified }),
      ...(claims.name ? { displayName: claims.name } : {}),
      ...(flow.invitationCode ? { invitationCode: flow.invitationCode } : {}),
      ...(body.deviceId ? { deviceId: body.deviceId } : {}),
    })
    if (outcome.login.status !== 'complete') {
      throw unauthorized('auth.error.secondFactorRequired')
    }
    setSessionCookie(reply, outcome.login.token)
    return {
      status: 'complete',
      token: outcome.login.token,
      userId: outcome.login.userId,
      createdAccount: outcome.createdAccount,
      // Signing in through a provider proves who you are and decrypts nothing. The client has to
      // ask for a passphrase before showing a wallet.
      needsPassphrase: outcome.needsPassphrase,
    }
  })

  const passphraseBody = z.object({
    passphrase: z.string().min(1),
    currentPassphrase: z.string().min(1).optional(),
  })

  app.post('/api/v1/vault/passphrase', async (request) => {
    const session = await sessionOf(request)
    const body = passphraseBody.parse(request.body)
    const result = await setVaultPassphrase(deps, {
      userId: session.user_id,
      sessionId: session.id,
      passphrase: body.passphrase,
      ...(body.currentPassphrase ? { currentPassphrase: body.currentPassphrase } : {}),
    })
    return {
      created: result.created,
      ...(result.recoveryCode
        ? {
            recoveryCode: result.recoveryCode,
            recoveryCodeWarning: createTranslator(request.locale).t('vault.warning.noRecovery'),
          }
        : {}),
      vaultUnlocked: true,
    }
  })

  app.post('/api/v1/passkeys/register/options', async (request) => {
    const session = await sessionOf(request)
    return beginPasskeyRegistration(webAuthnDeps, session.user_id)
  })

  const passkeyRegisterBody = z.object({
    response: z.unknown(),
    name: z.string().max(120).optional(),
  })

  app.post('/api/v1/passkeys/register', async (request, reply) => {
    const session = await sessionOf(request)
    const body = passkeyRegisterBody.parse(request.body)
    const result = await finishPasskeyRegistration(webAuthnDeps, {
      userId: session.user_id,
      response: body.response,
      ...(body.name ? { name: body.name } : {}),
    })
    return reply.status(201).send(result)
  })

  app.post('/api/v1/passkeys/login/options', async () => beginPasskeyLogin(webAuthnDeps))

  const passkeyLoginBody = z.object({
    response: z.unknown(),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/passkeys/login', async (request, reply) => {
    const body = passkeyLoginBody.parse(request.body)
    const outcome = await finishPasskeyLogin(webAuthnDeps, {
      response: body.response,
      ...(body.deviceId ? { deviceId: body.deviceId } : {}),
    })
    if (outcome.status !== 'complete') {
      throw unauthorized('auth.error.secondFactorRequired')
    }
    setSessionCookie(reply, outcome.token)
    return {
      status: outcome.status,
      token: outcome.token,
      userId: outcome.userId,
      needsPassphrase: outcome.needsPassphrase,
    }
  })

  app.get('/api/v1/passkeys', async (request) => {
    const session = await sessionOf(request)
    const credentials = await listCredentials(webAuthnDeps, session.user_id)
    return {
      passkeys: credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        backedUp: credential.backed_up === 1,
        createdAt: credential.created_at,
        lastUsedAt: credential.last_used_at,
      })),
    }
  })

  app.delete('/api/v1/passkeys/:id', async (request, reply) => {
    const session = await sessionOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await removeCredential(webAuthnDeps, {
      userId: session.user_id,
      credentialRowId: id,
    })
    return reply.status(204).send()
  })

  // ── Events and tickets ────────────────────────────────────────────────────────

  const eventDeps: EventDeps = {
    db,
    crypto,
    vaults,
    ...(options.argon2Params ? { argon2Params: options.argon2Params } : {}),
  }

  // The directory looks people up by address as well as by handle, and the blind index is what
  // makes an encrypted address searchable. Passed in rather than reached for, so the module
  // never has to know how an address is indexed.
  const directoryDeps = { ...eventDeps, emailIndex: (email: string) => crypto.emailIndex(email) }

  /** Every ticket operation needs the event key, which needs an unlocked vault first. */
  const openEvent = async (
    request: FastifyRequest,
    eventId: string,
    password?: string,
  ): Promise<{ session: repo.SessionRow; eventKey: Uint8Array }> => {
    const session = await sessionOf(request)
    const eventKey = await openEventKey(eventDeps, {
      eventId,
      sessionId: session.id,
      userId: session.user_id,
      ...(password ? { password } : {}),
    })
    return { session, eventKey }
  }

  /**
   * The ceiling for a picture of an event.
   *
   * Generous for a poster and far below the ingestion limit, because this one is decrypted and
   * sent on every screen that lists events — a twenty-megabyte cover would make the wallet
   * unusable long before it made the disk full.
   */
  const MAXIMUM_IMAGE_BYTES = 4 * 1024 * 1024

  /**
   * The ceiling for a document a client uploads whole.
   *
   * Half the body limit rather than all of it, which is the difference between a refusal and a
   * severed connection: Fastify rejects an oversized body before any handler runs, so a ceiling
   * set at the limit could never produce the sentence saying how big a file may be.
   */
  const MAXIMUM_DOCUMENT_BYTES = 32 * 1024 * 1024

  const createEventBody = z.object({
    name: z.string().min(1).max(200),
    venue: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    startsAt: z.string().datetime().optional(),
    timeZone: z.string().max(64).optional(),
    defaultAssignmentMode: z.enum(['OPEN', 'ASSIGNED', 'SELF_CLAIM']).optional(),
    password: z.string().min(4).optional(),
    icon: z.enum(EVENT_ICONS).optional(),
    colour: z.enum(EVENT_COLOURS).optional(),
  })

  app.post('/api/v1/events', async (request, reply) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    const body = createEventBody.parse(request.body)
    const created = await createEvent(eventDeps, {
      creatorUserId: session.user_id,
      creatorDataKey: vault.dataKey,
      ...body,
    })
    vaults.unlockEvent(session.id, created.eventId, created.eventKey)
    // Written down as it happens. The log is the record of what the event is, not a channel other
    // devices push into — a phone that synchronises an event created here has to receive it.
    await recordOperation(eventDeps, {
      eventId: created.eventId,
      eventKey: created.eventKey,
      actorUserId: session.user_id,
      type: 'event.create',
      body: {
        name: body.name,
        ...(body.venue ? { venue: body.venue } : {}),
        ...(body.startsAt ? { startsAt: body.startsAt } : {}),
      },
    })
    return reply.status(201).send({
      eventId: created.eventId,
      passwordProtected: created.passwordProtected,
      // Said plainly rather than buried: without a password the operator of this instance can
      // read the tickets.
      readableByServer: !created.passwordProtected,
    })
  })

  /**
   * The events this user can reach.
   *
   * Names only what is readable without an event key: an event's own name is ciphertext under
   * that key, so a list cannot show it until the event is opened. The client shows what it has
   * and fetches the rest per event, which is the same shape the encryption already forces on
   * every other screen.
   */
  app.get('/api/v1/events', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const events = await listEventsForUser(eventDeps, session.user_id)
    // One query for the whole wallet rather than one per event: a list of twelve events would
    // otherwise be thirteen round trips to draw twelve coloured dots.
    const tagged = await tagsByEvent(eventDeps, { ownerUserId: session.user_id })
    return {
      events: events.map((event) => ({ ...event, tagIds: tagged.get(event.id) ?? [] })),
    }
  })

  const eventParams = z.object({ id: z.string().uuid() })
  const openBody = z.object({ password: z.string().min(1).optional() })

  app.post('/api/v1/events/:id/open', async (request) => {
    const { id } = eventParams.parse(request.params)
    const { password } = openBody.parse(request.body ?? {})
    const { session, eventKey } = await openEvent(request, id, password)
    const event = await findEvent(eventDeps, id)
    if (!event) {
      throw notFound()
    }
    return projectEvent(eventDeps, event, eventKey, session.user_id)
  })

  app.get('/api/v1/events/:id', async (request) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    const event = await findEvent(eventDeps, id)
    if (!event) {
      throw notFound()
    }
    // The reader's own labels, not the creator's: a label is what an event is to whoever is
    // looking at it, and two people looking at the same event see their own vocabulary.
    const tagged = await tagsByEvent(eventDeps, { ownerUserId: session.user_id })
    return {
      ...projectEvent(eventDeps, event, eventKey, session.user_id),
      tagIds: tagged.get(id) ?? [],
    }
  })

  const appearanceBody = z.object({
    icon: z.enum(EVENT_ICONS).optional(),
    colour: z.enum(EVENT_COLOURS).optional(),
  })

  app.patch('/api/v1/events/:id', async (request) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    await setEventAppearance(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      ...appearanceBody.parse(request.body ?? {}),
    })
    const { eventKey } = await openEvent(request, id)
    const event = await findEvent(eventDeps, id)
    if (!event) {
      throw notFound()
    }
    return projectEvent(eventDeps, event, eventKey, session.user_id)
  })

  /**
   * A picture of the event, uploaded as raw bytes.
   *
   * Encrypted under the event key like every other document, because a poster carries a name, a
   * date and often a seat. That is also why it is fetched through the API rather than served as
   * a static file: there is no readable copy anywhere to serve.
   */
  app.post('/api/v1/events/:id/image', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    const bytes = asBytes(request.body)
    if (bytes.byteLength > MAXIMUM_IMAGE_BYTES) {
      throw badRequest('ingest.error.fileTooLarge', {
        maxMegabytes: Math.floor(MAXIMUM_IMAGE_BYTES / 1024 / 1024),
      })
    }
    const mediaType = detectMediaType(bytes)
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') {
      throw badRequest('ingest.error.unsupportedFile')
    }
    const stored = await storeBlob(transferDeps, { eventId: id, eventKey, mediaType, bytes })
    await setEventAppearance(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      imageBlobId: stored.id,
    })
    return reply.status(201).send({ imageId: stored.id })
  })

  app.delete('/api/v1/events/:id/image', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    // The blob itself is left on disk rather than unlinked. It is encrypted, it may be the
    // source document of a ticket, and a delete that walks references is how a ticket loses
    // its page because somebody changed a picture.
    await setEventAppearance(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      imageBlobId: null,
    })
    return reply.status(204).send()
  })

  app.get('/api/v1/events/:id/image', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { eventKey } = await openEvent(request, id)
    const event = await findEvent(eventDeps, id)
    if (!event?.image_blob_id) {
      throw notFound()
    }
    const blob = await readBlob(transferDeps, { blobId: event.image_blob_id, eventKey })
    return (
      reply
        .header('content-type', blob.mediaType)
        // Private: it is decrypted per session, and a shared cache holding it would be a copy
        // outside the event key entirely.
        .header('cache-control', 'private, max-age=300')
        .send(Buffer.from(blob.bytes))
    )
  })

  app.get('/api/v1/events/:id/documents', async (request) => {
    const { id } = eventParams.parse(request.params)
    await openEvent(request, id)
    return { documents: await listEventDocuments(eventDeps, id) }
  })

  /**
   * A document a client already holds, uploaded whole.
   *
   * The synchronisation protocol carries a signed log of what happened to an event — it created
   * tickets, it assigned them, it paid for them — and a thirty-megabyte PDF is none of those
   * things. So a wallet built on a phone from a PDF synchronised its tickets and left the file
   * behind, and the event on the server had no original at all: exactly the pages ingestion drops
   * on purpose, missing from the one place a second device would go looking for them.
   *
   * Under the identifier the client already uses, which is what makes it idempotent: a phone that
   * synchronises every day uploads its PDF once and finds it there afterwards. That is also why
   * this is a PUT — the client names the resource, and saying it twice says the same thing.
   *
   * Only the creator may upload one. Anyone the event is shared with can read the original; the
   * question of what the original *is* belongs to whoever brought the tickets, in the same way
   * adding tickets does.
   */
  app.put('/api/v1/events/:id/documents/:documentId', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params)
    const pages = z
      .object({ pages: z.coerce.number().int().positive().max(10_000).optional() })
      .parse(request.query ?? {}).pages
    const { session, eventKey } = await openEvent(request, id)

    const event = await findEvent(eventDeps, id)
    if (!event) {
      throw notFound()
    }
    if (event.creator_user_id !== session.user_id) {
      throw forbidden('event.error.notCreator')
    }

    const existing = await db.db
      .selectFrom('blobs')
      .select(['id', 'event_id'])
      .where('id', '=', documentId)
      .executeTakeFirst()
    if (existing) {
      // Already here. Not an error and not a second copy: the same identifier means the same
      // document, which is the whole reason the client gets to choose it.
      if (existing.event_id !== id) {
        throw badRequest('ingest.error.unsupportedFile')
      }
      return reply.status(200).send({ documentId, stored: false })
    }

    const bytes = asBytes(request.body)
    if (bytes.byteLength > MAXIMUM_DOCUMENT_BYTES) {
      throw badRequest('ingest.error.fileTooLarge', {
        maxMegabytes: Math.floor(MAXIMUM_DOCUMENT_BYTES / 1024 / 1024),
      })
    }
    const mediaType = detectMediaType(bytes)
    const stored = await storeBlob(transferDeps, {
      id: documentId,
      eventId: id,
      eventKey,
      mediaType,
      bytes,
    })

    // A batch row beside it, so the file has the same provenance as one this server split itself
    // and the listing has somewhere to read a page count from. The split happened on the phone,
    // which is why nothing was detected here.
    await db.db
      .insertInto('ingest_batches')
      .values({
        id: newId(),
        event_id: id,
        created_by: session.user_id,
        source_media_type: mediaTypeCode(mediaType),
        source_blob_id: stored.id,
        page_count: pages ?? null,
        detected_count: null,
        state: 'CONFIRMED',
        failure_reason: null,
        created_at: toInstant(),
        updated_at: toInstant(),
      })
      .execute()

    return reply.status(201).send({ documentId: stored.id, stored: true })
  })

  app.get('/api/v1/events/:id/documents/:documentId', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params)
    const { eventKey } = await openEvent(request, id)
    // Checked against this event's own documents rather than fetched by id alone, or the
    // identifier of any blob on the installation would be enough to read it.
    const documents = await listEventDocuments(eventDeps, id)
    if (!documents.some((document) => document.id === documentId)) {
      throw notFound()
    }
    const blob = await readBlob(transferDeps, { blobId: documentId, eventKey })
    return reply
      .header('content-type', blob.mediaType)
      .header('content-disposition', `inline; filename="${documentId}"`)
      .send(Buffer.from(blob.bytes))
  })

  /**
   * The sessions open on this account.
   *
   * Somebody who leaves a phone in a taxi has one useful question — which of these is it, and how
   * do I end it — and until now the answer was to wait for it to expire.
   */
  app.get('/api/v1/sessions', async (request) => {
    const session = await sessionOf(request)
    return {
      sessions: await listSessions(eventDeps, {
        userId: session.user_id,
        currentSessionId: session.id,
      }),
    }
  })

  app.delete('/api/v1/sessions/:id', async (request) => {
    const session = await sessionOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await revokeSession(eventDeps, { userId: session.user_id, sessionId: id })
    return { revoked: true }
  })

  /** Everything except this one, which is what somebody does after losing a device. */
  app.post('/api/v1/sessions/revoke-others', async (request) => {
    const session = await sessionOf(request)
    const revoked = await revokeOtherSessions(eventDeps, {
      userId: session.user_id,
      keepSessionId: session.id,
    })
    return { revoked }
  })

  /**
   * A public name to be found by.
   *
   * Claimed rather than assigned, checked for collisions, and optional: an account without one
   * is shared with by address exactly as before.
   */
  app.put('/api/v1/me/handle', async (request) => {
    const session = await sessionOf(request)
    const body = z.object({ handle: z.string().min(3).max(32) }).parse(request.body)
    return setHandle(eventDeps, { userId: session.user_id, handle: body.handle })
  })

  /** Whether a handle is free, so the field can say so before anybody presses anything. */
  app.get('/api/v1/directory/handle', async (request) => {
    await sessionOf(request)
    const { handle } = z.object({ handle: z.string().min(1).max(32) }).parse(request.query)
    const normalised = assertHandle(handle)
    const found = await findPerson(directoryDeps, { handle: normalised })
    return { handle: normalised, taken: found !== undefined, userId: found?.userId }
  })

  // ── Labels ───────────────────────────────────────────────────────────────────

  const tagBody = z.object({
    name: z.string().min(1).max(60).optional(),
    colour: z.enum(TAG_COLOURS).optional(),
  })

  app.get('/api/v1/tags', async (request) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    return { tags: await listTags(eventDeps, { ownerUserId: session.user_id, dataKey: vault.dataKey }) }
  })

  app.post('/api/v1/tags', async (request, reply) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    const body = z
      .object({ name: z.string().min(1).max(60), colour: z.enum(TAG_COLOURS).optional() })
      .parse(request.body)
    const created = await createTag(eventDeps, {
      ownerUserId: session.user_id,
      dataKey: vault.dataKey,
      name: body.name,
      colour: body.colour ?? 'violet',
    })
    return reply.status(201).send(created)
  })

  app.patch('/api/v1/tags/:id', async (request) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = tagBody.parse(request.body ?? {})
    await updateTag(eventDeps, {
      tagId: id,
      ownerUserId: session.user_id,
      dataKey: vault.dataKey,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.colour === undefined ? {} : { colour: body.colour }),
    })
    return { updated: true }
  })

  app.delete('/api/v1/tags/:id', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await deleteTag(eventDeps, { tagId: id, ownerUserId: session.user_id })
    return { deleted: true }
  })

  /** Which labels an event carries, for the person whose labels they are. */
  app.put('/api/v1/events/:id/tags', async (request) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    const body = z.object({ tagIds: z.array(z.string().uuid()).max(20) }).parse(request.body)
    await setEventTags(eventDeps, {
      eventId: id,
      ownerUserId: session.user_id,
      tagIds: body.tagIds,
    })
    return { tagIds: body.tagIds }
  })

  // ── Notices and invitations ──────────────────────────────────────────────────

  app.get('/api/v1/notifications', async (request) => {
    const session = await sessionOf(request)
    const query = z.object({ unread: z.coerce.boolean().optional() }).parse(request.query ?? {})
    return {
      notifications: await listNotices(eventDeps, {
        userId: session.user_id,
        ...(query.unread ? { unreadOnly: true } : {}),
      }),
      unread: await countUnread(eventDeps, session.user_id),
    }
  })

  app.post('/api/v1/notifications/read', async (request) => {
    const session = await sessionOf(request)
    const body = z.object({ id: z.string().uuid().optional() }).parse(request.body ?? {})
    await markRead(eventDeps, {
      userId: session.user_id,
      ...(body.id ? { noticeId: body.id } : {}),
    })
    return { read: true }
  })

  /** What this account has been offered and has not answered. */
  app.get('/api/v1/invitations', async (request) => {
    const session = await sessionOf(request)
    const query = z.object({ pending: z.coerce.boolean().optional() }).parse(request.query ?? {})
    return {
      invitations: await listEventInvitations(eventDeps, {
        userId: session.user_id,
        ...(query.pending === false ? {} : { pendingOnly: true }),
      }),
    }
  })

  /**
   * Says yes, which is what grants the access.
   *
   * The password goes here rather than at the moment of sharing, because it is the recipient who
   * has to type it and this is the first moment they are present.
   */
  app.post('/api/v1/invitations/:id/accept', async (request) => {
    const session = await sessionOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ password: z.string().optional() }).parse(request.body ?? {})
    return acceptInvitation(eventDeps, {
      invitationId: id,
      userId: session.user_id,
      sessionId: session.id,
      ...(body.password ? { password: body.password } : {}),
      openEvent: async (eventId, password) => {
        await openEventKey(eventDeps, {
          eventId,
          sessionId: session.id,
          userId: session.user_id,
          ...(password ? { password } : {}),
        })
      },
    })
  })

  app.post('/api/v1/invitations/:id/decline', async (request) => {
    const session = await sessionOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await declineInvitation(eventDeps, { invitationId: id, userId: session.user_id })
    return { declined: true }
  })

  const groupBody = z.object({ name: z.string().min(1).max(120) })
  const groupParams = z.object({ id: z.string().uuid() })
  const memberBody = z.object({ email: z.string().email() })

  /**
   * Groups, which the schema has always had and nothing could create.
   *
   * Sharing an event with "the family" needed a family to exist; without these endpoints every
   * share had to name individuals one at a time, and the same four addresses had to be typed
   * again for every concert.
   */
  app.post('/api/v1/groups', async (request, reply) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    const body = groupBody.parse(request.body)
    const created = await createGroup(eventDeps, {
      ownerUserId: session.user_id,
      ownerDataKey: vault.dataKey,
      name: body.name,
    })
    return reply.status(201).send(created)
  })

  app.get('/api/v1/groups', async (request) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    return {
      groups: await listGroups(eventDeps, {
        userId: session.user_id,
        dataKey: vault.dataKey,
      }),
    }
  })

  app.get('/api/v1/groups/:id/members', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = groupParams.parse(request.params)
    return { members: await listMembers(eventDeps, { groupId: id, actorUserId: session.user_id }) }
  })

  app.post('/api/v1/groups/:id/members', async (request, reply) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = groupParams.parse(request.params)
    const body = memberBody.parse(request.body)
    const added = await addMember(eventDeps, {
      groupId: id,
      actorUserId: session.user_id,
      email: body.email,
    })
    return reply.status(201).send(added)
  })

  /**
   * Renames a group, which until now meant building a new one and re-sharing every event.
   */
  app.patch('/api/v1/groups/:id', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = groupParams.parse(request.params)
    await renameGroup(eventDeps, {
      groupId: id,
      actorUserId: session.user_id,
      name: groupBody.parse(request.body).name,
    })
    return { renamed: true }
  })

  /**
   * Deletes one, and closes every event it was opening.
   *
   * The owner alone. Access granted through the group goes with it — a circle that no longer
   * exists must not still be letting people in, which is usually the reason it is being deleted.
   */
  app.delete('/api/v1/groups/:id', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = groupParams.parse(request.params)
    await deleteGroup(eventDeps, { groupId: id, actorUserId: session.user_id })
    return { deleted: true }
  })

  /**
   * Whether an address belongs to an account here.
   *
   * So that "add this person" can say *before* submitting that nobody on this server uses that
   * address — a typo in an email is otherwise discovered when a friend never sees the ticket.
   *
   * Answers yes or no and never more: no name, no identifier that was not asked for by address.
   * It is an existence oracle, which is why it needs a session — on an invitation-only server
   * that means it is answerable by people who were let in on purpose, and no one else.
   */
  app.get('/api/v1/directory/lookup', async (request) => {
    await sessionOf(request)
    const { email } = z.object({ email: z.string().email() }).parse(request.query)
    const user = await repo.findUserByEmailIndex(db, crypto.emailIndex(email))
    return {
      email,
      exists: user !== undefined && user.status === 'ACTIVE',
      ...(user && user.status === 'ACTIVE' ? { userId: user.id } : {}),
    }
  })

  app.delete('/api/v1/groups/:id/members/:userId', async (request) => {
    const session = await sessionOf(request)
    vaults.require(session.id)
    const { id } = groupParams.parse(request.params)
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    await removeMember(eventDeps, { groupId: id, actorUserId: session.user_id, userId })
    return { removed: true }
  })

  /**
   * Who to share with, named the way the person sharing thinks of them.
   *
   * A group by identifier, because that is what a picker returns. A person by *address*, because
   * nobody knows anybody's user identifier — the first version accepted only a UUID for both,
   * which made "share with Ana" impossible from any interface a human uses.
   */
  const accessBody = z
    .object({
      subjectKind: z.enum(['GROUP', 'USER']),
      subjectId: z.string().uuid().optional(),
      email: z.string().email().optional(),
      handle: z.string().min(3).max(32).optional(),
      role: z.enum(['ORGANISER', 'MEMBER']).optional(),
    })
    .refine(
      (body) =>
        body.subjectId !== undefined || body.email !== undefined || body.handle !== undefined,
      { message: 'subjectId, email or handle is required' },
    )

  /** Resolves whichever way the caller named somebody into the identifier the tables store. */
  const subjectOf = async (body: z.infer<typeof accessBody>): Promise<string> => {
    if (body.subjectKind === 'USER') {
      // Said plainly rather than accepted and quietly dropped. A share that goes nowhere is
      // discovered when a friend never sees the ticket, which is far too late.
      return requirePerson(directoryDeps, {
        ...(body.subjectId ? { userId: body.subjectId } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.handle ? { handle: body.handle } : {}),
      })
    }
    if (!body.subjectId) {
      throw badRequest('groups.error.unknownUser')
    }
    return body.subjectId
  }

  /**
   * Everybody an invitation reaches, which for a group is everybody in it.
   *
   * A group cannot answer a question, so the invitation is written per person. Somebody joining
   * the group later is not invited retroactively — which matches what the group screen already
   * says about sharing, and is the honest behaviour: they were not in the circle when it was
   * offered.
   */
  const membersOf = async (subjectKind: string, subjectId: string): Promise<string[]> => {
    if (subjectKind === 'USER') {
      return [subjectId]
    }
    const rows = await db.db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', subjectId)
      .where('status', '=', 'ACTIVE')
      .execute()
    return rows.map((row) => row.user_id)
  }

  /**
   * Offers an event to a group or a person.
   *
   * An offer, not a grant. Access used to begin the moment somebody shared, so an event appeared
   * in a wallet without its owner having agreed to hold something that carries a friend's name,
   * their seat and sometimes what they paid — and with nowhere to be told about it, so it was
   * invisible until they happened to look.
   *
   * Now everybody it reaches gets an invitation and a notice, and access begins when they accept.
   * The event password is typed then, by the person who has to type it, at the first moment they
   * are present.
   *
   * The creator is never invited to their own event: they already hold it.
   */
  app.post('/api/v1/events/:id/access', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    const body = accessBody.parse(request.body)
    const subjectId = await subjectOf(body)

    const event = await findEvent(eventDeps, id)
    if (!event) {
      throw notFound()
    }
    if (event.creator_user_id !== session.user_id) {
      throw forbidden('event.error.notCreator')
    }

    // A group is recorded as an offer to the whole circle — that is what the creator shared
    // with and what they can take back. A person gets no access row here at all: theirs is
    // written when they accept, so the list shows them as offered rather than as holding
    // something they never agreed to.
    if (body.subjectKind === 'GROUP') {
      await grantAccess(eventDeps, {
        eventId: id,
        actorUserId: session.user_id,
        subjectKind: 'GROUP',
        subjectId,
        ...(body.role ? { role: body.role } : {}),
      })
    }

    // The name, decrypted here because this is where the key is. A notice cannot carry a
    // ciphertext its reader has no key for.
    const projected = await projectEvent(eventDeps, event, eventKey, session.user_id)
    const inviterName = (await repo.findUserById(db, session.user_id))?.handle ?? ''

    let invited = 0
    for (const userId of await membersOf(body.subjectKind, subjectId)) {
      if (userId === event.creator_user_id) {
        continue
      }
      const outcome = await invite(eventDeps, {
        eventId: id,
        userId,
        invitedBy: session.user_id,
        ...(body.subjectKind === 'GROUP' ? { viaGroupId: subjectId } : {}),
        eventName: projected.name,
        inviterName,
      })
      if (!outcome.alreadyInvited) {
        invited += 1
      }
    }

    return reply.status(201).send({ granted: true, invited })
  })

  /** What the creator granted, so sharing is something they can look at rather than only do. */
  app.get('/api/v1/events/:id/access', async (request) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    return { access: await listAccess(eventDeps, { eventId: id, actorUserId: session.user_id }) }
  })

  app.delete('/api/v1/events/:id/access', async (request) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    const body = accessBody.parse(request.body)
    const subjectId = await subjectOf(body)
    await revokeAccess(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      subjectKind: body.subjectKind,
      subjectId,
    })
    // And the invitation, or an event stays offered to somebody it was taken away from.
    await withdrawInvitations(eventDeps, {
      eventId: id,
      ...(body.subjectKind === 'USER' ? { userId: subjectId } : { viaGroupId: subjectId }),
    })
    // Named for what it does. It stops future access; it does not recall a file already sent.
    return { revoked: true, recallsDeliveredTickets: false }
  })

  const ticketsBody = z.object({
    password: z.string().optional(),
    tickets: z
      .array(
        z.object({
          label: z.string().max(200).optional(),
          section: z.string().max(100).optional(),
          row: z.string().max(20).optional(),
          seat: z.string().max(20).optional(),
          barcode: z
            .object({
              format: z.enum([
                'QR_CODE',
                'AZTEC',
                'PDF_417',
                'CODE_128',
                'CODE_39',
                'EAN_13',
                'DATA_MATRIX',
              ]),
              value: z.string().min(1).max(4096),
            })
            .optional(),
          assignmentMode: z.enum(['OPEN', 'ASSIGNED', 'SELF_CLAIM']).optional(),
        }),
      )
      .min(1)
      .max(512),
  })

  app.post('/api/v1/events/:id/tickets', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const body = ticketsBody.parse(request.body)
    const { session, eventKey } = await openEvent(request, id, body.password)
    const ids = await addTickets(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      eventKey,
      tickets: body.tickets,
    })
    // One operation per ticket rather than one for the batch: a ticket is the unit that gets
    // assigned, claimed and paid for, so it is the unit the log has to name.
    for (const [index, ticketId] of ids.entries()) {
      const ticket = body.tickets[index]
      await recordOperation(eventDeps, {
        eventId: id,
        eventKey,
        actorUserId: session.user_id,
        type: 'ticket.add',
        body: {
          ticketId,
          ...(ticket?.label ? { label: ticket.label } : {}),
          ...(ticket?.seat ? { seat: ticket.seat } : {}),
          ...(ticket?.barcode
            ? { barcodeFormat: ticket.barcode.format, barcodeValue: ticket.barcode.value }
            : {}),
        },
      })
    }
    return reply.status(201).send({ ticketIds: ids })
  })

  app.get('/api/v1/events/:id/tickets', async (request) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    return {
      tickets: await projectTickets(eventDeps, {
        eventId: id,
        viewerUserId: session.user_id,
        eventKey,
      }),
    }
  })

  const ticketParams = z.object({ id: z.string().uuid() })

  const assignBody = z.object({
    holderUserId: z.string().uuid().optional(),
    holderLabel: z.string().min(1).max(120).optional(),
  })

  app.post('/api/v1/tickets/:id/assign', async (request) => {
    const { id } = ticketParams.parse(request.params)
    const session = await sessionOf(request)
    const ticket = await db.db
      .selectFrom('tickets')
      .select('event_id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!ticket) {
      throw notFound()
    }
    const { eventKey } = await openEvent(request, ticket.event_id)
    await assignTicket(eventDeps, {
      ticketId: id,
      actorUserId: session.user_id,
      eventKey,
      ...assignBody.parse(request.body),
    })
    return { assigned: true }
  })

  /**
   * Takes a free ticket, for people the event was shared with.
   *
   * The online half of self-claim. `POST /tickets/:id/claim` needs a coupon because it is built
   * for a phone that was offline when it decided; somebody looking at the event in front of them
   * needs no permission slip, only a seat that is still free.
   */
  app.post('/api/v1/events/:id/claim', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    const claimed = await claimFreeTicket(eventDeps, {
      eventId: id,
      userId: session.user_id,
      eventKey,
    })
    return reply.status(201).send(claimed)
  })

  const couponsBody = z.object({ allowance: z.number().int().min(1).max(20).optional() })

  app.post('/api/v1/events/:id/coupons', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    const coupons = await issueClaimCoupons(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      ...couponsBody.parse(request.body ?? {}),
    })
    // Coupons appear once. Only their hashes are stored, so they cannot be listed again.
    return reply.status(201).send({ coupons })
  })

  const claimBody = z.object({
    coupon: z.string().min(1),
    deviceId: z.string().uuid().optional(),
    lamport: z.number().int().min(0).optional(),
    operationId: z.string().uuid().optional(),
    /** False when replaying a claim made offline, so a batch is reconciled once at the end. */
    reconcile: z.boolean().optional(),
  })

  app.post('/api/v1/tickets/:id/claim', async (request) => {
    const { id } = ticketParams.parse(request.params)
    const session = await sessionOf(request)
    const body = claimBody.parse(request.body)
    const deviceId = await ensureDevice(eventDeps, {
      userId: session.user_id,
      ...(body.deviceId ? { deviceId: body.deviceId } : {}),
    })
    const requestId = await submitClaim(eventDeps, {
      ticketId: id,
      userId: session.user_id,
      deviceId,
      coupon: body.coupon,
      lamport: body.lamport ?? 1,
      ...(body.operationId ? { operationId: body.operationId } : {}),
    })

    if (body.reconcile === false) {
      // Provisional, and reported as such. The interface must not present this as settled.
      return { requestId, state: 'PROVISIONAL' }
    }
    const outcome = await reconcileTicket(eventDeps, id)
    return {
      requestId,
      state:
        outcome.confirmed?.requestId === requestId
          ? 'CLAIMED'
          : (outcome.rejected.find((entry) => entry.requestId === requestId)?.reason ?? 'PENDING'),
      reconciliation: outcome,
    }
  })

  app.post('/api/v1/tickets/:id/reconcile', async (request) => {
    const { id } = ticketParams.parse(request.params)
    await sessionOf(request)
    return reconcileTicket(eventDeps, id)
  })

  const paymentBody = z.object({
    state: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'WAIVED']),
    amountCents: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    visibility: z.enum(['ALL', 'HOLDER_ONLY', 'CREATOR_ONLY']),
  })

  app.post('/api/v1/tickets/:id/payment', async (request) => {
    const { id } = ticketParams.parse(request.params)
    const session = await sessionOf(request)
    await setPayment(eventDeps, {
      ticketId: id,
      actorUserId: session.user_id,
      ...paymentBody.parse(request.body),
    })
    return { recorded: true }
  })

  app.post('/api/v1/tickets/:id/withdraw', async (request) => {
    const { id } = ticketParams.parse(request.params)
    const session = await sessionOf(request)
    await withdrawTicket(eventDeps, { ticketId: id, actorUserId: session.user_id })
    return { withdrawn: true, recallsDeliveredTickets: false }
  })

  // ── Devices and the operation log ─────────────────────────────────────────────

  const deviceBody = z.object({
    name: z.string().min(1).max(120),
    signingPublicKey: z.string().min(1),
    agreementPublicKey: z.string().min(1),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/devices', async (request, reply) => {
    const session = await sessionOf(request)
    const result = await registerDevice(eventDeps, {
      userId: session.user_id,
      ...deviceBody.parse(request.body),
    })
    return reply.status(201).send(result)
  })

  const operationSchema = z.object({
    operationId: z.string().uuid(),
    deviceId: z.string().uuid(),
    actorUserId: z.string().uuid().nullable().optional(),
    lamport: z.number().int().min(0),
    wallClock: z.string().min(1),
    scope: z.object({ kind: z.literal('event'), id: z.string().uuid() }),
    type: z.string().min(1).max(48),
    body: z.record(z.unknown()),
    signature: z.string().min(1),
  })

  const syncBody = z.object({
    operations: z.array(operationSchema).max(500).default([]),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    eventPassword: z.string().optional(),
  })

  /**
   * One endpoint for both directions.
   *
   * Push and pull in a single round trip because that is what a phone on a slow connection wants,
   * and because the ordering matters: what the caller sends is applied before what it receives is
   * computed, so it never gets back a view that predates its own contribution.
   */
  app.post('/api/v1/sync/:id', async (request) => {
    const { id } = eventParams.parse(request.params)
    const body = syncBody.parse(request.body ?? {})

    // An event that only exists on a phone is created here first, from the `event.create` its own
    // log carries. Without this the call below fails with "no such event" and a wallet built
    // offline — which is how this product is meant to be used — can never reach a server at all.
    const session = await sessionOf(request)
    const adopting = await adoptEventFromLog(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      creatorDataKey: vaults.require(session.id).dataKey,
      operations: body.operations,
      ...(body.eventPassword ? { password: body.eventPassword } : {}),
    })

    const { eventKey } = await openEvent(request, id, body.eventPassword)

    const push = await pushOperations(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      eventKey,
      operations: body.operations,
    })
    const pull = await pullOperations(eventDeps, {
      eventId: id,
      actorUserId: session.user_id,
      eventKey,
      ...(body.cursor ? { cursor: body.cursor } : {}),
      ...(body.limit ? { limit: body.limit } : {}),
    })

    return {
      accepted: push.outcomes,
      reconciled: push.reconciled,
      operations: pull.operations,
      cursor: pull.cursor,
      hasMore: pull.hasMore,
      // So a device that has been offline does not guess and lose every race on reconnection.
      nextLamport: await nextLamport(eventDeps, id),
      // Told plainly, because it is the difference between "your event is now on the server" and
      // "your event was already there", and the client says one of those two things to the user.
      created: adopting.adopted,
    }
  })

  app.get('/api/v1/sync/:id/quarantine', async (request) => {
    const { id } = eventParams.parse(request.params)
    const session = await sessionOf(request)
    if (!(await hasAccess(eventDeps, id, session.user_id))) {
      throw forbidden()
    }
    // Surfaced rather than hidden: an operation held back is almost always a peer whose key has
    // not been exchanged yet, and the user is the one who can fix that.
    return { quarantined: await listQuarantined(eventDeps, id) }
  })

  // ── Interchange files and ingestion ───────────────────────────────────────────

  const transferDeps: TransferDeps = { ...eventDeps, blobDir: config.blobDir }

  /**
   * Binary bodies are taken as-is.
   *
   * Base64 in JSON would inflate a six-megabyte export by a third and force the whole thing
   * through a JSON parser for no benefit.
   */
  app.addContentTypeParser(
    [
      'application/octet-stream',
      'application/vnd.passvault.tkpak',
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/vnd.apple.pkpass',
      'application/zip',
    ],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )

  const exportBody = z.object({
    password: z.string().min(4),
    ticketIds: z.array(z.string().uuid()).optional(),
    includeDocuments: z.boolean().optional(),
    preview: z.enum(['full', 'minimal', 'none']).optional(),
    exportedFor: z.string().max(200).optional(),
    eventPassword: z.string().optional(),
  })

  app.post('/api/v1/events/:id/export', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const body = exportBody.parse(request.body)
    const { session, eventKey } = await openEvent(request, id, body.eventPassword)
    const result = await exportEvent(transferDeps, {
      eventId: id,
      viewerUserId: session.user_id,
      eventKey,
      password: body.password,
      ...(body.ticketIds ? { ticketIds: body.ticketIds } : {}),
      ...(body.includeDocuments === undefined ? {} : { includeDocuments: body.includeDocuments }),
      ...(body.preview ? { preview: body.preview } : {}),
      ...(body.exportedFor ? { exportedFor: body.exportedFor } : {}),
    })
    return (
      reply
        .header('content-type', 'application/vnd.passvault.tkpak')
        .header('content-disposition', `attachment; filename="${result.fileId}.tkpak"`)
        .header('x-passvault-ticket-count', String(result.ticketCount))
        // The recipient cannot be made to forget this file once they have it, and the client is
        // told so here rather than being left to work it out.
        .header('x-passvault-revocable', 'false')
        .send(Buffer.from(result.archive))
    )
  })

  app.post('/api/v1/import/inspect', async (request) => {
    await sessionOf(request)
    return inspectArchive(asBytes(request.body))
  })

  app.post('/api/v1/import', async (request, reply) => {
    const session = await sessionOf(request)
    const vault = vaults.require(session.id)
    const password = request.headers['x-passvault-password']
    if (typeof password !== 'string' || password.length === 0) {
      throw badRequest('tkpak.error.WRONG_PASSWORD')
    }
    const result = await importArchive(transferDeps, {
      importerUserId: session.user_id,
      importerDataKey: vault.dataKey,
      sessionId: session.id,
      archive: asBytes(request.body),
      password,
    })
    return reply.status(201).send(result)
  })

  /** Built once and reused: creating a pdf.js rasterizer per request is expensive. */
  let rasterizer: PageRasterizer | undefined
  const rasterizerOf = async (): Promise<PageRasterizer> => {
    rasterizer ??= await createPdfJsRasterizer()
    return rasterizer
  }

  app.post('/api/v1/events/:id/ingest', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { session, eventKey } = await openEvent(request, id)
    const bytes = asBytes(request.body)

    const source = await storeBlob(transferDeps, {
      eventId: id,
      eventKey,
      mediaType: detectMediaType(bytes),
      bytes,
    })
    const proposal = await propose(bytes, { rasterizer: await rasterizerOf() })

    const batchId = newId()
    await db.db
      .insertInto('ingest_batches')
      .values({
        id: batchId,
        event_id: id,
        created_by: session.user_id,
        source_media_type: mediaTypeCode(source.mediaType),
        source_blob_id: source.id,
        page_count: proposal.pageCount,
        detected_count: proposal.tickets.filter((ticket) => ticket.barcode).length,
        state: 'PROPOSED',
        failure_reason: null,
        created_at: toInstant(),
        updated_at: toInstant(),
      })
      .execute()

    // A proposal, never a saved result. The entries carry no bytes: the client shows the page
    // numbers and warnings, and confirming re-splits from the stored source.
    return reply.status(201).send({
      ingestId: batchId,
      pageCount: proposal.pageCount,
      requiresReview: proposal.requiresReview,
      warnings: proposal.warnings,
      entries: proposal.tickets.map((ticket, index) => ({
        index,
        suggestedLabel: ticket.suggestedLabel,
        barcode: ticket.barcode ?? null,
        pageNumber: ticket.pageNumber ?? null,
        include: ticket.include,
        warnings: ticket.warnings,
      })),
    })
  })

  const confirmBody = z.object({
    include: z.array(z.number().int().min(0)).optional(),
    assignmentMode: z.enum(['OPEN', 'ASSIGNED', 'SELF_CLAIM']).optional(),
  })

  app.post('/api/v1/events/:id/ingest/:ingestId/confirm', async (request, reply) => {
    const { id } = eventParams.parse(request.params)
    const { ingestId } = z.object({ ingestId: z.string().uuid() }).parse(request.params)
    const body = confirmBody.parse(request.body ?? {})
    const { session, eventKey } = await openEvent(request, id)

    const batch = await db.db
      .selectFrom('ingest_batches')
      .selectAll()
      .where('id', '=', ingestId)
      .where('event_id', '=', id)
      .executeTakeFirst()
    if (!batch?.source_blob_id) {
      throw notFound()
    }

    const source = await readBlob(transferDeps, { blobId: batch.source_blob_id, eventKey })
    const proposal = await propose(source.bytes, { rasterizer: await rasterizerOf() })
    const chosen = proposal.tickets.filter((ticket, index) =>
      body.include ? body.include.includes(index) : ticket.include,
    )

    const created: string[] = []
    for (const entry of chosen) {
      const stored = await storeBlob(transferDeps, {
        eventId: id,
        eventKey,
        mediaType: entry.document.mediaType,
        bytes: entry.document.bytes,
      })
      const [ticketId] = await addTickets(eventDeps, {
        eventId: id,
        actorUserId: session.user_id,
        eventKey,
        tickets: [
          {
            label: entry.suggestedLabel,
            ...(entry.barcode ? { barcode: entry.barcode } : {}),
            documentBlobId: stored.id,
            ...(entry.pageNumber === undefined ? {} : { documentPage: entry.pageNumber }),
            ...(body.assignmentMode ? { assignmentMode: body.assignmentMode } : {}),
            // Which import this came out of, so the document can list what it produced rather
            // than being a file with no relation to any of the tickets beside it.
            sourceBatchId: ingestId,
          },
        ],
      })
      if (ticketId) {
        created.push(ticketId)
      }
    }

    await db.db
      .updateTable('ingest_batches')
      .set({ state: 'CONFIRMED', updated_at: toInstant() })
      .where('id', '=', ingestId)
      .execute()

    const cover = await coverFrom(source, id, eventKey)

    return reply.status(201).send({
      ticketIds: created,
      skipped: proposal.tickets.length - chosen.length,
      coverAdded: cover,
    })
  })

  /**
   * The first page of what was just imported, kept as the event's cover.
   *
   * Only when the event has none: overwriting a poster the organiser chose because they later
   * imported a second PDF would be the software deciding it knows better. Rendered small, since
   * this is drawn in a list beside eleven others.
   *
   * Every failure is swallowed. The cover is a nicety and the import is the point — an
   * installation without the optional canvas packages, or a page pdf.js cannot draw, must not
   * turn a successful import into an error.
   */
  const coverFrom = async (
    source: { mediaType: DocumentMediaType; bytes: Uint8Array },
    eventId: string,
    eventKey: Uint8Array,
  ): Promise<boolean> => {
    try {
      const image =
        source.mediaType === 'application/pdf'
          ? await renderFirstPage(source.bytes)
          : source.mediaType === 'image/png' || source.mediaType === 'image/jpeg'
            ? source.bytes
            : undefined
      if (!image) {
        return false
      }
      const stored = await storeBlob(transferDeps, {
        eventId,
        eventKey,
        mediaType: source.mediaType === 'application/pdf' ? 'image/png' : source.mediaType,
        bytes: image,
      })
      return await suggestEventCover(eventDeps, { eventId, imageBlobId: stored.id })
    } catch {
      return false
    }
  }

  const renderFirstPage = async (pdf: Uint8Array): Promise<Uint8Array | undefined> => {
    const document = await (await rasterizerOf()).open(pdf)
    try {
      return document.pageCount > 0 ? await document.renderPage(1, 480) : undefined
    } finally {
      await document.close()
    }
  }

  return {
    app,
    db,
    config,
    vaults,
    close: async () => {
      clearInterval(sweeper)
      await app.close()
      await db.close()
    },
  }
}

/** Fastify hands a Buffer for the binary content types registered above. */
function asBytes(body: unknown): Uint8Array {
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new AppError(400, 'ingest.error.unsupportedFile')
}

const MEDIA_TYPE_CODES: Record<DocumentMediaType, 'PDF' | 'PNG' | 'JPEG' | 'PKPASS'> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'application/vnd.apple.pkpass': 'PKPASS',
}

const mediaTypeCode = (mediaType: DocumentMediaType) => MEDIA_TYPE_CODES[mediaType]

/** Kept out of buildServer so tests can drive the app without binding a port. */
export async function listen(server: PassVaultServer): Promise<string> {
  return server.app.listen({ host: server.config.host, port: server.config.port })
}

export type { FastifyReply }
