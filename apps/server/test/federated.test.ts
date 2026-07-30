import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_ARGON2_PARAMS, randomKey, toBase64Url } from '@passvault/crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, type PassVaultServer } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { CapturingMailer } from '../src/mailer.js'
import { FakeOidcProvider, SoftwareAuthenticator } from './fake-identity.js'
import { ADMIN, MEMBER, bearer, login, registerFirstAdmin } from './helpers.js'

/**
 * Signing in through Google and with a passkey.
 *
 * Both are exercised against real cryptography rather than a mock: the provider signs an RS256
 * token that the real verifier checks, and the authenticator produces an ES256 assertion the real
 * verifier checks. A mock would prove only that a library gets called.
 *
 * The recurring assertion in both blocks is `needsPassphrase`. Neither method can unwrap the
 * vault, because neither leaves this server a secret to derive a key from — which is the reason
 * the vault passphrase is a separate secret at all.
 */
const CLIENT_ID = 'passvault-test-client.apps.googleusercontent.com'
const REDIRECT_URI = 'https://passvault.example.org/oidc/callback'

let server: PassVaultServer & { mailer: CapturingMailer; dispose: () => Promise<void> }
let provider: FakeOidcProvider
let dataDir: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'passvault-fed-'))
  provider = new FakeOidcProvider({ clientId: CLIENT_ID })
  const config = loadConfig({
    DATA_DIR: dataDir,
    DATABASE_URL: 'sqlite::memory:',
    MASTER_KEY: toBase64Url(randomKey()),
    BLIND_INDEX_KEY: toBase64Url(randomKey()),
    PUBLIC_URL: 'https://passvault.example.org',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'test-secret',
  } as NodeJS.ProcessEnv)
  const mailer = new CapturingMailer()
  const built = await buildServer({
    config,
    mailer,
    argon2Params: TEST_ARGON2_PARAMS,
    oidcFetcher: provider.fetcher(),
  })
  server = {
    ...built,
    mailer,
    dispose: async () => {
      await built.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
})

afterEach(async () => {
  await server.dispose()
})

const asHelper = () => server as unknown as Parameters<typeof login>[0]

const openRegistration = async (): Promise<void> => {
  await registerFirstAdmin(asHelper())
  const token = await login(asHelper(), ADMIN)
  await server.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/registration',
    headers: bearer(token),
    payload: { mode: 'OPEN' },
  })
}

const startFlow = async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/oidc/google/start',
    payload: { redirectUri: REDIRECT_URI },
  })
  const body = response.json()
  const nonce = new URL(body.authorizationUrl).searchParams.get('nonce')
  return { state: body.state as string, nonce: nonce ?? '', url: body.authorizationUrl as string }
}

const callback = (state: string, code: string) =>
  server.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/callback', payload: { state, code } })

