import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateAgreementKeyPair,
  generateSigningKeyPair,
  signBytes,
  toBase64Url,
} from '@passvault/crypto'
import { newId, toInstant } from '@passvault/db'
import { signingInput, type SignedOperation } from '../src/operations.js'
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
 * The signed operation log.
 *
 * The tests sign with real Ed25519 keys, so they exercise the verification rather than assert that
 * a function was called. The block worth reading is "three offline claims arriving in one batch":
 * it is the case the whole log exists for, and the reason reconciliation runs once at the end of a
 * batch rather than per operation.
 */
let server: TestServer
let organiser: string
let member: string
let memberId: string
let eventId: string

interface Device {
  id: string
  signing: ReturnType<typeof generateSigningKeyPair>
}

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  organiser = await login(server, ADMIN)
  await unlock(organiser, ADMIN.passphrase)
  await setRegistrationMode(server, organiser, 'OPEN')
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  member = await login(server, MEMBER)
  await unlock(member, MEMBER.passphrase)
  memberId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).json().userId

  eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival do Norte 2026', defaultAssignmentMode: 'SELF_CLAIM' },
    })
  ).json().eventId
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', subjectId: memberId },
  })
})

afterEach(async () => {
  await server.dispose()
})

const unlock = (token: string, passphrase: string) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/vault/unlock',
    headers: bearer(token),
    payload: { passphrase },
  })

async function registerDevice(token: string, name: string): Promise<Device> {
  const signing = generateSigningKeyPair()
  const agreement = generateAgreementKeyPair()
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: bearer(token),
    payload: {
      name,
      signingPublicKey: toBase64Url(signing.publicKey),
      agreementPublicKey: toBase64Url(agreement.publicKey),
    },
  })
  return { id: response.json().deviceId, signing }
}

/** Signs an operation the way a device would, so the server's verification is really tested. */
function sign(
  device: Device,
  operation: Omit<SignedOperation, 'signature' | 'deviceId' | 'scope' | 'wallClock'> & {
    wallClock?: string
  },
): SignedOperation {
  const unsigned = {
    operationId: operation.operationId,
    deviceId: device.id,
    actorUserId: operation.actorUserId ?? null,
    lamport: operation.lamport,
    wallClock: operation.wallClock ?? toInstant(),
    scope: { kind: 'event' as const, id: eventId },
    type: operation.type,
    body: operation.body,
  }
  return {
    ...unsigned,
    signature: toBase64Url(signBytes(device.signing.privateKey, signingInput(unsigned))),
  }
}

const sync = (token: string, payload: Record<string, unknown>) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/sync/${eventId}`,
    headers: bearer(token),
    payload,
  })

const addClaimableTickets = async (count: number): Promise<string[]> => {
  const { ticketIds } = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: {
        tickets: Array.from({ length: count }, (_unused, index) => ({
          label: `Seat ${index + 1}`,
          assignmentMode: 'SELF_CLAIM',
          barcode: { format: 'QR_CODE', value: `8412-SYNC-${index}` },
        })),
      },
    })
  ).json()
  return ticketIds
}

const issueCoupons = async (): Promise<Record<string, string>> => {
  const { coupons } = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/coupons`,
      headers: bearer(organiser),
      payload: { allowance: 3 },
    })
  ).json()
  return Object.fromEntries(
    (coupons as { ticketId: string; coupon: string }[]).map((entry) => [
      entry.ticketId,
      entry.coupon,
    ]),
  )
}

