import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { newId, toInstant } from '@passvault/db'
import type { AccountsDeps, LoginOutcome, PendingLogins } from './accounts.js'
import { issueSessionFor } from './accounts.js'
import type { ServerConfig } from './config.js'
import { badRequest, forbidden, notFound, unauthorized } from './errors.js'
import * as repo from './repository.js'

/**
 * Passkeys, through `@simplewebauthn/server`.
 *
 * The one place in this project where a library was chosen over writing it: WebAuthn verification
 * means CBOR, COSE keys, attestation formats and several certificate chains, and a hand-rolled
 * version would be a security-critical parser with no second implementation to check it against.
 *
 * Credentials are **discoverable** (`residentKey: 'required'`), so signing in needs no username —
 * the user taps the key and the credential says who they are. That is the whole appeal of a
 * passkey, and requiring an address first throws it away.
 *
 * A passkey proves identity. It does not unwrap the vault: there is no secret in it this server
 * could derive a key from, which is precisely why the vault passphrase exists separately. A user
 * who signs in with a passkey is asked for their passphrase before seeing any ticket.
 */
export interface WebAuthnDeps extends AccountsDeps {
  pending: PendingLogins
}

interface PendingChallenge {
  challenge: string
  /** Present for registration, absent for a discoverable login. */
  userId?: string
  expiresAt: number
}

/**
 * Outstanding challenges.
 *
 * A challenge must be single-use and short-lived, or a captured response can be replayed. Held in
 * memory for the same reason as half-finished logins: it is valid for minutes, and a table would
 * add a migration and a cleanup job to store it.
 */
export class WebAuthnChallenges {
  private readonly entries = new Map<string, PendingChallenge>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  remember(challenge: string, userId?: string): void {
    this.entries.set(challenge, {
      challenge,
      ...(userId ? { userId } : {}),
      expiresAt: this.now() + this.ttlMs,
    })
  }

  take(challenge: string): PendingChallenge | undefined {
    const entry = this.entries.get(challenge)
    // Removed whether or not it is still valid: a challenge is spent by being presented.
    this.entries.delete(challenge)
    if (!entry || this.now() >= entry.expiresAt) {
      return undefined
    }
    return entry
  }
}

const relyingParty = (config: ServerConfig) => ({
  id: config.webAuthn.relyingPartyId,
  name: config.webAuthn.relyingPartyName,
  // Every origin a ceremony may legitimately come from, not just the browser's. The Android app
  // presents `android:apk-key-hash:...` instead of a URL, so verifying against the https origin
  // alone refused every passkey the app created — after the system sheet had already created it.
  origins: config.webAuthn.origins,
})

export async function beginPasskeyRegistration(
  deps: WebAuthnDeps & { challenges: WebAuthnChallenges },
  userId: string,
): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const user = await repo.findUserById(deps.db, userId)
  if (!user) {
    throw unauthorized('auth.error.invalidCredentials')
  }
  const rp = relyingParty(deps.config)
  const existing = await listCredentials(deps, userId)

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    // The user handle is the internal id, never the address: it is stored on the authenticator
    // and there is no reason to put an email address on a security key.
    userID: new Uint8Array(Buffer.from(userId, 'utf8')),
    userName: userId,
    attestationType: 'none',
    // Excluding what is already registered stops the same authenticator being enrolled twice,
    // which produces a credential the user cannot tell apart from the first.
    excludeCredentials: existing.map((credential) => ({ id: credential.credential_id })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  })

  deps.challenges.remember(options.challenge, userId)
  return options
}

export async function finishPasskeyRegistration(
  deps: WebAuthnDeps & { challenges: WebAuthnChallenges },
  input: { userId: string; response: unknown; name?: string },
): Promise<{ credentialId: string }> {
  const response = input.response as Parameters<typeof verifyRegistrationResponse>[0]['response']
  const challenge = challengeOf(response)
  const pending = deps.challenges.take(challenge)
  if (!pending || pending.userId !== input.userId) {
    // Either expired, already used, or issued to somebody else. All three are the same refusal:
    // saying which would help an attacker probe.
    throw badRequest('auth.error.passkeyFailed')
  }

  const rp = relyingParty(deps.config)
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    requireUserVerification: false,
  })
  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('auth.error.passkeyFailed')
  }

  const { credential, credentialBackedUp } = verification.registrationInfo
  await deps.db.db
    .insertInto('webauthn_credentials')
    .values({
      id: newId(),
      user_id: input.userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey),
      sign_count: credential.counter,
      transports: credential.transports?.join(',') ?? null,
      backed_up: credentialBackedUp ? 1 : 0,
      name: input.name ?? null,
      created_at: toInstant(),
      last_used_at: null,
    })
    .execute()

  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    action: 'passkey.registered',
    subjectKind: 'user',
    subjectId: input.userId,
  })

  return { credentialId: credential.id }
}

