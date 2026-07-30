import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
 * The four registration modes, read as documentation.
 *
 * Each block is one mode and states what it lets through and what it refuses. A reader who
 * wants to know how invitation-only registration behaves should be able to find out from this
 * file without opening the implementation.
 */
let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})

afterEach(async () => {
  await server.dispose()
})

const registerAs = (payload: Record<string, unknown>) =>
  server.app.inject({ method: 'POST', url: '/api/v1/registration', payload })

describe('a brand new installation', () => {
  it('starts closed, so an instance reachable from the internet is not open by default', async () => {
    const response = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(response.json().mode).toBe('CLOSED')
  })

  it('advertises that it will accept a first administrator', async () => {
    const response = await server.app.inject({ url: '/api/v1/registration/settings' })

    expect(response.json().acceptingFirstAdmin).toBe(true)
  })

  it('accepts the first account even though it is closed', async () => {
    const response = await registerAs(ADMIN)

    expect(response.statusCode).toBe(201)
  })

  it('makes that first account an administrator', async () => {
    await registerFirstAdmin(server)
    const token = await login(server, ADMIN)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().isAdmin).toBe(true)
  })

  it('stops accepting registrations once an account exists', async () => {
    await registerFirstAdmin(server)

    const second = await registerAs(MEMBER)

    expect(second.statusCode).toBe(403)
  })

  it('explains the refusal in the requested language', async () => {
    await registerFirstAdmin(server)

    const second = await server.app.inject({
      method: 'POST',
      url: '/api/v1/registration',
      headers: { 'accept-language': 'es' },
      payload: MEMBER,
    })

    expect(second.json().message).toContain('no acepta registros nuevos')
  })

  it('answers in Galician when nothing is requested, since that is the default', async () => {
    await registerFirstAdmin(server)

    const second = await registerAs(MEMBER)

    expect(second.json().message).toContain('non acepta rexistros novos')
  })
})

describe('registration returns key material once', () => {
  it('returns a recovery code', async () => {
    const { recoveryCode } = await registerFirstAdmin(server)

    expect(recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
  })

  it('warns that losing both secrets means losing the data', async () => {
    const response = await registerAs(ADMIN)

    expect(response.json().recoveryCodeWarning).toContain('perdes os teus datos')
  })

  it('refuses a passphrase too short to be worth deriving a key from', async () => {
    const response = await registerAs({ ...ADMIN, passphrase: 'curta' })

    expect(response.statusCode).toBe(400)
  })
})

describe('open registration', () => {
  beforeEach(async () => {
    await registerFirstAdmin(server)
    await setRegistrationMode(server, await login(server, ADMIN), 'OPEN')
  })

  it('lets anybody register', async () => {
    expect((await registerAs(MEMBER)).statusCode).toBe(201)
  })

  it('still refuses an address that already has an account', async () => {
    await registerAs(MEMBER)

    expect((await registerAs(MEMBER)).statusCode).toBe(409)
  })

  it('treats an address as the same account regardless of case', async () => {
    await registerAs(MEMBER)

    const again = await registerAs({ ...MEMBER, email: MEMBER.email.toUpperCase() })

    expect(again.statusCode).toBe(409)
  })

  it('does not make later accounts administrators', async () => {
    await registerAs(MEMBER)
    const token = await login(server, MEMBER)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().isAdmin).toBe(false)
  })
})

describe('whitelisted registration', () => {
  let adminToken: string

  beforeEach(async () => {
    await registerFirstAdmin(server)
    adminToken = await login(server, ADMIN)
    await setRegistrationMode(server, adminToken, 'WHITELIST')
  })

  it('refuses an address that was never authorised', async () => {
    expect((await registerAs(MEMBER)).statusCode).toBe(403)
  })

  it('accepts an address the administrator added', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/whitelist',
      headers: bearer(adminToken),
      payload: { email: MEMBER.email },
    })

    expect((await registerAs(MEMBER)).statusCode).toBe(201)
  })

  it('matches the whitelist through the blind index, so case does not matter', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/whitelist',
      headers: bearer(adminToken),
      payload: { email: MEMBER.email.toUpperCase() },
    })

    expect((await registerAs(MEMBER)).statusCode).toBe(201)
  })

  it('refuses to let a non-administrator add to the whitelist', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/whitelist',
      headers: bearer(adminToken),
      payload: { email: MEMBER.email },
    })
    await registerAs(MEMBER)
    const memberToken = await login(server, MEMBER)

    const attempt = await server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/whitelist',
      headers: bearer(memberToken),
      payload: { email: 'someone@example.org' },
    })

    expect(attempt.statusCode).toBe(403)
  })
})

