import { randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { hashPassword, toBase64Url, type Argon2Params } from '@passvault/crypto'
import { migrateToLatest, openDatabase, type DatabaseHandle } from '@passvault/db'
import { createTranslator, resolveLocale, type Locale } from '@passvault/i18n'
import { z } from 'zod'
import {
  PendingLogins,
  adminCreateAccount,
  beginTotpEnrolment,
  completeSecondFactor,
  completeSetup,
  confirmTotpEnrolment,
  loginWithPassword,
  register,
  unlockSessionVault,
  type AccountsDeps,
} from './accounts.js'
import { loadConfig, type ServerConfig } from './config.js'
import { CryptoContext } from './crypto-context.js'
import { AppError, forbidden, unauthorized } from './errors.js'
import { createMailer, type Mailer } from './mailer.js'
import * as repo from './repository.js'
import { VaultCache } from './vault.js'

export interface BuildOptions {
  config?: ServerConfig
  mailer?: Mailer
  /** Lowered in tests so Argon2id does not dominate the run. */
  argon2Params?: Argon2Params
  logger?: boolean
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
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'validation',
        message: t('error.unexpected'),
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      })
    }
    // Anything unrecognised is logged in full and reported as a generic failure: an internal
    // message can carry a query, a path or a key fragment, and none of that belongs in a
    // response.
    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({ error: 'unexpected', message: t('error.unexpected') })
  })

  const sessionOf = async (request: FastifyRequest): Promise<repo.SessionRow> => {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
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

  app.post('/api/v1/auth/login', async (request) => {
    const outcome = await loginWithPassword(deps, loginBody.parse(request.body))
    return outcome.status === 'complete'
      ? { status: outcome.status, token: outcome.token, userId: outcome.userId }
      : { status: outcome.status, challenge: outcome.challenge, methods: outcome.methods }
  })

  const secondFactorBody = z.object({
    challenge: z.string().min(1),
    code: z.string().min(1),
    method: z.enum(['totp', 'email']),
    deviceId: z.string().uuid().optional(),
  })

  app.post('/api/v1/auth/second-factor', async (request) => {
    const outcome = await completeSecondFactor(deps, secondFactorBody.parse(request.body))
    if (outcome.status !== 'complete') {
      throw unauthorized('auth.error.secondFactorRequired')
    }
    return { status: outcome.status, token: outcome.token, userId: outcome.userId }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await sessionOf(request)
    vaults.evict(session.id)
    await repo.revokeSession(db, session.id)
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
    return beginTotpEnrolment(deps, session.user_id, user.id)
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
    return { mode: settings.mode, allowPasswordLogin: settings.allow_password_login === 1 }
  })

  const whitelistBody = z.object({ email: z.string().email() })

  app.post('/api/v1/admin/whitelist', async (request, reply) => {
    const session = await adminOf(request)
    const { email } = whitelistBody.parse(request.body)
    await repo.addToWhitelist(db, {
      emailKey: crypto.emailIndex(email),
      // Under the master-derived key of the administrator who added it, since there is no user
      // row to key it to yet — the point of the whitelist is that the account does not exist.
      emailCipher: crypto.encryptField(
        crypto.serverKey(session.user_id, 'email'),
        crypto.normaliseEmail(email),
        { table: 'email_whitelist', column: 'email_cipher', rowId: session.user_id },
      ),
      addedBy: session.user_id,
    })
    return reply.status(201).send({ added: true })
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

  const adminUserBody = z.object({
    email: z.string().email(),
    locale: z.string().optional(),
    initialPassword: z.string().min(10).optional(),
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

/** Kept out of buildServer so tests can drive the app without binding a port. */
export async function listen(server: PassVaultServer): Promise<string> {
  return server.app.listen({ host: server.config.host, port: server.config.port })
}

export type { FastifyReply }
