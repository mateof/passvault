import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { toBase64Url } from '@passvault/crypto'
import { badRequest, unauthorized } from './errors.js'

/**
 * OpenID Connect against Google and Microsoft, written directly against `node:crypto`.
 *
 * No client library. The flow that is actually needed — authorization code with PKCE, one token
 * exchange, one ID token to verify — is a few hundred lines, and the alternative is a dependency
 * that owns the HTTP layer and is awkward to test without a network.
 *
 * Which matters here: the fetcher is injected, so the whole flow is exercised in tests against a
 * provider that never leaves the process. An OIDC implementation nobody can test is an OIDC
 * implementation nobody should trust.
 */
export interface OidcFetcher {
  (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{
    status: number
    json: () => Promise<unknown>
  }>
}

export type OidcProviderName = 'google' | 'microsoft'

export interface OidcProviderSettings {
  clientId: string
  clientSecret: string
  /** Where the discovery document lives. Derived for the known providers. */
  discoveryUrl: string
  /** Expected `iss` claim. Checked rather than trusted from the document. */
  issuer: string
}

export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

interface Jwk {
  kid?: string
  kty: string
  alg?: string
  use?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}

export interface IdTokenClaims {
  iss: string
  aud: string | string[]
  sub: string
  exp: number
  iat: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
}

export function providerSettings(
  name: OidcProviderName,
  credentials: { clientId: string; clientSecret: string; tenant?: string },
): OidcProviderSettings {
  if (name === 'google') {
    return {
      ...credentials,
      discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      issuer: 'https://accounts.google.com',
    }
  }
  const tenant = credentials.tenant ?? 'common'
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    discoveryUrl: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
    // The `common` tenant issues tokens whose `iss` carries the caller's own tenant id, so the
    // check is a pattern rather than a literal. See `matchesIssuer`.
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  }
}

/**
 * PKCE.
 *
 * Not optional even though this is a confidential client with a secret: it binds the
 * authorization code to the browser that started the flow, which is what stops a code
 * intercepted from a redirect being redeemed by anybody else.
 */
export interface PkcePair {
  verifier: string
  challenge: string
}

export function createPkcePair(): PkcePair {
  const verifier = toBase64Url(new Uint8Array(randomBytes(32)))
  return {
    verifier,
    challenge: toBase64Url(new Uint8Array(createHash('sha256').update(verifier).digest())),
  }
}

export class OidcClient {
  private discovery?: Promise<DiscoveryDocument>
  private keys?: Promise<Jwk[]>

  constructor(
    readonly name: OidcProviderName,
    private readonly settings: OidcProviderSettings,
    private readonly fetcher: OidcFetcher = defaultFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached: the document changes rarely and a fetch per sign-in would be absurd. */
  private async discover(): Promise<DiscoveryDocument> {
    this.discovery ??= (async () => {
      const response = await this.fetcher(this.settings.discoveryUrl)
      if (response.status !== 200) {
        throw badRequest('error.unexpected')
      }
      const document = (await response.json()) as DiscoveryDocument
      if (!matchesIssuer(document.issuer, this.settings.issuer)) {
        // A discovery document claiming an issuer we did not ask for means the endpoint is not
        // the provider we think it is.
        throw badRequest('error.unexpected')
      }
      return document
    })()
    return this.discovery
  }

  private async signingKeys(): Promise<Jwk[]> {
    this.keys ??= (async () => {
      const document = await this.discover()
      const response = await this.fetcher(document.jwks_uri)
      if (response.status !== 200) {
        throw badRequest('error.unexpected')
      }
      const body = (await response.json()) as { keys?: Jwk[] }
      return body.keys ?? []
    })()
    return this.keys
  }

  /** Drops the cached keys, so a provider rotating a key recovers without a restart. */
  forgetKeys(): void {
    this.keys = undefined
  }

  async authorizationUrl(input: {
    redirectUri: string
    state: string
    nonce: string
    challenge: string
    /** `select_account` so a shared computer does not silently reuse the last account. */
    prompt?: string
  }): Promise<string> {
    const document = await this.discover()
    const url = new URL(document.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.settings.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', input.state)
    url.searchParams.set('nonce', input.nonce)
    url.searchParams.set('code_challenge', input.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('prompt', input.prompt ?? 'select_account')
    return url.toString()
  }

  async exchangeCode(input: {
    code: string
    verifier: string
    redirectUri: string
    nonce: string
  }): Promise<IdTokenClaims> {
    const document = await this.discover()
    const response = await this.fetcher(document.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        code_verifier: input.verifier,
      }).toString(),
    })
    if (response.status !== 200) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const body = (await response.json()) as { id_token?: string }
    if (!body.id_token) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    return this.verifyIdToken(body.id_token, input.nonce)
  }