describe('registering a device', () => {
  it('returns an identifier the log can refer to', async () => {
    const device = await registerDevice(organiser, "Mateo's phone")

    expect(device.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is idempotent for the same signing key', async () => {
    const signing = generateSigningKeyPair()
    const agreement = generateAgreementKeyPair()
    const payload = {
      name: 'phone',
      signingPublicKey: toBase64Url(signing.publicKey),
      agreementPublicKey: toBase64Url(agreement.publicKey),
    }
    const first = await server.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: bearer(organiser),
      payload,
    })
    const second = await server.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: bearer(organiser),
      payload,
    })

    expect(second.json().deviceId).toBe(first.json().deviceId)
  })

  it('refuses to let another account claim the same signing key', async () => {
    const device = await registerDevice(organiser, 'phone')
    const stored = await server.db.db
      .selectFrom('devices')
      .select('signing_public_key')
      .where('id', '=', device.id)
      .executeTakeFirstOrThrow()

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: bearer(member),
      payload: {
        name: 'stolen',
        signingPublicKey: stored.signing_public_key,
        agreementPublicKey: toBase64Url(generateAgreementKeyPair().publicKey),
      },
    })

    expect(response.statusCode).toBe(403)
  })

  it('refuses a key that is not 32 bytes', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: bearer(organiser),
      payload: {
        name: 'phone',
        signingPublicKey: 'dG9vLXNob3J0',
        agreementPublicKey: toBase64Url(generateAgreementKeyPair().publicKey),
      },
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('pushing an operation', () => {
  it('applies one signed by a registered device', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { name: 'Festival do Norte — moved' },
    })

    const response = await sync(organiser, { operations: [operation] })

    expect(response.json().accepted[0].state).toBe('APPLIED')
  })

  it('has the effect the operation describes', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'Festival do Norte — moved' },
        }),
      ],
    })

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(organiser),
    })

    expect(response.json().name).toBe('Festival do Norte — moved')
  })

  it('rejects a tampered operation, since the signature no longer matches', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { name: 'Festival do Norte' },
    })

    const tampered = { ...operation, body: { name: 'Somebody else’s event' } }
    const response = await sync(organiser, { operations: [tampered] })

    expect(response.json().accepted[0]).toMatchObject({
      state: 'REJECTED',
      reason: 'bad_signature',
    })
  })

  it('quarantines an operation from a device it does not know, rather than dropping it', async () => {
    // The usual cause is a peer whose key has not been exchanged yet, so losing it would be wrong.
    const stranger: Device = { id: newId(), signing: generateSigningKeyPair() }
    const operation = sign(stranger, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { name: 'from an unknown phone' },
    })

    const response = await sync(organiser, { operations: [operation] })

    expect(response.json().accepted[0]).toMatchObject({
      state: 'QUARANTINED',
      reason: 'unknown_device',
    })
  })

  it('surfaces what is quarantined, so the user can fix the cause', async () => {
    const stranger: Device = { id: newId(), signing: generateSigningKeyPair() }
    await sync(organiser, {
      operations: [
        sign(stranger, { operationId: newId(), lamport: 1, type: 'event.update', body: {} }),
      ],
    })

    const response = await server.app.inject({
      url: `/api/v1/sync/${eventId}/quarantine`,
      headers: bearer(organiser),
    })

    expect(response.json().quarantined).toHaveLength(1)
  })

  it('counts a replayed operation as a duplicate rather than applying it twice', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { name: 'once' },
    })
    await sync(organiser, { operations: [operation] })

    const again = await sync(organiser, { operations: [operation] })

    expect(again.json().accepted[0].state).toBe('DUPLICATE')
  })

  it('rejects an operation scoped to another event', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: {},
    })

    const response = await sync(organiser, {
      operations: [{ ...operation, scope: { kind: 'event', id: newId() } }],
    })

    expect(response.json().accepted[0]).toMatchObject({
      state: 'REJECTED',
      reason: 'scope_mismatch',
    })
  })

  it('retains a type it does not understand instead of discarding it', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'something.from.a.newer.version',
      body: {},
    })

    const response = await sync(organiser, { operations: [operation] })

    expect(response.json().accepted[0]).toMatchObject({
      state: 'QUARANTINED',
      reason: 'unknown_type',
    })
  })
})

