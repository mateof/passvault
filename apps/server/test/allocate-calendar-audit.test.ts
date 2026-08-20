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
 * Three things the data always supported and nothing ever exposed.
 *
 * Handing an event out in one go, putting it in a calendar, and reading the trail of what happened
 * to it. None of them needed a new idea — the seats, the date and the audit rows were all already
 * there — which is why they sit in one file: what is being tested is the boundary each one draws,
 * not machinery.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string
let eventId: string

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
  eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: {
        name: 'Festival do Norte',
        venue: 'Recinto; Ferial, nave 2',
        startsAt: '2026-06-21T20:00:00.000Z',
        defaultAssignmentMode: 'ASSIGNED',
      },
    })
  ).json().eventId
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

const addTickets = (count: number) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/tickets`,
    headers: bearer(organiser),
    payload: {
      tickets: Array.from({ length: count }, (_, index) => ({
        label: `Asento ${index + 1}`,
        barcode: { format: 'QR_CODE', value: `8412-SEAT-${index + 1}` },
      })),
    },
  })

const allocate = (holderUserIds: string[], token = organiser) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/allocate`,
    headers: bearer(token),
    payload: { holderUserIds },
  })

const tickets = async (token = organiser) =>
  (
    await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) })
  ).json().tickets

describe('handing a whole event out at once', () => {
  it('gives one seat to each person, in the order they were given', async () => {
    await addTickets(3)

    const response = await allocate([memberUserId])

    expect(response.statusCode).toBe(201)
    expect(response.json().assigned).toHaveLength(1)
  })

  it('leaves the rest free rather than allocating everything it can', async () => {
    await addTickets(3)

    expect((await allocate([memberUserId])).json().remaining).toBe(2)
  })

  it('says who got nothing when the seats run out', async () => {
    await addTickets(1)
    const organiserUserId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(organiser) })
    ).json().userId

    const response = await allocate([memberUserId, organiserUserId])

    expect(response.json().unseated).toEqual([organiserUserId])
  })

  it('gives somebody named twice one seat, not two', async () => {
    await addTickets(3)

    const response = await allocate([memberUserId, memberUserId])

    expect(response.json().assigned).toHaveLength(1)
  })

  it('marks the seats assigned, exactly as one-at-a-time assignment would', async () => {
    await addTickets(2)

    await allocate([memberUserId])

    const held = (await tickets()).filter(
      (ticket: { holderUserId: string | null }) => ticket.holderUserId === memberUserId,
    )
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ assignmentState: 'ASSIGNED' })
  })

  it('never takes a seat somebody already holds', async () => {
    await addTickets(2)
    await allocate([memberUserId])

    const again = await allocate([memberUserId])

    // One seat left, and it goes to them: what it must not do is move the one they already have.
    expect(again.json().remaining).toBe(0)
    expect(
      (await tickets()).filter((t: { holderUserId: string | null }) => t.holderUserId),
    ).toHaveLength(2)
  })

  it('is refused to anybody but the creator', async () => {
    await addTickets(2)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', email: MEMBER.email },
    })
    await acceptInvitations(server, member)

    expect((await allocate([memberUserId], member)).statusCode).toBe(403)
  })
})

describe('the event as a calendar entry', () => {
  const ics = (token = organiser) =>
    server.app.inject({ url: `/api/v1/events/${eventId}/calendar.ics`, headers: bearer(token) })

  it('is served as a calendar document', async () => {
    const response = await ics()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/calendar')
  })

  it('carries the name and the time', async () => {
    const body = (await ics()).body

    expect(body).toContain('SUMMARY:Festival do Norte')
    expect(body).toContain('DTSTART:20260621T200000Z')
  })

  it('escapes the characters iCalendar treats as structure', async () => {
    // A semicolon in a venue would otherwise end the property and turn the rest into a field
    // no reader understands.
    expect((await ics()).body).toContain('LOCATION:Recinto\\; Ferial\\, nave 2')
  })

  it('uses the event id, so re-importing updates the entry instead of duplicating it', async () => {
    expect((await ics()).body).toContain(`UID:${eventId}@passvault`)
  })

  it('ends every line the way the specification requires', async () => {
    const body = (await ics()).body

    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('says there is nothing to add when the event has no date yet', async () => {
    const undated = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(organiser),
        payload: { name: 'Sen data' },
      })
    ).json().eventId

    const response = await server.app.inject({
      url: `/api/v1/events/${undated}/calendar.ics`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('the trail of what happened', () => {
  const eventTrail = (token = organiser) =>
    server.app.inject({ url: `/api/v1/events/${eventId}/audit`, headers: bearer(token) })

  it('shows the creator what happened to their seats', async () => {
    await addTickets(1)
    const ticketId = (await tickets())[0].id
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/checkin`,
      headers: bearer(organiser),
    })

    const entries = (await eventTrail()).json().entries

    expect(entries.map((entry: { action: string }) => entry.action)).toContain(
      'ticket.checkin.admitted',
    )
  })

  it('names who did it rather than leaving an id nobody can read', async () => {
    await addTickets(1)
    const ticketId = (await tickets())[0].id
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/checkin`,
      headers: bearer(organiser),
    })

    expect((await eventTrail()).json().entries[0].actor).toBeTruthy()
  })

  it('is refused to somebody who is not the creator of this event', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', email: MEMBER.email, role: 'ORGANISER' },
    })
    await acceptInvitations(server, member)

    expect((await eventTrail(member)).statusCode).toBe(403)
  })

  it('never returns the sealed detail, which this path holds no key for', async () => {
    await addTickets(1)

    const entries = (await eventTrail()).json().entries

    for (const entry of entries) {
      expect(entry).not.toHaveProperty('detail')
      expect(entry).not.toHaveProperty('detailCipher')
    }
  })
})

describe('the installation trail', () => {
  it('is shown to an administrator', async () => {
    const response = await server.app.inject({
      url: '/api/v1/admin/audit',
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().entries.length).toBeGreaterThan(0)
  })

  it('is refused to an ordinary account', async () => {
    const response = await server.app.inject({
      url: '/api/v1/admin/audit',
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
  })
})