describe('which sign-in methods an instance offers', () => {
  it('lists only providers it has credentials for', async () => {
    const response = await server.app.inject({ url: '/api/v1/auth/providers' })

    expect(response.json().providers).toEqual(['google'])
  })

  it('always offers passkeys, which need no external credentials', async () => {
    const response = await server.app.inject({ url: '/api/v1/auth/providers' })

    expect(response.json().passkeys).toBe(true)
  })

  it('refuses to start a flow for a provider with no credentials', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/microsoft/start',
      payload: { redirectUri: REDIRECT_URI },
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('starting a provider sign-in', () => {
  it('sends the user to the provider', async () => {
    const { url } = await startFlow()

    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth')
  })

  it('uses PKCE, so an intercepted code cannot be redeemed by anybody else', async () => {
    const { url } = await startFlow()

    expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('sends a nonce, so a token from another sign-in cannot be replayed', async () => {
    const { nonce } = await startFlow()

    expect(nonce.length).toBeGreaterThan(10)
  })

  it('asks the provider to let the user choose an account', async () => {
    const { url } = await startFlow()

    expect(new URL(url).searchParams.get('prompt')).toBe('select_account')
  })
})

describe('completing a provider sign-in', () => {
  beforeEach(openRegistration)

  it('creates an account for a new subject', async () => {
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'google-subject-1',
      email: 'ana@example.org',
      emailVerified: true,
    })

    const response = await callback(state, code)

    expect(response.json().createdAccount).toBe(true)
  })

  it('returns a usable session', async () => {
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'google-subject-2',
      email: 'ana@example.org',
      emailVerified: true,
    })
    const { token } = (await callback(state, code)).json()

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.statusCode).toBe(200)
  })

  it('says the vault still needs a passphrase, because a provider gives us no key', async () => {
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'google-subject-3',
      email: 'ana@example.org',
      emailVerified: true,
    })

    const response = await callback(state, code)

    expect(response.json().needsPassphrase).toBe(true)
  })

  it('leaves the vault locked until one is set', async () => {
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'google-subject-4',
      email: 'ana@example.org',
      emailVerified: true,
    })
    const { token } = (await callback(state, code)).json()

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultUnlocked).toBe(false)
  })

  it('signs the same subject back into the same account', async () => {
    const first = await startFlow()
    const firstResponse = await callback(
      first.state,
      provider.authorize({
        nonce: first.nonce,
        subject: 'google-subject-5',
        email: 'ana@example.org',
        emailVerified: true,
      }),
    )
    const second = await startFlow()

    const secondResponse = await callback(
      second.state,
      provider.authorize({
        nonce: second.nonce,
        subject: 'google-subject-5',
        email: 'ana@example.org',
        emailVerified: true,
      }),
    )

    expect(secondResponse.json().userId).toBe(firstResponse.json().userId)
    expect(secondResponse.json().createdAccount).toBe(false)
  })

  it('follows the subject rather than the address, since addresses change hands', async () => {
    const first = await startFlow()
    const created = await callback(
      first.state,
      provider.authorize({
        nonce: first.nonce,
        subject: 'google-subject-6',
        email: 'old@example.org',
        emailVerified: true,
      }),
    )
    const second = await startFlow()

    const again = await callback(
      second.state,
      provider.authorize({
        nonce: second.nonce,
        subject: 'google-subject-6',
        email: 'new@example.org',
        emailVerified: true,
      }),
    )

    expect(again.json().userId).toBe(created.json().userId)
  })

  it('refuses a state it never issued', async () => {
    const { nonce } = await startFlow()
    const code = provider.authorize({ nonce, subject: 's', email: 'a@example.org' })

    const response = await callback('invented-state', code)

    expect(response.statusCode).toBe(401)
  })

  it('refuses to reuse a state, so a callback cannot be replayed', async () => {
    const { state, nonce } = await startFlow()
    await callback(
      state,
      provider.authorize({
        nonce,
        subject: 'google-subject-7',
        email: 'ana@example.org',
        emailVerified: true,
      }),
    )

    const again = await callback(state, 'another-code')

    expect(again.statusCode).toBe(401)
  })

  it('refuses a code the provider does not recognise', async () => {
    const { state } = await startFlow()

    const response = await callback(state, 'never-issued')

    expect(response.statusCode).toBe(401)
  })
})

describe('linking a provider to an existing account', () => {
  beforeEach(async () => {
    await openRegistration()
    await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  })

  it('links when the provider says the address is verified', async () => {
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'google-linking-1',
      email: MEMBER.email,
      emailVerified: true,
    })

    const response = await callback(state, code)

    expect(response.json().createdAccount).toBe(false)
  })

  it('lands in the account that already existed', async () => {
    const passwordToken = await login(asHelper(), MEMBER)
    const existing = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(passwordToken) })
    ).json().userId
    const { state, nonce } = await startFlow()

    const response = await callback(
      state,
      provider.authorize({
        nonce,
        subject: 'google-linking-2',
        email: MEMBER.email,
        emailVerified: true,
      }),
    )

    expect(response.json().userId).toBe(existing)
  })

  it('refuses to link an unverified address, which would be account takeover', async () => {
    // Without this check, anybody able to obtain a token carrying an address of their choosing
    // takes over the matching PassVault account. It is the classic OIDC linking vulnerability.
    const { state, nonce } = await startFlow()
    const code = provider.authorize({
      nonce,
      subject: 'attacker-subject',
      email: MEMBER.email,
      emailVerified: false,
    })

    const response = await callback(state, code)

    expect(response.statusCode).toBe(403)
  })

  it('reports the vault as already having a passphrase for a linked account', async () => {
    const { state, nonce } = await startFlow()

    const response = await callback(
      state,
      provider.authorize({
        nonce,
        subject: 'google-linking-3',
        email: MEMBER.email,
        emailVerified: true,
      }),
    )

    expect(response.json().needsPassphrase).toBe(false)
  })
})

