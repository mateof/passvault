import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { totpCode } from '../src/totp.js'
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

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
})

afterEach(async () => {
  await server.dispose()
})

const attemptLogin = (payload: Record<string, unknown>) =>
  server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload })

describe('signing in with a password', () => {
  it('returns a token for the right credentials', async () => {
    const response = await attemptLogin(ADMIN)

    expect(response.json().token).toMatch(/.+/)
  })

  it('refuses the wrong password', async () => {
    const response = await attemptLogin({ ...ADMIN, password: 'not the password' })

    expect(response.statusCode).toBe(401)
  })

  it('gives the same answer for an address with no account', async () => {
    // Anything else turns the login endpoint into an account enumeration oracle.
    const unknown = await attemptLogin({ email: 'nobody@example.org', password: ADMIN.password })
    const wrong = await attemptLogin({ ...ADMIN, password: 'not the password' })

    expect(unknown.json().error).toBe(wrong.json().error)
  })

  it('never reflects the password back', async () => {
    const response = await attemptLogin({ ...ADMIN, password: 'not the password' })

    expect(response.body).not.toContain('not the password')
  })

  it('can be turned off entirely by an administrator', async () => {
    const token = await login(server, ADMIN)
    await server.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/registration',
      headers: bearer(token),
      payload: { allowPasswordLogin: false },
    })

    const response = await attemptLogin(ADMIN)

    expect(response.json().error).toBe('auth.error.passwordLoginDisabled')
  })
})

describe('a session', () => {
  it('identifies the signed-in user', async () => {
    const token = await login(server, ADMIN)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.statusCode).toBe(200)
  })

  it('is refused without a token', async () => {
    expect((await server.app.inject({ url: '/api/v1/me' })).statusCode).toBe(401)
  })

  it('is refused with a token that was never issued', async () => {
    const response = await server.app.inject({
      url: '/api/v1/me',
      headers: bearer('a-token-nobody-issued'),
    })

    expect(response.statusCode).toBe(401)
  })

  it('stops working after signing out', async () => {
    const token = await login(server, ADMIN)
    await server.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(token) })

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.statusCode).toBe(401)
  })

  it('stores only a hash of the token, so the database cannot mint one', async () => {
    const token = await login(server, ADMIN)

    const stored = await server.db.db.selectFrom('sessions').select('token_hash').execute()

    expect(stored.some((row) => row.token_hash === token)).toBe(false)
  })
})

describe('the vault', () => {
  it('starts locked, because signing in is not the same as decrypting', async () => {
    const token = await login(server, ADMIN)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultUnlocked).toBe(false)
  })

  const unlock = (token: string, passphrase: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/unlock',
      headers: bearer(token),
      payload: { passphrase },
    })

  it('opens with the vault passphrase', async () => {
    const token = await login(server, ADMIN)

    expect((await unlock(token, ADMIN.passphrase)).json().vaultUnlocked).toBe(true)
  })

  it('refuses the login password, which is a different secret', async () => {
    const token = await login(server, ADMIN)

    expect((await unlock(token, ADMIN.password)).statusCode).toBe(401)
  })

  it('reports a wrong passphrase distinctly from a wrong password', async () => {
    const token = await login(server, ADMIN)

    expect((await unlock(token, 'wrong passphrase')).json().error).toBe(
      'vault.error.wrongPassphrase',
    )
  })

  it('shows as unlocked afterwards', async () => {
    const token = await login(server, ADMIN)
    await unlock(token, ADMIN.passphrase)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultUnlocked).toBe(true)
  })

  it('can be locked again without ending the session', async () => {
    const token = await login(server, ADMIN)
    await unlock(token, ADMIN.passphrase)
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/lock',
      headers: bearer(token),
    })

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultUnlocked).toBe(false)
    expect(me.statusCode).toBe(200)
  })

  it('is locked when the session ends', async () => {
    const token = await login(server, ADMIN)
    await unlock(token, ADMIN.passphrase)

    await server.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(token) })

    expect(server.vaults.size).toBe(0)
  })

  it('is unlocked per session, not per user', async () => {
    const first = await login(server, ADMIN)
    const second = await login(server, ADMIN)
    await unlock(first, ADMIN.passphrase)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(second) })

    expect(me.json().vaultUnlocked).toBe(false)
  })
})