describe('invitation-only registration', () => {
  let adminToken: string

  beforeEach(async () => {
    await registerFirstAdmin(server)
    adminToken = await login(server, ADMIN)
    await setRegistrationMode(server, adminToken, 'INVITATION')
  })

  const createInvitation = (payload: Record<string, unknown> = {}) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: bearer(adminToken),
      payload,
    })

  it('refuses a registration with no invitation', async () => {
    expect((await registerAs(MEMBER)).statusCode).toBe(403)
  })

  it('accepts a registration with a valid invitation', async () => {
    const { code } = (await createInvitation()).json()

    const response = await registerAs({ ...MEMBER, invitationCode: code })

    expect(response.statusCode).toBe(201)
  })

  it('returns a link that carries the code, for sharing or a QR', async () => {
    const invitation = (await createInvitation()).json()

    expect(invitation.url).toBe(
      `https://passvault.example.org/register?invitation=${invitation.code}`,
    )
  })

  it('refuses a code that was never issued', async () => {
    const response = await registerAs({ ...MEMBER, invitationCode: 'made-up-code' })

    expect(response.statusCode).toBe(403)
  })

  it('refuses a single-use invitation the second time', async () => {
    const { code } = (await createInvitation({ maxUses: 1 })).json()
    await registerAs({ ...MEMBER, invitationCode: code })

    const second = await registerAs({
      ...MEMBER,
      email: 'brais@example.org',
      invitationCode: code,
    })

    expect(second.statusCode).toBe(403)
  })

  it('honours an invitation issued for several uses', async () => {
    const { code } = (await createInvitation({ maxUses: 2 })).json()
    await registerAs({ ...MEMBER, invitationCode: code })

    const second = await registerAs({
      ...MEMBER,
      email: 'brais@example.org',
      invitationCode: code,
    })

    expect(second.statusCode).toBe(201)
  })

  it('honours an invitation bound to one address', async () => {
    const { code } = (await createInvitation({ email: MEMBER.email })).json()

    expect((await registerAs({ ...MEMBER, invitationCode: code })).statusCode).toBe(201)
  })

  it('refuses a bound invitation used by somebody else', async () => {
    const { code } = (await createInvitation({ email: MEMBER.email })).json()

    const response = await registerAs({
      ...MEMBER,
      email: 'brais@example.org',
      invitationCode: code,
    })

    expect(response.statusCode).toBe(403)
  })

  it('reports a bound invitation as invalid rather than naming who it was for', async () => {
    const { code } = (await createInvitation({ email: MEMBER.email })).json()

    const response = await registerAs({
      ...MEMBER,
      email: 'brais@example.org',
      invitationCode: code,
    })

    expect(response.json().error).toBe('registration.error.invitationInvalid')
  })
})

describe('administrator-created accounts', () => {
  let adminToken: string

  beforeEach(async () => {
    await registerFirstAdmin(server)
    adminToken = await login(server, ADMIN)
  })

  const createUser = (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: bearer(adminToken),
      payload,
    })

  describe('option A: the administrator sets the initial password', () => {
    it('creates the account', async () => {
      const response = await createUser({ email: MEMBER.email, initialPassword: MEMBER.password })

      expect(response.statusCode).toBe(201)
    })

    it('returns no setup link, since the administrator already knows the password', async () => {
      const response = await createUser({ email: MEMBER.email, initialPassword: MEMBER.password })

      expect(response.json().setupUrl).toBeUndefined()
    })

    it('leaves the vault passphrase unset, because an administrator must not choose it', async () => {
      // Choosing it would let the administrator read the user's data afterwards, which defeats
      // the entire key design.
      await createUser({ email: MEMBER.email, initialPassword: MEMBER.password })
      const token = await login(server, { email: MEMBER.email, password: MEMBER.password })

      const unlock = await server.app.inject({
        method: 'POST',
        url: '/api/v1/vault/unlock',
        headers: bearer(token),
        payload: { passphrase: 'anything at all' },
      })

      expect(unlock.json().error).toBe('vault.error.notSet')
    })
  })

  describe('option B: the user sets their own password through a link', () => {
    it('returns a setup link', async () => {
      const response = await createUser({ email: MEMBER.email })

      expect(response.json().setupUrl).toContain('/set-password?token=')
    })

    it('emails the link to the user, in their language', async () => {
      await createUser({ email: MEMBER.email, locale: 'es' })

      expect(server.mailer.lastTo(MEMBER.email)?.subject).toBe(
        'Configura tu contraseña de PassVault',
      )
    })

    it('lets the user complete setup with the token', async () => {
      const { setupUrl } = (await createUser({ email: MEMBER.email })).json()
      const token = new URL(setupUrl).searchParams.get('token')

      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload: {
          token,
          email: MEMBER.email,
          password: MEMBER.password,
          passphrase: MEMBER.passphrase,
        },
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns a recovery code once setup is complete', async () => {
      const { setupUrl } = (await createUser({ email: MEMBER.email })).json()
      const token = new URL(setupUrl).searchParams.get('token')

      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload: {
          token,
          email: MEMBER.email,
          password: MEMBER.password,
          passphrase: MEMBER.passphrase,
        },
      })

      expect(response.json().recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
    })

    it('refuses the token to somebody who does not know the address', async () => {
      // The token alone must not be enough to take over an account.
      const { setupUrl } = (await createUser({ email: MEMBER.email })).json()
      const token = new URL(setupUrl).searchParams.get('token')

      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload: {
          token,
          email: 'attacker@example.org',
          password: MEMBER.password,
          passphrase: MEMBER.passphrase,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('refuses the same token twice', async () => {
      const { setupUrl } = (await createUser({ email: MEMBER.email })).json()
      const token = new URL(setupUrl).searchParams.get('token')
      const payload = {
        token,
        email: MEMBER.email,
        password: MEMBER.password,
        passphrase: MEMBER.passphrase,
      }
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload,
      })

      const again = await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload,
      })

      expect(again.statusCode).toBe(400)
    })

    it('lets the user sign in afterwards', async () => {
      const { setupUrl } = (await createUser({ email: MEMBER.email })).json()
      const token = new URL(setupUrl).searchParams.get('token')
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/registration/complete-setup',
        payload: {
          token,
          email: MEMBER.email,
          password: MEMBER.password,
          passphrase: MEMBER.passphrase,
        },
      })

      await expect(login(server, MEMBER)).resolves.toMatch(/.+/)
    })
  })

  it('refuses to create an account for an address that already has one', async () => {
    const response = await createUser({ email: ADMIN.email })

    expect(response.statusCode).toBe(409)
  })
})
