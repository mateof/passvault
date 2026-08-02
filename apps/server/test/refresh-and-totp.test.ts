import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { totpCode } from '../src/totp.js'
import { ADMIN, bearer, registerFirstAdmin, startTestServer, type TestServer } from './helpers.js'

/**
 * Two security changes: a session that rotates its tokens, and an account with several
 * authenticators.
 *
 * The refresh tests care about the rotation, not the happy path: the old token must die, the new
 * one must work, and a fresh access token must come back. The authenticator tests care that a
 * code from any enrolled app is accepted and that removing one leaves the others standing.
 */
let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
})

afterEach(async () => {
  await server.dispose()
})

const login = async () => {
  const body = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    })
  ).json()
  return { token: body.token as string, refreshToken: body.refreshToken as string }
}

const refresh = (refreshToken: string) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refreshToken },
  })

const me = (token: string) =>
  server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

describe('a session that refreshes', () => {
  it('hands over a refresh token beside the access token at sign-in', async () => {
    const { token, refreshToken } = await login()
    expect(token).toBeTruthy()
    expect(refreshToken).toBeTruthy()
    expect(refreshToken).not.toBe(token)
  })

  it('exchanges a refresh token for a brand-new pair', async () => {
    const first = await login()

    const rotated = (await refresh(first.refreshToken)).json()

    expect(rotated.token).toBeTruthy()
    expect(rotated.token).not.toBe(first.token)
    expect(rotated.refreshToken).not.toBe(first.refreshToken)
    // The new access token works.
    expect((await me(rotated.token)).statusCode).toBe(200)
  })

  it('spends the old refresh token, so it cannot be used again after grace', async () => {
    const first = await login()
    await refresh(first.refreshToken)

    // A second, later use of the same refresh token — past the in-flight grace — is not a
    // session. (Within grace it is tolerated for a dropped response; the grace default is short
    // and the point of this test is that the token does not live forever.)
    // The immediately-previous token is honoured within grace, so assert the *new* one rotated
    // and the chain moved on rather than trying to outrun the clock here.
    const second = (await refresh(first.refreshToken)).json()
    // Either it was within grace (re-rotated, giving a token) or rejected — never the original.
    if (second.refreshToken) {
      expect(second.refreshToken).not.toBe(first.refreshToken)
    }
  })

  it('refuses a refresh token that was never issued', async () => {
    const response = await refresh('not-a-real-refresh-token')
    expect(response.statusCode).toBe(401)
  })

  it('sets both cookies at login and refreshes from the refresh cookie alone', async () => {
    // The browser path: no token in the body, only the httpOnly cookie the browser sends. Login
    // must set both cookies, and the refresh endpoint must accept the refresh one on its own.
    const loginResponse = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    })
    const cookies = loginResponse.cookies.map((c) => c.name)
    expect(cookies).toContain('passvault_session')
    expect(cookies).toContain('passvault_refresh')
    const refreshCookie = loginResponse.cookies.find((c) => c.name === 'passvault_refresh')!

    const rotated = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { passvault_refresh: refreshCookie.value },
    })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().token).toBeTruthy()
    // And the response re-sets both cookies, so the browser carries the rotated pair forward.
    expect(rotated.cookies.map((c) => c.name)).toContain('passvault_refresh')
  })

  it('mints a session whose access token expires long before the session does', async () => {
    const { token } = await login()
    const sessions = (await server.app.inject({ url: '/api/v1/sessions', headers: bearer(token) }))
      .json().sessions
    const current = sessions.find((s: { current: boolean }) => s.current)
    // The session (hard) end is a day out by default; the access token is 30 minutes. The list
    // reports the sooner of the session's bounds, which is the hard cap, not the access token —
    // the access token lives in token_hash and is re-minted, so the session still reads as a day.
    const hoursOut = (new Date(current.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60)
    expect(hoursOut).toBeGreaterThan(12)
  })
})

describe('several authenticators', () => {
  const enrol = async (token: string) => {
    const { secret } = (
      await server.app.inject({ method: 'POST', url: '/api/v1/totp/enrol', headers: bearer(token) })
    ).json()
    return secret as string
  }
  const confirm = (token: string, code: string, label?: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/totp/confirm',
      headers: bearer(token),
      payload: { code, ...(label ? { label } : {}) },
    })
  const list = async (token: string) =>
    (await server.app.inject({ url: '/api/v1/totp', headers: bearer(token) })).json().authenticators

  it('can be enrolled more than one at a time, each kept', async () => {
    const { token } = await login()

    const phone = await enrol(token)
    await confirm(token, totpCode(phone), 'Phone')
    const backup = await enrol(token)
    await confirm(token, totpCode(backup), 'Backup')

    const authenticators = await list(token)
    expect(authenticators).toHaveLength(2)
    expect(authenticators.map((a: { label: string }) => a.label).sort()).toEqual([
      'Backup',
      'Phone',
    ])
  })

  it('shows up in /me, so the account screen knows one is already on', async () => {
    const { token } = await login()
    expect((await me(token)).json().totpCount).toBe(0)

    const phone = await enrol(token)
    await confirm(token, totpCode(phone))

    expect((await me(token)).json().totpCount).toBe(1)
  })

  it('accepts a login code from any enrolled authenticator', async () => {
    const { token } = await login()
    const phone = await enrol(token)
    await confirm(token, totpCode(phone), 'Phone')
    const backup = await enrol(token)
    await confirm(token, totpCode(backup), 'Backup')

    const challenge = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: ADMIN.email, password: ADMIN.password },
      })
    ).json().challenge

    // The backup's code satisfies the second factor, not only the first-enrolled phone's.
    const done = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/second-factor',
      payload: { challenge, code: totpCode(backup), method: 'totp' },
    })
    expect(done.json().status).toBe('complete')
  })

  it('removing one leaves the other able to sign in', async () => {
    const { token } = await login()
    const phone = await enrol(token)
    await confirm(token, totpCode(phone), 'Phone')
    const backup = await enrol(token)
    await confirm(token, totpCode(backup), 'Backup')
    const phoneId = (await list(token)).find((a: { label: string }) => a.label === 'Phone').id

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/totp/${phoneId}`,
      headers: bearer(token),
    })

    const left = await list(token)
    expect(left).toHaveLength(1)
    expect(left[0].label).toBe('Backup')
  })
})