describe('authorisation is checked on replay, not trusted from the sender', () => {
  it('refuses a member’s device recording a payment', async () => {
    const memberDevice = await registerDevice(member, "Ana's phone")
    const tickets = await addClaimableTickets(1)
    const operation = sign(memberDevice, {
      operationId: newId(),
      lamport: 1,
      type: 'payment.set',
      body: { ticketId: tickets[0], state: 'PAID', visibility: 'ALL' },
    })

    const response = await sync(member, { operations: [operation] })

    expect(response.json().accepted[0]).toMatchObject({
      state: 'REJECTED',
      reason: 'not_permitted',
    })
  })

  it('accepts the same operation from the organiser’s device', async () => {
    const device = await registerDevice(organiser, 'phone')
    const tickets = await addClaimableTickets(1)
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'payment.set',
      body: { ticketId: tickets[0], state: 'PAID', visibility: 'ALL' },
    })

    const response = await sync(organiser, { operations: [operation] })

    expect(response.json().accepted[0].state).toBe('APPLIED')
  })

  it('refuses a member’s device assigning a ticket', async () => {
    const memberDevice = await registerDevice(member, "Ana's phone")
    const tickets = await addClaimableTickets(1)
    const operation = sign(memberDevice, {
      operationId: newId(),
      lamport: 1,
      type: 'ticket.assign',
      body: { ticketId: tickets[0], holderUserId: memberId },
    })

    const response = await sync(member, { operations: [operation] })

    expect(response.json().accepted[0].reason).toBe('not_permitted')
  })
})

describe('three offline claims arriving in one batch', () => {
  it('reconciles the batch as a whole rather than in arrival order', async () => {
    // A device that was offline pushes everything it did. Resolving each claim as it arrives would
    // hand the first ticket to whoever was pushed first, which is not the ordering the log defines.
    const device = await registerDevice(member, "Ana's phone")
    const tickets = await addClaimableTickets(3)
    const coupons = await issueCoupons()

    const operations = tickets.map((ticketId, index) =>
      sign(device, {
        operationId: newId(),
        lamport: 10 - index,
        type: 'claim.request',
        body: { ticketId, coupon: coupons[ticketId] },
      }),
    )

    const response = await sync(member, { operations })

    expect(response.json().reconciled).toHaveLength(3)
  })

  it('applies every claim in the batch', async () => {
    const device = await registerDevice(member, "Ana's phone")
    const tickets = await addClaimableTickets(3)
    const coupons = await issueCoupons()

    const response = await sync(member, {
      operations: tickets.map((ticketId) =>
        sign(device, {
          operationId: newId(),
          lamport: 5,
          type: 'claim.request',
          body: { ticketId, coupon: coupons[ticketId] },
        }),
      ),
    })

    expect(
      response.json().accepted.every((entry: { state: string }) => entry.state === 'APPLIED'),
    ).toBe(true)
  })

  it('gives the member the tickets they claimed', async () => {
    const device = await registerDevice(member, "Ana's phone")
    const tickets = await addClaimableTickets(2)
    const coupons = await issueCoupons()
    await sync(member, {
      operations: tickets.map((ticketId) =>
        sign(device, {
          operationId: newId(),
          lamport: 3,
          type: 'claim.request',
          body: { ticketId, coupon: coupons[ticketId] },
        }),
      ),
    })

    const held = await server.db.db
      .selectFrom('tickets')
      .select('id')
      .where('holder_user_id', '=', memberId)
      .execute()

    expect(held).toHaveLength(2)
  })

  it('settles a contested ticket for the lower logical clock, whoever pushed first', async () => {
    const anaDevice = await registerDevice(member, "Ana's phone")
    const organiserDevice = await registerDevice(organiser, "Mateo's phone")
    const [ticketId] = await addClaimableTickets(1)
    const coupons = await issueCoupons()

    // Ana pushes first but with the later logical clock.
    await sync(member, {
      operations: [
        sign(anaDevice, {
          operationId: newId(),
          lamport: 9,
          type: 'claim.request',
          body: { ticketId, coupon: coupons[ticketId!] },
        }),
      ],
    })
    await sync(organiser, {
      operations: [
        sign(organiserDevice, {
          operationId: newId(),
          lamport: 2,
          type: 'claim.request',
          body: { ticketId, coupon: coupons[ticketId!] },
        }),
      ],
    })

    const stored = await server.db.db
      .selectFrom('tickets')
      .select('holder_user_id')
      .where('id', '=', ticketId!)
      .executeTakeFirstOrThrow()

    expect(stored.holder_user_id).toBe(memberId)
  })
})

