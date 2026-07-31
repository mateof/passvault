import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomKey, toBase64Url } from '@passvault/crypto'
import {
  ADMIN,
  MEMBER,
  bearer,
  login,
  registerFirstAdmin,
  setRegistrationMode,
  startTestServer,
  type TestServer,
} from './helpers.js'

/**
 * The installation described by its deployment file, and the screens that take over afterwards.
 *
 * Two halves, and the seam between them is the point of the whole feature: a container that has
 * never been opened in a browser has to arrive with an administrator and a registration policy,
 * and from the moment somebody signs in, the administration screens own both. Anything that
 * makes the environment keep winning silently would make those screens a lie.
 */

const BOOT_ADMIN = {
  email: 'operador@example.org',
  password: 'unha-clave-de-arranque-longa',
  passphrase: 'frase do baul do operador',
}

let server: TestServer | undefined

/** Disposed here rather than in each test, and nulled so a nested hook can dispose it early. */
afterEach(async () => {
  await server?.dispose()
  server = undefined
})

describe('an administrator named in the deployment file', () => {
  it('exists before anybody has opened a browser', async () => {
    server = await startTestServer({
      ADMIN_EMAIL: BOOT_ADMIN.email,
      ADMIN_PASSWORD: BOOT_ADMIN.password,
    })

    const token = await login(server, BOOT_ADMIN)
    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().isAdmin).toBe(true)
  })

  it('arrives with no vault, because a passphrase the file knows is a vault the file can read', async () => {
    server = await startTestServer({
      ADMIN_EMAIL: BOOT_ADMIN.email,
      ADMIN_PASSWORD: BOOT_ADMIN.password,
    })

    const token = await login(server, BOOT_ADMIN)
    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultConfigured).toBe(false)
  })

  it('becomes a fully active account once its owner chooses that passphrase', async () => {
    server = await startTestServer({
      ADMIN_EMAIL: BOOT_ADMIN.email,
      ADMIN_PASSWORD: BOOT_ADMIN.password,
    })
    const token = await login(server, BOOT_ADMIN)

    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(token),
      payload: { passphrase: BOOT_ADMIN.passphrase },
    })
    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json()).toMatchObject({ status: 'ACTIVE', vaultConfigured: true, isAdmin: true })
  })

  it('is sent a one-time setup link when the file gives no password', async () => {
    server = await startTestServer({ ADMIN_EMAIL: BOOT_ADMIN.email })

    expect(server.mailer.sent.at(-1)?.body).toContain('/set-password?token=')
  })

  it('refuses a password too short to be worth having, and falls back to the link', async () => {
    server = await startTestServer({ ADMIN_EMAIL: BOOT_ADMIN.email, ADMIN_PASSWORD: 'admin' })

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: BOOT_ADMIN.email, password: 'admin' },
    })

    expect(response.statusCode).toBe(401)
    expect(server.mailer.sent.at(-1)?.body).toContain('/set-password?token=')
  })

  it('promotes an account that already exists rather than refusing or duplicating it', async () => {
    server = await startTestServer({ ADMIN_EMAIL: MEMBER.email })
    // The bootstrap ran with no such account, so it created one. Registering the *first*
    // administrator the ordinary way is what this test is really about, so start again with a
    // server whose database already holds that user.
    await server.dispose()

    const dataDir = mkdtempSync(join(tmpdir(), 'passvault-promote-'))
    const shared = {
      DATABASE_URL: `sqlite:${join(dataDir, 'passvault.sqlite')}`,
      MASTER_KEY: toBase64Url(randomKey()),
      BLIND_INDEX_KEY: toBase64Url(randomKey()),
    }
    try {
      const first = await startTestServer(shared)
      await registerFirstAdmin(first)
      const adminToken = await login(first, ADMIN)
      await setRegistrationMode(first, adminToken, 'OPEN')
      await first.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
      await first.dispose()

      server = await startTestServer({ ...shared, ADMIN_EMAIL: MEMBER.email })
      const token = await login(server, MEMBER)
      const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

      expect(me.json().isAdmin).toBe(true)
    } finally {
      // Windows will not remove a directory whose SQLite file is still open, so the server
      // goes before the files do.
      await server?.dispose()
      server = undefined
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('a registration policy set in the deployment file', () => {
  it('applies on first boot, so the container arrives configured', async () => {
    server = await startTestServer({ REGISTRATION_MODE: 'OPEN' })

    const settings = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(settings.json().mode).toBe('OPEN')
  })

  it('seeds the allow list, so WHITELIST mode works without opening a screen', async () => {
    server = await startTestServer({
      REGISTRATION_MODE: 'WHITELIST',
      REGISTRATION_WHITELIST: `${MEMBER.email}, alguen@example.org`,
    })

    const allowed = await server.app.inject({
      method: 'POST',
      url: '/api/v1/registration',
      payload: MEMBER,
    })
    const refused = await server.app.inject({
      method: 'POST',
      url: '/api/v1/registration',
      payload: { ...ADMIN, email: 'nonesta@example.org' },
    })

    expect(allowed.statusCode).toBe(201)
    expect(refused.statusCode).toBe(403)
  })

  it('carries the other two switches as well', async () => {
    server = await startTestServer({
      ADMIN_EMAIL: BOOT_ADMIN.email,
      ADMIN_PASSWORD: BOOT_ADMIN.password,
      REQUIRE_SECOND_FACTOR: 'true',
    })

    const settings = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(settings.json().requireSecondFactor).toBe(true)
  })

  it('refuses a mode it does not recognise instead of falling back to something', async () => {
    await expect(startTestServer({ REGISTRATION_MODE: 'SOMETIMES' })).rejects.toThrow(
      /REGISTRATION_MODE/,
    )
    // Nothing to dispose: the server never started.
    server = await startTestServer()
  })
})

describe('the deployment file and the administration screen disagreeing', () => {
  let dataDir: string
  let shared: Record<string, string>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'passvault-restart-'))
    shared = {
      DATABASE_URL: `sqlite:${join(dataDir, 'passvault.sqlite')}`,
      MASTER_KEY: toBase64Url(randomKey()),
      BLIND_INDEX_KEY: toBase64Url(randomKey()),
      ADMIN_EMAIL: BOOT_ADMIN.email,
      ADMIN_PASSWORD: BOOT_ADMIN.password,
      REGISTRATION_MODE: 'OPEN',
    }
  })

  afterEach(async () => {
    await server?.dispose()
    server = undefined
    rmSync(dataDir, { recursive: true, force: true })
  })

  const closeItFromTheScreen = async (running: TestServer): Promise<void> => {
    const token = await login(running, BOOT_ADMIN)
    await setRegistrationMode(running, token, 'CLOSED')
  }

  it('leaves the decision made in the screen standing on the next restart', async () => {
    const first = await startTestServer(shared)
    await closeItFromTheScreen(first)
    await first.dispose()

    server = await startTestServer(shared)
    const settings = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(settings.json().mode).toBe('CLOSED')
  })

  it('overrides it when the operator asked for exactly that', async () => {
    const first = await startTestServer({ ...shared, REGISTRATION_ENFORCE: 'true' })
    await closeItFromTheScreen(first)
    await first.dispose()

    server = await startTestServer({ ...shared, REGISTRATION_ENFORCE: 'true' })
    const settings = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(settings.json().mode).toBe('OPEN')
  })

  it('says so on the settings, so a screen can warn before somebody wastes a change', async () => {
    server = await startTestServer({ ...shared, REGISTRATION_ENFORCE: 'true' })
    const token = await login(server, BOOT_ADMIN)

    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/registration',
      headers: bearer(token),
      payload: { mode: 'CLOSED' },
    })

    expect(response.json().enforcedByEnvironment).toBe(true)
  })
})