export async function beginPasskeyLogin(
  deps: WebAuthnDeps & { challenges: WebAuthnChallenges },
): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>>> {
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(deps.config).id,
    // No allowCredentials: the credential is discoverable, so the authenticator offers whatever it
    // holds for this site and the server learns who is signing in from the response.
    userVerification: 'preferred',
  })
  deps.challenges.remember(options.challenge)
  return options
}

export async function finishPasskeyLogin(
  deps: WebAuthnDeps & { challenges: WebAuthnChallenges },
  input: {
    response: unknown
    deviceId?: string
    origin?: import('./accounts.js').SessionOrigin
  },
): Promise<LoginOutcome & { needsPassphrase: boolean }> {
  const response = input.response as Parameters<typeof verifyAuthenticationResponse>[0]['response']
  const challenge = challengeOf(response)
  if (!deps.challenges.take(challenge)) {
    throw unauthorized('auth.error.passkeyFailed')
  }

  const stored = await deps.db.db
    .selectFrom('webauthn_credentials')
    .selectAll()
    .where('credential_id', '=', response.id)
    .executeTakeFirst()
  if (!stored) {
    throw unauthorized('auth.error.passkeyFailed')
  }

  const user = await repo.findUserById(deps.db, stored.user_id)
  if (!user) {
    throw unauthorized('auth.error.passkeyFailed')
  }
  if (user.status === 'SUSPENDED') {
    throw forbidden('auth.error.accountSuspended')
  }

  const rp = relyingParty(deps.config)
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: stored.sign_count,
      ...(stored.transports
        ? { transports: stored.transports.split(',') as ('usb' | 'nfc' | 'ble' | 'internal')[] }
        : {}),
    },
    requireUserVerification: false,
  })
  if (!verification.verified) {
    throw unauthorized('auth.error.passkeyFailed')
  }

  // The counter guards against a cloned authenticator. Plenty of real passkeys report zero
  // forever, which the library accounts for; storing whatever it returns keeps the check working
  // for the authenticators that do increment.
  await deps.db.db
    .updateTable('webauthn_credentials')
    .set({
      sign_count: verification.authenticationInfo.newCounter,
      last_used_at: toInstant(),
    })
    .where('id', '=', stored.id)
    .execute()

  const login = await issueSessionFor(deps, stored.user_id, input.deviceId, input.origin)
  return {
    ...login,
    // A passkey says who you are. It cannot decrypt anything, so the vault is still locked.
    needsPassphrase: (await repo.findUserKeys(deps.db, stored.user_id)) === undefined,
  }
}

export async function listCredentials(deps: WebAuthnDeps, userId: string) {
  return deps.db.db
    .selectFrom('webauthn_credentials')
    .selectAll()
    .where('user_id', '=', userId)
    .execute()
}

export async function removeCredential(
  deps: WebAuthnDeps,
  input: { userId: string; credentialRowId: string },
): Promise<void> {
  const stored = await deps.db.db
    .selectFrom('webauthn_credentials')
    .select(['id', 'user_id'])
    .where('id', '=', input.credentialRowId)
    .executeTakeFirst()
  if (!stored) {
    throw notFound()
  }
  if (stored.user_id !== input.userId) {
    throw forbidden()
  }
  await deps.db.db.deleteFrom('webauthn_credentials').where('id', '=', stored.id).execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.userId,
    action: 'passkey.removed',
    subjectKind: 'user',
    subjectId: input.userId,
  })
}

/**
 * Reads the challenge back out of the client data.
 *
 * Taken from the response rather than kept in a cookie or a session, so the flow works for a
 * client that does not hold cookies — the Android app, chiefly. The value is then looked up in the
 * single-use store, which is what makes it trustworthy: an attacker can put any challenge in the
 * client data, but only one the server issued and has not yet spent will be found.
 */
function challengeOf(response: { response: { clientDataJSON: string } }): string {
  try {
    const clientData = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
    ) as { challenge?: string }
    if (!clientData.challenge) {
      throw new Error('no challenge')
    }
    return clientData.challenge
  } catch {
    throw badRequest('auth.error.passkeyFailed')
  }
}