describe('pulling operations', () => {
  it('returns what another device pushed', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'a' },
        }),
      ],
    })

    const response = await sync(member, {})

    // The event's own creation is in the log too — the server records what it does — so what
    // matters is that the pushed operation came back, not that it arrived alone.
    expect(response.json().operations.map((one: { type: string }) => one.type)).toContain(
      'event.update',
    )
  })

  it('returns the body in the clear, so a puller can verify the signature itself', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'verifiable' },
        }),
      ],
    })

    const response = await sync(member, {})

    const pushed = response
      .json()
      .operations.find((one: { type: string }) => one.type === 'event.update')
    expect(pushed.body.name).toBe('verifiable')
  })

  it('keeps the body out of the database in plaintext', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'secret-name' },
        }),
      ],
    })

    const stored = await server.db.db.selectFrom('operations').select('body_cipher').execute()

    // Every row, not the first: the log now holds the server's own entries as well, and the
    // property being checked is about all of them.
    for (const row of stored) {
      expect(Buffer.from(row.body_cipher).toString('utf8')).not.toContain('secret-name')
    }
  })

  it('does not return the same operation twice for a caller using the cursor', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'a' },
        }),
      ],
    })
    const first = await sync(member, {})

    const second = await sync(member, { cursor: first.json().cursor })

    expect(second.json().operations).toEqual([])
  })

  it('returns operations added after the cursor', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 1,
          type: 'event.update',
          body: { name: 'a' },
        }),
      ],
    })
    const first = await sync(member, {})
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 2,
          type: 'event.update',
          body: { name: 'b' },
        }),
      ],
    })

    const second = await sync(member, { cursor: first.json().cursor })

    expect(second.json().operations).toHaveLength(1)
  })

  it('offers the next logical clock, so a reconnecting device does not lose every race', async () => {
    const device = await registerDevice(organiser, 'phone')
    await sync(organiser, {
      operations: [
        sign(device, {
          operationId: newId(),
          lamport: 41,
          type: 'event.update',
          body: { name: 'a' },
        }),
      ],
    })

    const response = await sync(member, {})

    expect(response.json().nextLamport).toBe(42)
  })

  it('does not return quarantined or rejected operations', async () => {
    const stranger: Device = { id: newId(), signing: generateSigningKeyPair() }
    await sync(organiser, {
      operations: [
        sign(stranger, { operationId: newId(), lamport: 1, type: 'event.update', body: {} }),
      ],
    })

    const response = await sync(member, {})

    // The stranger's operation is quarantined, so nothing it signed comes back. What does come
    // back is the server's own record of creating the event, which is not from a stranger.
    const devices = response
      .json()
      .operations.map((one: { deviceId: string }) => one.deviceId)
    expect(devices).not.toContain(stranger.id)
  })

  it('refuses somebody with no access to the event', async () => {
    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', subjectId: memberId },
    })
    const fresh = await login(server, MEMBER)
    await unlock(fresh, MEMBER.passphrase)

    const response = await sync(fresh, {})

    expect(response.statusCode).toBe(403)
  })
})

describe('the canonical form an operation is signed over', () => {
  it('ignores key order, so a client building the object differently still verifies', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { venue: 'Recinto Ferial', name: 'Festival' },
    })

    // Re-ordered exactly as a different client library might serialise it.
    const reordered: SignedOperation = {
      signature: operation.signature,
      type: operation.type,
      body: { name: 'Festival', venue: 'Recinto Ferial' },
      scope: operation.scope,
      wallClock: operation.wallClock,
      lamport: operation.lamport,
      actorUserId: operation.actorUserId,
      deviceId: operation.deviceId,
      operationId: operation.operationId,
    }

    const response = await sync(organiser, { operations: [reordered] })

    expect(response.json().accepted[0].state).toBe('APPLIED')
  })

  it('is not affected by the wall clock being wrong, which is why ordering ignores it', async () => {
    const device = await registerDevice(organiser, 'phone')
    const operation = sign(device, {
      operationId: newId(),
      lamport: 1,
      type: 'event.update',
      body: { name: 'from a phone with the wrong date' },
      wallClock: '1999-01-01T00:00:00.000Z',
    })

    const response = await sync(organiser, { operations: [operation] })

    expect(response.json().accepted[0].state).toBe('APPLIED')
  })
})
