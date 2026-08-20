import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN,
  MEMBER,
  acceptInvitations,
  bearer,
  login,
  registerFirstAdmin,
  setRegistrationMode,
  startTestServer,
  type TestServer,
} from './helpers.js'

/**
 * The queue for a seat that comes back.
 *
 * The property being tested is not the queue — a list in insertion order is not interesting. It is
 * what happens at the front of it, which depends on a decision the creator already made.
 *
 * Under self-claim they have said members take seats themselves, so the queue is only the order
 * people would have raced in and the seat is handed over. Under assigned, giving a seat away is
 * the creator's act; the queue may say somebody is waiting and may not perform it. A queue that
 * quietly handed out bearer tokens under the mode whose entire meaning is "the organiser decides"
 * would be this software overruling a decision made on purpose.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string
let eventId: string
let ticketId: string
let other: string

const OTHER = {
  email: 'brais@example.org',
  password: 'terceira-clave-longa-abondo',
  passphrase: 'frase do baul de brais',
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
  memberUserId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).json()
    .userId
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

/** An event in the given mode, shared with the member, holding one seat. */
const setup = async (mode: 'ASSIGNED' | 'SELF_CLAIM') => {
  eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival', defaultAssignmentMode: mode },
    })
  ).json().eventId
  ticketId = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: { tickets: [{ label: 'Un', barcode: { format: 'QR_CODE', value: 'CODE-1' } }] },
    })
  ).json().ticketIds[0]
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: MEMBER.email },
  })
  await acceptInvitations(server, member)
}

const join = (token = member) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/waitlist`,
    headers: bearer(token),
  })

const waiting = (token = organiser) =>
  server.app.inject({ url: `/api/v1/events/${eventId}/waitlist`, headers: bearer(token) })

/**
 * A third account, shared into the event. Needed because the interesting case is somebody
 * *else* handing a seat back — the queue must not offer a seat to whoever just returned it.
 */
const addThirdPerson = async (): Promise<string> => {
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: OTHER })
  other = await login(server, OTHER)
  await unlock(other, OTHER.passphrase)
  const userId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(other) })).json()
    .userId
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: OTHER.email },
  })
  await acceptInvitations(server, other)
  return userId
}

const ticketRow = async () =>
  await server.db.db
    .selectFrom('tickets')
    .selectAll()
    .where('id', '=', ticketId)
    .executeTakeFirstOrThrow()

/** The organiser takes the seat, then hands it straight back, which is what frees one. */
const assignThenReturn = async () => {
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/tickets/${ticketId}/assign`,
    headers: bearer(organiser),
    payload: { holderUserId: memberUserId },
  })
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/tickets/${ticketId}/return`,
    headers: bearer(member),
  })
}

describe('joining the queue', () => {
  it('puts somebody the event was shared with in it', async () => {
    await setup('ASSIGNED')

    const response = await join()

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ position: 1 })
  })

  it('asking twice is asking once', async () => {
    await setup('ASSIGNED')
    await join()
    await join()

    expect((await waiting()).json().waiting).toHaveLength(1)
  })

  it('refuses the creator, who already holds every seat nobody else does', async () => {
    await setup('ASSIGNED')

    expect((await join(organiser)).statusCode).toBe(400)
  })

  it('is a list only the creator may read', async () => {
    await setup('ASSIGNED')
    await join()

    expect((await waiting(member)).statusCode).toBe(403)
  })

  it('can be left again', async () => {
    await setup('ASSIGNED')
    await join()

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/waitlist`,
      headers: bearer(member),
    })

    expect((await waiting()).json().waiting).toHaveLength(0)
  })
})

describe('a seat coming back under self-claim', () => {
  it('goes to the first person waiting, because the creator already delegated that', async () => {
    await setup('SELF_CLAIM')
    // A third person holds the seat and hands it back, so the one waiting is genuinely waiting
    // rather than being offered the seat they themselves returned.
    const otherUserId = await addThirdPerson()
    await join()

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: otherUserId },
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/return`,
      headers: bearer(other),
    })

    expect((await ticketRow()).holder_user_id).toBe(memberUserId)
    expect((await ticketRow()).assignment_state).toBe('CLAIMED')
  })

  it('takes them off the list once they have it', async () => {
    await setup('SELF_CLAIM')
    const otherUserId = await addThirdPerson()
    await join()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: otherUserId },
    })

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/return`,
      headers: bearer(other),
    })

    expect((await waiting()).json().waiting).toHaveLength(0)
  })

  it('never offers somebody the seat they just handed back', async () => {
    await setup('SELF_CLAIM')
    await join()

    await assignThenReturn()

    // They returned it themselves, so the queue must not turn round and give it straight back.
    expect((await ticketRow()).holder_user_id).toBeNull()
  })
})

describe('a seat coming back under assignment', () => {
  it('is not handed over: giving a seat away is the creator’s act', async () => {
    await setup('ASSIGNED')
    await join()

    await assignThenReturn()

    expect((await ticketRow()).holder_user_id).toBeNull()
    expect((await ticketRow()).assignment_state).toBe('FREE')
  })

  it('leaves the person on the list rather than quietly dropping them', async () => {
    await setup('ASSIGNED')
    await join()

    await assignThenReturn()

    expect((await waiting()).json().waiting).toHaveLength(1)
  })
})

describe('when a seat frees and nobody is waiting', () => {
  it('changes nothing, and the return still works', async () => {
    await setup('ASSIGNED')

    await assignThenReturn()

    expect((await ticketRow()).assignment_state).toBe('FREE')
  })
})