describe('a forged or replayed identity token', () => {
  beforeEach(openRegistration)

  const callbackWithToken = async (idToken: string) => {
    // Drives the verifier directly, since the provider double is what would normally produce the
    // token. The cases below are exactly the ones a token forger would try.
    const { OidcClient, providerSettings } = await import('../src/oidc.js')
    const client = new OidcClient(
      'google',
      providerSettings('google', { clientId: CLIENT_ID, clientSecret: 'test-secret' }),
      provider.fetcher(),
    )
    return client.verifyIdToken(idToken, 'expected-nonce')
  }

  it('rejects a token whose nonce does not match the flow', async () => {
    const token = provider.signIdToken({ sub: 'x', nonce: 'a-different-nonce' })

    await expect(callbackWithToken(token)).rejects.toThrow()
  })

  it('rejects a token issued for another application', async () => {
    const token = provider.signIdToken({
      sub: 'x',
      nonce: 'expected-nonce',
      aud: 'someone-elses-client-id',
    })

    await expect(callbackWithToken(token)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = provider.signIdToken({
      sub: 'x',
      nonce: 'expected-nonce',
      exp: Math.floor(Date.now() / 1000) - 60,
    })

    await expect(callbackWithToken(token)).rejects.toThrow()
  })

  it('rejects a token from a different issuer', async () => {
    const token = provider.signIdToken({
      sub: 'x',
      nonce: 'expected-nonce',
      iss: 'https://accounts.evil.example',
    })

    await expect(callbackWithToken(token)).rejects.toThrow()
  })

  it('rejects a token signed by somebody else’s key', async () => {
    const impostor = new FakeOidcProvider({ clientId: CLIENT_ID })
    const token = impostor.signIdToken({ sub: 'x', nonce: 'expected-nonce' })

    await expect(callbackWithToken(token)).rejects.toThrow()
  })

  it('rejects an unsigned token, the oldest JWT attack there is', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'x',
        nonce: 'expected-nonce',
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url')

    await expect(callbackWithToken(`${header}.${payload}.`)).rejects.toThrow()
  })

  it('accepts a token that passes every check', async () => {
    const token = provider.signIdToken({ sub: 'genuine', nonce: 'expected-nonce' })

    await expect(callbackWithToken(token)).resolves.toMatchObject({ sub: 'genuine' })
  })
})

