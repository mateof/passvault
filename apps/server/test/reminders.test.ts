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
 * The only thing on this server that speaks first.
 *
 * Two properties carry the whole feature. It says something when the condition holds — the night
 * is close, the code is about to open, the seat is still unpaid — and it says it exactly once,
 * however many times the sweep runs. The second is the one that would ruin it: a reminder that
 * repeats every five minutes is not a reminder, it is a reason to turn notifications off.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string

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

const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

const makeEvent = async (startsAt: string | undefined) =>
  (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: {
        name: 'Festival',
        defaultAssignmentMode: 'ASSIGNED',
        ...(startsAt ? { startsAt } : {}),
      },
    })
  ).json().eventId

const addTicket = async (eventId: string) =>
  (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: { tickets: [{ label: 'Un', barcode: { format: 'QR_CODE', value: 'CODE-1' } }] },
    })
  ).json().ticketIds[0]

const shareAndAssign = async (eventId: string, ticketId: string) => {
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: MEMBER.email },
  })
  await acceptInvitations(server, member)
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/tickets/${ticketId}/assign`,
    headers: bearer(organiser),
    payload: { holderUserId: memberUserId },
  })
}

/** The stored kinds for one person, which is where the subject is recorded. */
const kindsFor = async (userId: string): Promise<string[]> => {
  const rows = await server.db.db
    .selectFrom('notifications')
    .select('kind')
    .where('user_id', '=', userId)
    .execute()
  return rows.map((row) => row.kind)
}

/**
 * Through the endpoint rather than the function, so what is exercised is what an installation
 * actually runs — the authorisation included.
 */
const sweep = () =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/admin/reminders/sweep',
    headers: bearer(organiser),
  })

describe('an event that is tomorrow', () => {
  it('tells the people holding a seat', async () => {
    const eventId = await makeEvent(inHours(12))
    await shareAndAssign(eventId, await addTicket(eventId))

    await sweep()

    expect(await kindsFor(memberUserId)).toContain(`reminder.eventTomorrow:${eventId}`)
  })

  it('tells the creator too, since they have to be there as well', async () => {
    const eventId = await makeEvent(inHours(12))
    const organiserUserId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(organiser) })
    ).json().userId

    await sweep()

    expect(await kindsFor(organiserUserId)).toContain(`reminder.eventTomorrow:${eventId}`)
  })

  it('says it once, however many times the sweep runs', async () => {
    const eventId = await makeEvent(inHours(12))
    await shareAndAssign(eventId, await addTicket(eventId))

    await sweep()
    await sweep()
    await sweep()

    const said = (await kindsFor(memberUserId)).filter(
      (kind) => kind === `reminder.eventTomorrow:${eventId}`,
    )
    expect(said).toHaveLength(1)
  })
})

describe('an event still weeks away', () => {
  it('is left alone', async () => {
    const eventId = await makeEvent(inHours(24 * 30))
    await shareAndAssign(eventId, await addTicket(eventId))

    await sweep()

    expect(await kindsFor(memberUserId)).not.toContain(`reminder.eventTomorrow:${eventId}`)
  })
})

describe('an event with no date', () => {
  it('produces nothing, rather than being treated as imminent', async () => {
    const eventId = await makeEvent(undefined)
    await shareAndAssign(eventId, await addTicket(eventId))

    const result = await sweep()

    expect(result.json().sent).toBe(0)
  })
})

describe('a code about to open', () => {
  it('tells the holder before it does, not only if they happen to be looking', async () => {
    const eventId = await makeEvent(inHours(24 * 10))
    const ticketId = await addTicket(eventId)
    await shareAndAssign(eventId, ticketId)
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/visibility`,
      headers: bearer(organiser),
      payload: { visibleFrom: inHours(0.5) },
    })

    await sweep()

    expect(await kindsFor(memberUserId)).toContain(`reminder.codeOpening:${ticketId}`)
  })

  it('says nothing about one that opens next month', async () => {
    const eventId = await makeEvent(inHours(24 * 40))
    const ticketId = await addTicket(eventId)
    await shareAndAssign(eventId, ticketId)
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/visibility`,
      headers: bearer(organiser),
      payload: { visibleFrom: inHours(24 * 30) },
    })

    await sweep()

    expect(await kindsFor(memberUserId)).not.toContain(`reminder.codeOpening:${ticketId}`)
  })
})

describe('a seat still unpaid with the night approaching', () => {
  it('tells whoever holds it', async () => {
    const eventId = await makeEvent(inHours(48))
    const ticketId = await addTicket(eventId)
    await shareAndAssign(eventId, ticketId)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/payment`,
      headers: bearer(organiser),
      payload: { state: 'UNPAID', amountCents: 2600, currency: 'EUR', visibility: 'ALL' },
    })

    await sweep()

    expect(await kindsFor(memberUserId)).toContain(`reminder.unpaid:${ticketId}`)
  })

  it('says nothing about one already settled', async () => {
    const eventId = await makeEvent(inHours(48))
    const ticketId = await addTicket(eventId)
    await shareAndAssign(eventId, ticketId)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/payment`,
      headers: bearer(organiser),
      payload: { state: 'PAID', visibility: 'ALL' },
    })

    await sweep()

    expect(await kindsFor(memberUserId)).not.toContain(`reminder.unpaid:${ticketId}`)
  })
})

describe('seats nobody has taken', () => {
  it('tells the creator while there is still time to give them away', async () => {
    const eventId = await makeEvent(inHours(48))
    await addTicket(eventId)
    const organiserUserId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(organiser) })
    ).json().userId

    await sweep()

    expect(await kindsFor(organiserUserId)).toContain(`reminder.seatsUnclaimed:${eventId}`)
  })

  it('says nothing when every seat has a holder', async () => {
    const eventId = await makeEvent(inHours(48))
    await shareAndAssign(eventId, await addTicket(eventId))
    const organiserUserId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(organiser) })
    ).json().userId

    await sweep()

    expect(await kindsFor(organiserUserId)).not.toContain(`reminder.seatsUnclaimed:${eventId}`)
  })
})