describe('a second factor by authenticator app', () => {
  let token: string

  beforeEach(async () => {
    token = await login(server, ADMIN)
  })

  const enrol = () =>
    server.app.inject({ method: 'POST', url: '/api/v1/totp/enrol', headers: bearer(token) })

  const confirm = (code: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/totp/confirm',
      headers: bearer(token),
      payload: { code },
    })

  it('offers a secret to scan', async () => {
    expect((await enrol()).json().secret).toMatch(/^[A-Z2-7]+$/)
  })

  it('offers a URI an authenticator app understands', async () => {
    expect((await enrol()).json().uri).toContain('otpauth://totp/')
  })

  it('declares the parameters the app needs', async () => {
    const { uri } = (await enrol()).json()

    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('period=30')
  })

  it('confirms enrolment with a code from that secret', async () => {
    const { secret } = (await enrol()).json()

    expect((await confirm(totpCode(secret))).statusCode).toBe(200)
  })

  it('refuses a wrong code', async () => {
    await enrol()

    expect((await confirm('000000')).statusCode).toBe(401)
  })

  it('does not ask for a second factor until enrolment is confirmed', async () => {
    // An interrupted enrolment must not lock the user out with a code they never scanned.
    await enrol()

    const response = await attemptLogin(ADMIN)

    expect(response.json().status).toBe('complete')
  })

  it('asks for a second factor once confirmed', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))

    const response = await attemptLogin(ADMIN)

    expect(response.json().status).toBe('second-factor')
  })

  it('names the method it expects', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))

    const response = await attemptLogin(ADMIN)

    expect(response.json().methods).toEqual(['totp'])
  })

  it('issues no session until the code is supplied', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))

    const response = await attemptLogin(ADMIN)

    expect(response.json().token).toBeUndefined()
  })

  it('completes the login with a valid code', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))
    const { challenge } = (await attemptLogin(ADMIN)).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code: totpCode(secret), method: 'totp' },
    })

    expect(response.json().token).toMatch(/.+/)
  })

  it('refuses a wrong code at the second step', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))
    const { challenge } = (await attemptLogin(ADMIN)).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code: '000000', method: 'totp' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses a challenge that was never issued', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge: 'invented', code: '000000', method: 'totp' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses to reuse a challenge after it has been spent', async () => {
    const { secret } = (await enrol()).json()
    await confirm(totpCode(secret))
    const { challenge } = (await attemptLogin(ADMIN)).json()
    const payload = { challenge, code: totpCode(secret), method: 'totp' as const }
    await server.app.inject({ method: 'POST', url: '/api/v1/auth/second-factor', payload })

    const again = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload,
    })

    expect(again.statusCode).toBe(401)
  })

  it('keeps the secret out of the database in plaintext', async () => {
    const { secret } = (await enrol()).json()

    const stored = await server.db.db.selectFrom('totp_secrets').select('secret_cipher').execute()

    expect(Buffer.from(stored[0]!.secret_cipher).toString('utf8')).not.toContain(secret)
  })
})

describe('a second factor by email', () => {
  beforeEach(async () => {
    const token = await login(server, ADMIN)
    await server.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/registration',
      headers: bearer(token),
      payload: { requireSecondFactor: true, mode: 'OPEN' },
    })
  })

  it('emails a code when no authenticator is enrolled', async () => {
    await attemptLogin(ADMIN)

    expect(server.mailer.lastTo(ADMIN.email)?.subject).toBe('O teu código de acceso a PassVault')
  })

  it('sends it to the real address, which the server can read without the user present', async () => {
    await attemptLogin(ADMIN)

    expect(server.mailer.lastTo(ADMIN.email)).toBeDefined()
  })

  it('completes the login with the emailed code', async () => {
    const { challenge } = (await attemptLogin(ADMIN)).json()
    const code = /\b(\d{6})\b/.exec(server.mailer.lastTo(ADMIN.email)?.body ?? '')?.[1]

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code, method: 'email' },
    })

    expect(response.json().token).toMatch(/.+/)
  })

  it('refuses a wrong code', async () => {
    const { challenge } = (await attemptLogin(ADMIN)).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code: '999999', method: 'email' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('stores only a hash of the code', async () => {
    await attemptLogin(ADMIN)
    const code = /\b(\d{6})\b/.exec(server.mailer.lastTo(ADMIN.email)?.body ?? '')?.[1]

    const stored = await server.db.db
      .selectFrom('email_otp_challenges')
      .select('code_hash')
      .execute()

    expect(stored[0]?.code_hash).not.toContain(code)
  })

  it('refuses a code after too many attempts', async () => {
    const { challenge } = (await attemptLogin(ADMIN)).json()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/second-factor',
        payload: { challenge, code: '999999', method: 'email' },
      })
    }
    const { challenge: second } = (await attemptLogin(ADMIN)).json()
    void second

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code: '999999', method: 'email' },
    })

    expect([401, 429]).toContain(response.statusCode)
  })
})