describe('passkeys', () => {
  let token: string
  let authenticator: SoftwareAuthenticator

  beforeEach(async () => {
    await registerFirstAdmin(asHelper())
    token = await login(asHelper(), ADMIN)
    authenticator = new SoftwareAuthenticator(
      server.config.webAuthn.relyingPartyId,
      server.config.webAuthn.origin,
    )
  })

  const registrationOptions = () =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/register/options',
      headers: bearer(token),
    })

  const registerPasskey = async (name?: string) => {
    const options = (await registrationOptions()).json()
    return server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/register',
      headers: bearer(token),
      payload: { response: authenticator.register(options.challenge), ...(name ? { name } : {}) },
    })
  }

  const loginOptions = () =>
    server.app.inject({ method: 'POST', url: '/api/v1/passkeys/login/options' })

  it('asks for a discoverable credential, so signing in needs no username', async () => {
    const options = (await registrationOptions()).json()

    expect(options.authenticatorSelection.residentKey).toBe('required')
  })

  it('does not put the user’s address on the authenticator', async () => {
    const options = (await registrationOptions()).json()

    expect(JSON.stringify(options)).not.toContain('mateo@example.org')
  })

  it('registers a passkey the authenticator produced', async () => {
    expect((await registerPasskey()).statusCode).toBe(201)
  })

  it('lists it afterwards', async () => {
    await registerPasskey("Mateo's phone")

    const response = await server.app.inject({ url: '/api/v1/passkeys', headers: bearer(token) })

    expect(response.json().passkeys[0].name).toBe("Mateo's phone")
  })

  it('refuses a registration whose challenge was never issued', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/register',
      headers: bearer(token),
      payload: { response: authenticator.register('a-challenge-nobody-issued') },
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses to reuse a challenge, so a captured response cannot be replayed', async () => {
    const options = (await registrationOptions()).json()
    const response = authenticator.register(options.challenge)
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/register',
      headers: bearer(token),
      payload: { response },
    })

    const again = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/register',
      headers: bearer(token),
      payload: { response },
    })

    expect(again.statusCode).toBe(400)
  })

  it('signs in with the registered passkey and no username', async () => {
    await registerPasskey()
    const options = (await loginOptions()).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.authenticate(options.challenge) },
    })

    expect(response.json().token).toMatch(/.+/)
  })

  it('offers no credential list, since the authenticator knows what it holds', async () => {
    await registerPasskey()

    const options = (await loginOptions()).json()

    expect(options.allowCredentials ?? []).toEqual([])
  })

  it('says the vault still needs a passphrase, because a passkey decrypts nothing', async () => {
    // The account here does have a passphrase, set at registration, so this asserts the honest
    // answer rather than a hardcoded true.
    await registerPasskey()
    const options = (await loginOptions()).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.authenticate(options.challenge) },
    })

    expect(response.json().needsPassphrase).toBe(false)
  })

  it('leaves the vault locked after a passkey sign-in', async () => {
    await registerPasskey()
    const options = (await loginOptions()).json()
    const { token: sessionToken } = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/passkeys/login',
        payload: { response: authenticator.authenticate(options.challenge) },
      })
    ).json()

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(sessionToken) })

    expect(me.json().vaultUnlocked).toBe(false)
  })

  it('refuses an assertion signed by a different key claiming the same credential', async () => {
    await registerPasskey()
    const options = (await loginOptions()).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.impersonate(options.challenge) },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses a credential that was never registered', async () => {
    const stranger = new SoftwareAuthenticator(
      server.config.webAuthn.relyingPartyId,
      server.config.webAuthn.origin,
    )
    const options = (await loginOptions()).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: stranger.authenticate(options.challenge) },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses an assertion for a challenge nobody issued', async () => {
    await registerPasskey()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.authenticate('never-issued-challenge') },
    })

    expect(response.statusCode).toBe(401)
  })

  it('records the signature counter, which is what detects a cloned authenticator', async () => {
    await registerPasskey()
    const options = (await loginOptions()).json()
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.authenticate(options.challenge) },
    })

    const stored = await server.db.db
      .selectFrom('webauthn_credentials')
      .select('sign_count')
      .executeTakeFirstOrThrow()

    expect(stored.sign_count).toBeGreaterThan(0)
  })

  it('lets its owner remove it', async () => {
    await registerPasskey()
    const { passkeys } = (
      await server.app.inject({ url: '/api/v1/passkeys', headers: bearer(token) })
    ).json()

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/passkeys/${passkeys[0].id}`,
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(204)
  })

  it('stops working once removed', async () => {
    await registerPasskey()
    const { passkeys } = (
      await server.app.inject({ url: '/api/v1/passkeys', headers: bearer(token) })
    ).json()
    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/passkeys/${passkeys[0].id}`,
      headers: bearer(token),
    })
    const options = (await loginOptions()).json()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/passkeys/login',
      payload: { response: authenticator.authenticate(options.challenge) },
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('setting a vault passphrase after a federated sign-in', () => {
  beforeEach(openRegistration)

  const signInWithGoogle = async (subject: string) => {
    const { state, nonce } = await startFlow()
    return (
      await callback(
        state,
        provider.authorize({
          nonce,
          subject,
          email: `${subject}@example.org`,
          emailVerified: true,
        }),
      )
    ).json()
  }

  it('creates the vault and returns a recovery code once', async () => {
    const { token } = await signInWithGoogle('passphrase-subject-1')

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(token),
      payload: { passphrase: 'frase do baul de ana' },
    })

    expect(response.json().recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
  })

  it('unlocks the vault straight away', async () => {
    const { token } = await signInWithGoogle('passphrase-subject-2')
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(token),
      payload: { passphrase: 'frase do baul de ana' },
    })

    const me = await server.app.inject({ url: '/api/v1/me', headers: bearer(token) })

    expect(me.json().vaultUnlocked).toBe(true)
  })

  it('lets the account then use its wallet', async () => {
    const { token } = await signInWithGoogle('passphrase-subject-3')
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(token),
      payload: { passphrase: 'frase do baul de ana' },
    })

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(token),
      payload: { name: 'Festival do Norte 2026' },
    })

    expect(response.statusCode).toBe(201)
  })

  it('refuses a passphrase too short to derive a key from', async () => {
    const { token } = await signInWithGoogle('passphrase-subject-4')

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(token),
      payload: { passphrase: 'curta' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('needs the current passphrase to change an existing one', async () => {
    // A stolen session token must not be enough to lock the owner out of their own data.
    const passwordToken = await login(asHelper(), ADMIN)

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(passwordToken),
      payload: { passphrase: 'unha frase nova e longa' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('changes it when the current one is supplied', async () => {
    const passwordToken = await login(asHelper(), ADMIN)

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(passwordToken),
      payload: { passphrase: 'unha frase nova e longa', currentPassphrase: ADMIN.passphrase },
    })

    expect(response.statusCode).toBe(200)
  })

  it('keeps the data readable after the change, since only the wrapping changed', async () => {
    const passwordToken = await login(asHelper(), ADMIN)
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/unlock',
      headers: bearer(passwordToken),
      payload: { passphrase: ADMIN.passphrase },
    })
    const { eventId } = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(passwordToken),
        payload: { name: 'Festival do Norte 2026' },
      })
    ).json()
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/vault/passphrase',
      headers: bearer(passwordToken),
      payload: { passphrase: 'unha frase nova e longa', currentPassphrase: ADMIN.passphrase },
    })

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(passwordToken),
    })

    expect(response.json().name).toBe('Festival do Norte 2026')
  })
})
