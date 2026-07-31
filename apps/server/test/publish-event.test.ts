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
 * An event built on a phone, arriving at a server for the first time.
 *
 * This is how the product is meant to be used — the app works with no server at all, and a server
 * is something you add later — and until now it could not happen. Synchronisation only exchanged
 * the log of events the server already had, so a wallet made offline stayed offline: counted as
 * "local only" and skipped, with the screen reporting a successful sync that had moved nothing.
 *
 * The tests sign with real Ed25519 keys, because what makes adopting an event safe is the
 * signature check, and a test that stubs it proves nothing about the thing worth proving.
 */
let server: TestServer
let organiser: string
let stranger: string
let device: { id: string; signing: ReturnType<typeof generateSigningKeyPair> }

/** An event created on the phone: an id it minted itself, and no counterpart anywhere. */
let localEventId: string

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  organiser = await login(server, ADMIN)
  await unlock(organiser, ADMIN.passphrase)
  await setRegistrationMode(server, organiser, 'OPEN')
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  stranger = await login(server, MEMBER)
  await unlock(stranger, MEMBER.passphrase)

  device = await registerDevice(organiser, 'O meu móbil')
  localEventId = newId()
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

async function registerDevice(
  token: string,
  name: string,
): Promise<{ id: string; signing: ReturnType<typeof generateSigningKeyPair> }> {
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

function sign(
  by: { id: string; signing: ReturnType<typeof generateSigningKeyPair> },
  operation: { type: string; body: Record<string, unknown>; lamport: number; eventId?: string },
): SignedOperation {
  const unsigned = {
    operationId: newId(),
    deviceId: by.id,
    actorUserId: null,
    lamport: operation.lamport,
    wallClock: toInstant(),
    scope: { kind: 'event' as const, id: operation.eventId ?? localEventId },
    type: operation.type,
    body: operation.body,
  }
  return {
    ...unsigned,
    signature: toBase64Url(signBytes(by.signing.privateKey, signingInput(unsigned))),
  }
}

/** What the phone's log holds for an event it made: the creation, then a ticket per pass. */
const walletFromThePhone = (ticketIds: string[]): SignedOperation[] => [
  sign(device, { type: 'event.create', lamport: 1, body: { name: 'Festival do Norte 2026' } }),
  ...ticketIds.map((ticketId, index) =>
    sign(device, {
      type: 'ticket.add',
      lamport: index + 2,
      body: {
        ticketId,
        label: `Entrada ${index + 1}`,
        barcodeFormat: 'QR_CODE',
        barcodeValue: `8412-LOCAL-${index}`,
      },
    }),
  ),
]

const syncAs = (token: string, operations: SignedOperation[], eventId = localEventId) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/sync/${eventId}`,
    headers: bearer(token),
    payload: { operations },
  })

describe('an event that exists only on a phone', () => {
  it('is created on the server by synchronising it', async () => {
    const response = await syncAs(organiser, walletFromThePhone([newId()]))

    expect(response.statusCode).toBe(200)
    expect(response.json().created).toBe(true)
  })

  it('keeps the identifier the phone gave it, or every operation about it is orphaned', async () => {
    await syncAs(organiser, walletFromThePhone([newId()]))

    const events = await server.app.inject({ url: '/api/v1/events', headers: bearer(organiser) })

    expect(events.json().events.map((event: { id: string }) => event.id)).toContain(localEventId)
  })

  it('arrives with its name, which lives in the operation rather than in a form', async () => {
    await syncAs(organiser, walletFromThePhone([newId()]))

    const event = await server.app.inject({
      url: `/api/v1/events/${localEventId}`,
      headers: bearer(organiser),
    })

    expect(event.json().name).toBe('Festival do Norte 2026')
  })

  it('brings its tickets with it', async () => {
    const ticketIds = [newId(), newId(), newId()]

    await syncAs(organiser, walletFromThePhone(ticketIds))
    const tickets = await server.app.inject({
      url: `/api/v1/events/${localEventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(tickets.json().tickets).toHaveLength(3)
  })

  it('keeps each ticket identifier, so a later assignment still finds its ticket', async () => {
    const ticketId = newId()
    await syncAs(organiser, walletFromThePhone([ticketId]))

    await syncAs(organiser, [
      sign(device, {
        type: 'ticket.assign',
        lamport: 10,
        body: { ticketId, holderLabel: 'Brais' },
      }),
    ])
    const tickets = await server.app.inject({
      url: `/api/v1/events/${localEventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(tickets.json().tickets[0]).toMatchObject({ assignmentState: 'ASSIGNED' })
  })

  it('carries the barcode, which is the thing the ticket is for', async () => {
    const ticketId = newId()

    await syncAs(organiser, walletFromThePhone([ticketId]))
    const tickets = await server.app.inject({
      url: `/api/v1/events/${localEventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(tickets.json().tickets[0].barcode).toMatchObject({
      format: 'QR_CODE',
      value: '8412-LOCAL-0',
    })
  })

  it('is created once, so syncing twice does not duplicate anything', async () => {
    const operations = walletFromThePhone([newId(), newId()])
    await syncAs(organiser, operations)

    const second = await syncAs(organiser, operations)
    const tickets = await server.app.inject({
      url: `/api/v1/events/${localEventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(second.json().created).toBe(false)
    expect(tickets.json().tickets).toHaveLength(2)
  })

  it('takes an event password, which keeps the operator out of it exactly as before', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${localEventId}`,
      headers: bearer(organiser),
      payload: { operations: walletFromThePhone([newId()]), eventPassword: 'un contrasinal' },
    })

    expect(response.json().created).toBe(true)
    const event = await server.app.inject({
      url: `/api/v1/events/${localEventId}`,
      headers: bearer(organiser),
    })
    expect(event.json().passwordProtected).toBe(true)
  })
})

describe('what adopting an event refuses', () => {
  it('a batch that does not declare the event at all', async () => {
    const response = await syncAs(organiser, [
      sign(device, { type: 'ticket.add', lamport: 1, body: { ticketId: newId() } }),
    ])

    // No `event.create`, so there is nothing to create the event from and the event does not exist.
    expect(response.statusCode).toBe(404)
  })

  it('a declaration signed by a device belonging to somebody else', async () => {
    const theirDevice = await registerDevice(stranger, 'Outro móbil')

    const response = await syncAs(organiser, [
      sign(theirDevice, { type: 'event.create', lamport: 1, body: { name: 'Non é meu' } }),
    ])

    expect(response.statusCode).toBe(404)
  })

  it('a declaration whose signature does not verify', async () => {
    const [declaration, ...rest] = walletFromThePhone([newId()])
    const tampered = { ...declaration!, body: { name: 'Outro nome' } }

    const response = await syncAs(organiser, [tampered, ...rest])

    expect(response.statusCode).toBe(404)
  })

  it('a declaration scoped to a different event than the one being synchronised', async () => {
    const elsewhere = sign(device, {
      type: 'event.create',
      lamport: 1,
      body: { name: 'Outro evento' },
      eventId: newId(),
    })

    const response = await syncAs(organiser, [elsewhere])

    expect(response.statusCode).toBe(404)
  })

  it('an event somebody else already created, which is not theirs to take over', async () => {
    await syncAs(organiser, walletFromThePhone([newId()]))
    const theirDevice = await registerDevice(stranger, 'Outro móbil')

    const response = await syncAs(
      stranger,
      [sign(theirDevice, { type: 'event.create', lamport: 1, body: { name: 'Meu agora' } })],
      localEventId,
    )

    expect(response.statusCode).toBe(403)
  })
})