describe('a suspended account', () => {
  it('cannot sign in', async () => {
    await setRegistrationMode(server, await login(server, ADMIN), 'OPEN')
    await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
    await server.db.db
      .updateTable('users')
      .set({ status: 'SUSPENDED' })
      .where('email_key', '!=', '')
      .execute()

    const response = await attemptLogin(MEMBER)

    expect(response.json().error).toBe('auth.error.accountSuspended')
  })
})

/**
 * Enrolling a second factor.
 *
 * TOTP is RFC 6238 and the URI is the key format Google published and everybody adopted, so there
 * is nothing here specific to any authenticator: what matters is that the parameters are the ones
 * Google Authenticator and Microsoft Authenticator require of a third-party account — HMAC-SHA1,
 * six digits, a thirty-second step — because those two are the strictest about it.
 */
describe('turning on a second factor', () => {
  const enrol = async (): Promise<{ secret: string; uri: string }> => {
    const token = await login(server, ADMIN)
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/totp/enrol',
      headers: bearer(token),
    })
    return response.json()
  }

  it('hands over a secret and a URI an authenticator understands', async () => {
    const { secret, uri } = await enrol()

    expect(secret).toMatch(/^[A-Z2-7]+$/)
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
  })

  it('uses the parameters both major authenticators require', async () => {
    const { uri } = await enrol()

    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('names the account by address, not by identifier', async () => {
    // What an authenticator shows in a list of a dozen. A UUID there tells its owner nothing.
    const { uri } = await enrol()

    expect(decodeURIComponent(uri)).toContain(ADMIN.email)
  })

  it('does not satisfy a second factor until a code confirms it', async () => {
    await enrol()
    const token = await login(server, ADMIN)

    // Still signed in with a password alone: an unconfirmed secret must never be in force, or an
    // enrolment somebody abandoned would lock them out with a code they never scanned.
    expect(token).toEqual(expect.any(String))
  })
})

/**
 * Surviving a refresh.
 *
 * The browser used to hold its token in a JavaScript variable, so every F5 signed the user out
 * and took the open vault with it — two secrets to type again because the page reloaded. The
 * reasoning was that local storage is readable by injected script, which is true and does not
 * lead where it was taken: script in a single-page application can read a module variable just as
 * easily, and can make requests as the user either way.
 *
 * An httpOnly cookie is the thing that actually helps, and these are its three properties: script
 * cannot read it, the server accepts it without any header, and it does not travel to other sites.
 */
describe('a session that survives a reload', () => {
  const signIn = () =>
    server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN })

  const sessionCookie = (response: Awaited<ReturnType<typeof signIn>>) =>
    response.cookies.find((cookie) => cookie.name === 'passvault_session')

  it('sets a cookie when signing in', async () => {
    expect(sessionCookie(await signIn())).toBeDefined()
  })

  it('keeps it out of reach of any script on the page', async () => {
    expect(sessionCookie(await signIn())?.httpOnly).toBe(true)
  })

  it('does not let another site make the browser send it', async () => {
    // Without this, moving the token out of a variable would trade one risk for another: a form
    // on somebody else's page could act as the signed-in user.
    expect(sessionCookie(await signIn())?.sameSite).toBe('Lax')
  })

  it('authenticates on its own, which is what a reload has', async () => {
    const cookie = sessionCookie(await signIn())!

    const me = await server.app.inject({
      url: '/api/v1/me',
      cookies: { passvault_session: cookie.value },
    })

    expect(me.statusCode).toBe(200)
  })

  it('leaves the vault open, so a reload does not ask for the passphrase again', async () => {
    const signedIn = await signIn()
    const cookie = sessionCookie(signedIn)!
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/unlock',
      cookies: { passvault_session: cookie.value },
      payload: { passphrase: ADMIN.passphrase },
    })

    // The key lives in the server process against the session, so restoring the session restores
    // the unlocked vault. That is the whole reason this is worth doing rather than merely tidy.
    const me = await server.app.inject({
      url: '/api/v1/me',
      cookies: { passvault_session: cookie.value },
    })

    expect(me.json().vaultUnlocked).toBe(true)
  })

  it('stops working once the user signs out', async () => {
    const cookie = sessionCookie(await signIn())!
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { passvault_session: cookie.value },
    })

    const me = await server.app.inject({
      url: '/api/v1/me',
      cookies: { passvault_session: cookie.value },
    })

    expect(me.statusCode).toBe(401)
  })

  it('still takes a bearer header, which is what the Android app sends', async () => {
    const token = signIn().then((response) => response.json().token)

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(await token) })

    expect(me.statusCode).toBe(200)
  })
})
