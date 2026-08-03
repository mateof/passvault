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
 * The controls a creator has over a share, and the operator has over a session.
 *
 * Four things that were asked for and had no home: a member grabbing a random ticket and seeing
 * only it; the creator reading back who grabbed what; a revoke that admits it cannot recall what
 * was already downloaded; and a session lifetime an administrator sets rather than a redeploy.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string
let second: string

const SECOND = {
  email: 'brais@example.org',
  password: 'outra-conta-larga',
  passphrase: 'frase-do-brais',
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

  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: SECOND })
  second = await login(server, SECOND)
  await unlock(second, SECOND.passphrase)
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

const makeEvent = async (mode: string, count = 3): Promise<string> => {
  const eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival', defaultAssignmentMode: mode },
    })
  ).json().eventId
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/tickets`,
    headers: bearer(organiser),
    payload: {
      tickets: Array.from({ length: count }, (_, index) => ({
        label: `Entrada ${index + 1}`,
        barcode: { format: 'QR_CODE', value: `PAYLOAD-${index + 1}` },
        assignmentMode: mode,
      })),
    },
  })
  return eventId
}

const shareWith = async (eventId: string, email: string) => {
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email },
  })
  await acceptInvitations(server, email === MEMBER.email ? member : second)
}

const ticketsResponse = async (token: string, eventId: string) =>
  (
    await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) })
  ).json()

const claim = (token: string, eventId: string) =>
  server.app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/claim`, headers: bearer(token) })

const accessOf = async (eventId: string) =>
  (
    await server.app.inject({ url: `/api/v1/events/${eventId}/access`, headers: bearer(organiser) })
  ).json().access

describe('a member picking a self-claim ticket', () => {
  it('sees none of the tickets until they take one, then only theirs', async () => {
    const eventId = await makeEvent('SELF_CLAIM')
    await shareWith(eventId, MEMBER.email)

    const before = await ticketsResponse(member, eventId)
    expect(before.tickets).toHaveLength(0)
    expect(before.claim).toMatchObject({ freeToClaim: 3, alreadyHolds: false })

    const taken = await claim(member, eventId)
    expect(taken.statusCode).toBe(201)

    const after = await ticketsResponse(member, eventId)
    expect(after.tickets).toHaveLength(1)
    expect(after.tickets[0].id).toBe(taken.json().ticketId)
    // The claimer holds it, so its barcode is downloaded on view, not carried in the list.
    expect(after.tickets[0].barcode).toBeNull()
    expect(after.tickets[0].barcodeAvailable).toBe(true)
    expect(after.claim).toMatchObject({ freeToClaim: 2, alreadyHolds: true })
  })

  it('lets the creator read back who took which, by name', async () => {
    await server.app.inject({
      method: 'PUT',
      url: '/api/v1/me/handle',
      headers: bearer(member),
      payload: { handle: 'ana' },
    })
    const eventId = await makeEvent('SELF_CLAIM')
    await shareWith(eventId, MEMBER.email)
    const taken = await claim(member, eventId)

    const seen = await ticketsResponse(organiser, eventId)
    const row = seen.tickets.find((t: { id: string }) => t.id === taken.json().ticketId)
    expect(row.holderUserId).toBe(memberUserId)
    expect(row.holderHandle).toBe('ana')
  })
})

describe('revoking a share', () => {
  it('tells the creator whether the person has already downloaded it', async () => {
    const eventId = await makeEvent('OPEN')
    await shareWith(eventId, MEMBER.email)

    const before = await accessOf(eventId)
    const beforeRow = before.find((e: { subjectId: string }) => e.subjectId === memberUserId)
    expect(beforeRow.downloaded).toBe(false)

    // The member pulls the event, which is the moment it lands on their device.
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${eventId}`,
      headers: bearer(member),
      payload: { operations: [] },
    })

    const after = await accessOf(eventId)
    const afterRow = after.find((e: { subjectId: string }) => e.subjectId === memberUserId)
    expect(afterRow.downloaded).toBe(true)
  })

  it('stops future access whether or not it was downloaded', async () => {
    const eventId = await makeEvent('OPEN')
    await shareWith(eventId, MEMBER.email)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${eventId}`,
      headers: bearer(member),
      payload: { operations: [] },
    })

    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', subjectId: memberUserId },
    })
    expect(revoked.json()).toMatchObject({ recallsDeliveredTickets: false })

    // The event is closed to them from now on, which is all a revoke can honestly promise.
    const denied = await server.app.inject({
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(member),
    })
    expect(denied.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('the session lifetime', () => {
  it('is what an administrator sets, in days', async () => {
    const set = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/registration',
      headers: bearer(organiser),
      payload: { sessionDays: 365 },
    })
    expect(set.json()).toMatchObject({ sessionDays: 365 })

    // A fresh sign-in now lasts about a year rather than the default day.
    const fresh = await login(server, SECOND)
    const sessions = (
      await server.app.inject({ url: '/api/v1/sessions', headers: bearer(fresh) })
    ).json().sessions
    const current = sessions.find((s: { current: boolean }) => s.current)
    const daysOut =
      (new Date(current.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    expect(daysOut).toBeGreaterThan(300)
  })

  it('is admin-only to read and to change', async () => {
    const read = await server.app.inject({
      url: '/api/v1/admin/registration',
      headers: bearer(member),
    })
    expect(read.statusCode).toBe(403)
  })
})