  /**
   * Verifies an ID token.
   *
   * Every check here has a reason, and skipping any one of them is a known way to be
   * impersonated:
   *
   *   * **signature** against the provider's published key — otherwise anyone can mint a token;
   *   * **`iss`** — otherwise a token from a different provider is accepted;
   *   * **`aud`** — otherwise a token issued for a *different application* by the same provider
   *     is accepted, which is the subtle one;
   *   * **`exp`** — otherwise an old token works forever;
   *   * **`nonce`** — otherwise a token captured from another sign-in can be replayed.
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
    const parts = idToken.split('.')
    if (parts.length !== 3) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]

    const header = decodeJson<{ alg: string; kid?: string }>(encodedHeader)
    if (header.alg !== 'RS256' && header.alg !== 'ES256') {
      // Notably this rejects `none`, which is the oldest JWT attack there is.
      throw unauthorized('auth.error.invalidCredentials')
    }

    const keys = await this.signingKeys()
    const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys
    if (candidates.length === 0) {
      throw unauthorized('auth.error.invalidCredentials')
    }

    const signed = `${encodedHeader}.${encodedPayload}`
    const signature = Buffer.from(encodedSignature, 'base64url')
    const verified = candidates.some((key) => verifySignature(header.alg, key, signed, signature))
    if (!verified) {
      throw unauthorized('auth.error.invalidCredentials')
    }

    const claims = decodeJson<IdTokenClaims>(encodedPayload)
    if (!matchesIssuer(claims.iss, this.settings.issuer)) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(this.settings.clientId)) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) {
      throw unauthorized('auth.error.expiredOtp')
    }
    if (!claims.nonce || !constantTimeEquals(claims.nonce, expectedNonce)) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    if (!claims.sub) {
      throw unauthorized('auth.error.invalidCredentials')
    }
    return claims
  }
}

/**
 * Compares an issuer.
 *
 * Microsoft's `common` tenant issues tokens whose `iss` names the *user's* tenant rather than
 * `common`, so a literal comparison would reject every real token. The wildcard is confined to
 * that one segment: everything before and after still has to match.
 */
function matchesIssuer(actual: string, expected: string): boolean {
  if (actual === expected) {
    return true
  }
  if (!expected.includes('/common/')) {
    return false
  }
  const pattern = new RegExp(
    `^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/common/', '/[0-9a-f-]{36}/')}$`,
  )
  return pattern.test(actual)
}

function verifySignature(alg: string, key: Jwk, signed: string, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: key as never, format: 'jwk' })
    if (alg === 'RS256') {
      return createVerify('sha256').update(signed).verify(publicKey, signature)
    }
    // ES256 signatures on the wire are the raw r||s pair, not the DER form `createVerify`
    // expects by default.
    return createVerify('sha256')
      .update(signed)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
  } catch {
    return false
  }
}

function decodeJson<T>(encoded: string): T {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
  } catch {
    throw unauthorized('auth.error.invalidCredentials')
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const defaultFetcher: OidcFetcher = async (url, init) => {
  const response = await fetch(url, init as RequestInit)
  return { status: response.status, json: () => response.json() }
}

/**
 * Flows in progress.
 *
 * In memory, with the same trade-off as half-finished logins: a restart loses a sign-in that is
 * mid-redirect, and more than one instance needs a shared store. A five-minute value is not worth
 * a table and a cleanup job for a self-hosted single process.
 */
export interface PendingOidcFlow {
  provider: OidcProviderName
  verifier: string
  nonce: string
  redirectUri: string
  invitationCode?: string
  expiresAt: number
}

export class OidcFlows {
  private readonly flows = new Map<string, PendingOidcFlow>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(flow: Omit<PendingOidcFlow, 'expiresAt'>): string {
    const state = toBase64Url(new Uint8Array(randomBytes(32)))
    this.flows.set(state, { ...flow, expiresAt: this.now() + this.ttlMs })
    return state
  }

  /**
   * Takes a flow by its state, removing it.
   *
   * Single use, which is what makes `state` a defence against cross-site request forgery on the
   * callback rather than a value an attacker can replay.
   */
  take(state: string): PendingOidcFlow | undefined {
    const flow = this.flows.get(state)
    this.flows.delete(state)
    if (!flow || this.now() >= flow.expiresAt) {
      return undefined
    }
    return flow
  }
}

export function newNonce(): string {
  return toBase64Url(new Uint8Array(randomBytes(16)))
}
