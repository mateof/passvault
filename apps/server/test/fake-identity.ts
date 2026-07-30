import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { OidcFetcher } from '../src/oidc.js'

/**
 * A provider and an authenticator that run inside the test process.
 *
 * Written rather than mocked, and the difference matters. A mock of `verifyIdToken` proves the
 * route calls it; this signs a real RS256 token with a real key and lets the real verifier check
 * it, so the tests exercise the signature, the issuer, the audience, the expiry and the nonce.
 * Same for the passkey: it produces a genuine ES256 assertion over real authenticator data.
 *
 * The point is that these two features can be broken without any test failing if the tests only
 * assert that a library was called.
 */

const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')

// ── OpenID Connect ─────────────────────────────────────────────────────────────

export interface FakeProviderOptions {
  issuer?: string
  clientId: string
  /** Overrides for tokens that must fail verification. */
  claims?: Record<string, unknown>
}

export class FakeOidcProvider {
  readonly issuer: string
  private readonly keyId = 'test-key-1'
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  /** Codes handed out by `authorize`, redeemable once at the token endpoint. */
  private readonly codes = new Map<string, { nonce: string; claims: Record<string, unknown> }>()

  constructor(private readonly options: FakeProviderOptions) {
    this.issuer = options.issuer ?? 'https://accounts.google.com'
  }

  get discoveryUrl(): string {
    return `${this.issuer}/.well-known/openid-configuration`
  }

  /** Stands in for the user completing the consent screen. */
  authorize(input: {
    nonce: string
    subject: string
    email?: string
    emailVerified?: boolean
    name?: string
  }): string {
    const code = b64u(randomBytes(16))
    this.codes.set(code, {
      nonce: input.nonce,
      claims: {
        sub: input.subject,
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.emailVerified === undefined ? {} : { email_verified: input.emailVerified }),
        ...(input.name === undefined ? {} : { name: input.name }),
      },
    })
    return code
  }

  /** Signs a token directly, for the cases that must be rejected. */
  signIdToken(claims: Record<string, unknown>): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: this.keyId }
    const payload = {
      iss: this.issuer,
      aud: this.options.clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
      ...this.options.claims,
    }
    const signingInput = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(
      Buffer.from(JSON.stringify(payload)),
    )}`
    const signature = createSign('sha256').update(signingInput).sign(this.keys.privateKey)
    return `${signingInput}.${b64u(signature)}`
  }

  /** A fetcher the server can be built with, so no request leaves the process. */
  fetcher(): OidcFetcher {
    return async (url, init) => {
      if (url === this.discoveryUrl) {
        return this.ok({
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/o/oauth2/v2/auth`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
        })
      }
      if (url === `${this.issuer}/jwks`) {
        const jwk = this.keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
        return this.ok({ keys: [{ ...jwk, kid: this.keyId, alg: 'RS256', use: 'sig' }] })
      }
      if (url === `${this.issuer}/token`) {
        const body = new URLSearchParams(init?.body ?? '')
        const entry = this.codes.get(body.get('code') ?? '')
        if (!entry) {
          return { status: 400, json: async () => ({ error: 'invalid_grant' }) }
        }
        this.codes.delete(body.get('code') ?? '')
        return this.ok({
          id_token: this.signIdToken({ ...entry.claims, nonce: entry.nonce }),
          token_type: 'Bearer',
        })
      }
      return { status: 404, json: async () => ({}) }
    }
  }

  private ok(body: unknown) {
    return { status: 200, json: async () => body }
  }
}

// ── WebAuthn ───────────────────────────────────────────────────────────────────

const UP = 0x01
const UV = 0x04
const AT = 0x40

/**
 * A software authenticator.
 *
 * Enough of one to produce responses the real verifier accepts: an ES256 key pair, an
 * `attestationType: 'none'` attestation object, and assertions signed over genuine authenticator
 * data. Everything a hardware key would do apart from being hardware.
 */
export class SoftwareAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  readonly credentialId = randomBytes(32)
  private counter = 0

  constructor(
    private readonly relyingPartyId: string,
    private readonly origin: string,
  ) {}

  private rpIdHash(): Buffer {
    return createHash('sha256').update(this.relyingPartyId).digest()
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  /** The COSE form of the public key, which is what lives inside attested credential data. */
  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]) as never,
    ) as Uint8Array
  }

  register(challenge: string): Record<string, unknown> {
    const clientDataJSON = this.clientData('webauthn.create', challenge)
    const credentialIdLength = Buffer.alloc(2)
    credentialIdLength.writeUInt16BE(this.credentialId.length)
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)

    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.of(UP | UV | AT),
      counter,
      Buffer.alloc(16), // aaguid: all zeroes, as a platform authenticator reports
      credentialIdLength,
      this.credentialId,
      Buffer.from(this.cosePublicKey()),
    ])

    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    ) as Uint8Array

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  authenticate(challenge: string, userHandle?: string): Record<string, unknown> {
    this.counter += 1
    const clientDataJSON = this.clientData('webauthn.get', challenge)
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([this.rpIdHash(), Buffer.of(UP | UV), counter])

    // WebAuthn signs authenticatorData concatenated with the hash of the client data, and an ES256
    // assertion is DER-encoded — which is what `createSign` produces by default.
    const signature = createSign('sha256')
      .update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]))
      .sign(createPrivateKey(this.keys.privateKey.export({ format: 'pem', type: 'pkcs8' })))

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle ? { userHandle: b64u(Buffer.from(userHandle, 'utf8')) } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  /** A different key claiming the same credential id, for the forgery case. */
  impersonate(challenge: string): Record<string, unknown> {
    const impostor = new SoftwareAuthenticator(this.relyingPartyId, this.origin)
    const response = impostor.authenticate(challenge) as {
      id: string
      rawId: string
      response: Record<string, unknown>
    }
    return { ...response, id: b64u(this.credentialId), rawId: b64u(this.credentialId) }
  }
}