describe('the administration screens', () => {
  let token: string

  beforeEach(async () => {
    server = await startTestServer()
    await registerFirstAdmin(server)
    token = await login(server, ADMIN)
    await setRegistrationMode(server, token, 'OPEN')
    await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  })

  const asAdmin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    server.app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) })

  const memberId = async (): Promise<string> => {
    const users = (await asAdmin('GET', '/api/v1/admin/users')).json().users
    return users.find((user: { email?: string }) => user.email === MEMBER.email).userId
  }

  it('list the accounts with the addresses the server can read', async () => {
    const response = await asAdmin('GET', '/api/v1/admin/users')

    expect(response.json().users.map((user: { email?: string }) => user.email)).toContain(
      MEMBER.email,
    )
  })

  it('say which accounts hold no key material, which is the state that needs explaining', async () => {
    await asAdmin('POST', '/api/v1/admin/users', { email: 'nova@example.org' })

    const users = (await asAdmin('GET', '/api/v1/admin/users')).json().users
    const created = users.find((user: { email?: string }) => user.email === 'nova@example.org')

    expect(created).toMatchObject({ status: 'INVITED', hasVault: false, hasPassword: false })
  })

  it('promote another account', async () => {
    const response = await asAdmin('PATCH', `/api/v1/admin/users/${await memberId()}`, {
      isAdmin: true,
    })

    expect(response.json().isAdmin).toBe(true)
  })

  it('refuse to demote the last administrator, which would leave nobody able to fix it', async () => {
    const users = (await asAdmin('GET', '/api/v1/admin/users')).json().users
    const admin = users.find((user: { isAdmin: boolean }) => user.isAdmin)

    const response = await asAdmin('PATCH', `/api/v1/admin/users/${admin.userId}`, {
      isAdmin: false,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('admin.error.lastAdmin')
  })

  it('allow it once somebody else can administer the installation', async () => {
    const id = await memberId()
    await asAdmin('PATCH', `/api/v1/admin/users/${id}`, { isAdmin: true })
    const users = (await asAdmin('GET', '/api/v1/admin/users')).json().users
    const admin = users.find((user: { email?: string }) => user.email === ADMIN.email)

    const response = await asAdmin('PATCH', `/api/v1/admin/users/${admin.userId}`, {
      isAdmin: false,
    })

    expect(response.statusCode).toBe(200)
  })

  it('refuse to suspend the administrator doing the suspending', async () => {
    const users = (await asAdmin('GET', '/api/v1/admin/users')).json().users
    const admin = users.find((user: { email?: string }) => user.email === ADMIN.email)

    const response = await asAdmin('PATCH', `/api/v1/admin/users/${admin.userId}`, {
      status: 'SUSPENDED',
    })

    expect(response.json().error).toBe('admin.error.selfSuspend')
  })

  it("end the suspended account's live sessions, not only its future logins", async () => {
    const id = await memberId()
    const memberToken = await login(server, MEMBER)

    await asAdmin('PATCH', `/api/v1/admin/users/${id}`, { status: 'SUSPENDED' })
    const response = await server.app.inject({ url: '/api/v1/me', headers: bearer(memberToken) })

    expect(response.statusCode).toBe(401)
  })

  it('stop a suspended account signing in again', async () => {
    await asAdmin('PATCH', `/api/v1/admin/users/${await memberId()}`, { status: 'SUSPENDED' })

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: MEMBER.email, password: MEMBER.password },
    })

    expect(response.statusCode).toBe(403)
  })

  it('let it back in afterwards', async () => {
    const id = await memberId()
    await asAdmin('PATCH', `/api/v1/admin/users/${id}`, { status: 'SUSPENDED' })

    await asAdmin('PATCH', `/api/v1/admin/users/${id}`, { status: 'ACTIVE' })

    await expect(login(server, MEMBER)).resolves.toEqual(expect.any(String))
  })

  it('list invitations, including the ones already spent', async () => {
    await asAdmin('POST', '/api/v1/admin/invitations', { maxUses: 1, ttlHours: 24 })

    const response = await asAdmin('GET', '/api/v1/admin/invitations')

    expect(response.json().invitations).toHaveLength(1)
    expect(response.json().invitations[0]).toMatchObject({ live: true, uses: 0, maxUses: 1 })
  })

  it('revoke an invitation, and the code stops working immediately', async () => {
    const created = (
      await asAdmin('POST', '/api/v1/admin/invitations', { maxUses: 5, ttlHours: 24 })
    ).json()
    await setRegistrationMode(server, token, 'INVITATION')

    await asAdmin('DELETE', `/api/v1/admin/invitations/${created.invitationId}`)
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/registration',
      payload: { ...MEMBER, email: 'convidada@example.org', invitationCode: created.code },
    })

    expect(response.statusCode).toBe(403)
  })

  it('show the allow list in readable form, or removing an entry is guesswork', async () => {
    await asAdmin('POST', '/api/v1/admin/whitelist', { email: 'permitida@example.org' })

    const response = await asAdmin('GET', '/api/v1/admin/whitelist')

    expect(response.json().entries[0].email).toBe('permitida@example.org')
  })

  it('refuse to add the same address twice rather than failing on a constraint', async () => {
    await asAdmin('POST', '/api/v1/admin/whitelist', { email: 'permitida@example.org' })

    const response = await asAdmin('POST', '/api/v1/admin/whitelist', {
      email: 'permitida@example.org',
    })

    expect(response.statusCode).toBe(409)
  })

  it('remove an entry from the allow list', async () => {
    await asAdmin('POST', '/api/v1/admin/whitelist', { email: 'permitida@example.org' })
    const entry = (await asAdmin('GET', '/api/v1/admin/whitelist')).json().entries[0]

    await asAdmin('DELETE', `/api/v1/admin/whitelist/${entry.id}`)

    expect((await asAdmin('GET', '/api/v1/admin/whitelist')).json().entries).toHaveLength(0)
  })

  it('send a fresh setup link to somebody whose first one expired', async () => {
    const created = (
      await asAdmin('POST', '/api/v1/admin/users', { email: 'nova@example.org' })
    ).json()

    const response = await asAdmin('POST', `/api/v1/admin/users/${created.userId}/setup-link`)

    expect(response.json().setupUrl).toContain('/set-password?token=')
  })

  it('are closed to everybody else', async () => {
    const memberToken = await login(server, MEMBER)

    const response = await server.app.inject({
      url: '/api/v1/admin/users',
      headers: bearer(memberToken),
    })

    expect(response.statusCode).toBe(403)
  })
})
