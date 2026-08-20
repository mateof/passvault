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
 * Working the door.
 *
 * What is tested here is not access control at a turnstile — this cannot provide that, and the
 * threat model says so plainly. It is that the *second* presentation of a code is noticed while
 * somebody is standing there, instead of being discovered by whoever gets refused.
 *
 * So the properties that matter are: a real code admits once, the same code again says it has
 * already been through and when, a code belonging to no ticket of this event answers rather than
 * failing, and only somebody trusted with the door can ask any of it.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string
let eventId: string
let ticketId: string

const CODE = '8412-DOOR-0001'

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
      payload: { name: 'Festival', defaultAssignmentMode: 'ASSIGNED' },
    })
  ).json().eventId
  ticketId = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: { tickets: [{ label: 'Fila 3', barcode: { format: 'QR_CODE', value: CODE } }] },
    })
  ).json().ticketIds[0]
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

const scan = (value: string, token = organiser) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/checkin`,
    headers: bearer(token),
    payload: { value },
  })

const listed = async (token = organiser) => {
  const tickets = (
    await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) })
  ).json().tickets
  return tickets.find((ticket: { id: string }) => ticket.id === ticketId)
}

const shareWithMember = async (role?: 'ORGANISER') => {
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: MEMBER.email, ...(role ? { role } : {}) },
  })
  await acceptInvitations(server, member)
}

describe('a code presented at the door', () => {
  it('is admitted the first time', async () => {
    expect((await scan(CODE)).json()).toMatchObject({ outcome: 'ADMITTED', usedCount: 1 })
  })

  it('names the seat, so the person on the door can say something useful', async () => {
    expect((await scan(CODE)).json()).toMatchObject({ label: 'Fila 3' })
  })

  it('says it has already been through when it comes back', async () => {
    await scan(CODE)

    expect((await scan(CODE)).json()).toMatchObject({ outcome: 'ALREADY_USED', usedCount: 2 })
  })

  it('reports when it first went in, which is the question being asked', async () => {
    await scan(CODE)
    const admitted = (await listed()).usedAt

    expect((await scan(CODE)).json().firstUsedAt).toBe(admitted)
  })

  it('keeps the first admission time rather than moving it on every scan', async () => {
    await scan(CODE)
    const after = (await listed()).usedAt
    await scan(CODE)

    expect((await listed()).usedAt).toBe(after)
  })

  it('counts every presentation, so a third arrival does not look like the second', async () => {
    await scan(CODE)
    await scan(CODE)
    await scan(CODE)

    expect((await listed()).usedCount).toBe(3)
  })
})

describe('a code that belongs to no ticket here', () => {
  it('answers rather than failing, because a queue is no place for an error page', async () => {
    const response = await scan('SOMETHING-ELSE')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ outcome: 'UNKNOWN' })
  })
})

describe('a seat the creator has withdrawn', () => {
  it('is refused at the door rather than quietly admitted', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/withdraw`,
      headers: bearer(organiser),
    })

    expect((await scan(CODE)).json()).toMatchObject({ outcome: 'WITHDRAWN' })
  })
})

describe('who may work the door', () => {
  it('refuses somebody the event was never shared with', async () => {
    expect((await scan(CODE, member)).statusCode).toBe(403)
  })

  it('refuses an ordinary member: a seat is not the guest list', async () => {
    await shareWithMember()

    expect((await scan(CODE, member)).statusCode).toBe(403)
  })

  it('lets an organiser of the event do it', async () => {
    await shareWithMember('ORGANISER')

    expect((await scan(CODE, member)).json()).toMatchObject({ outcome: 'ADMITTED' })
  })
})

describe('correcting a mistake', () => {
  const undo = () =>
    server.app.inject({
      method: 'DELETE',
      url: `/api/v1/tickets/${ticketId}/checkin`,
      headers: bearer(organiser),
    })

  it('puts the seat back to never having been through', async () => {
    await scan(CODE)
    await scan(CODE)

    await undo()

    expect(await listed()).toMatchObject({ usedAt: null, usedCount: 0 })
  })

  it('admits it again afterwards, rather than leaving it accused of a repeat', async () => {
    await scan(CODE)
    await undo()

    expect((await scan(CODE)).json()).toMatchObject({ outcome: 'ADMITTED', usedCount: 1 })
  })
})

describe('a seat marked used off the list', () => {
  it('is admitted with nothing scanned, for a phone that will not turn on', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/checkin`,
      headers: bearer(organiser),
    })

    expect(response.json()).toMatchObject({ outcome: 'ADMITTED' })
  })
})

describe('the record it leaves', () => {
  it('writes an audit line for every presentation, admitted or not', async () => {
    await scan(CODE)
    await scan(CODE)

    const audit = await server.db.db
      .selectFrom('audit_events')
      .select('action')
      .where('subject_id', '=', ticketId)
      .execute()

    expect(audit.map((row) => row.action).sort()).toEqual([
      'ticket.checkin.admitted',
      'ticket.checkin.already_used',
    ])
  })

  it('does not name a holder for a seat nobody holds', async () => {
    expect((await scan(CODE)).json().holder).toBeNull()
  })

  it('names the holder once the seat has one', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: bearer(organiser),
      payload: { holderLabel: 'Brais' },
    })

    expect((await scan(CODE)).json().holder).toBe('Brais')
  })
})

describe('what the list says about the door', () => {
  it('shows a seat as unused before anybody arrives', async () => {
    expect(await listed()).toMatchObject({ usedAt: null, usedCount: 0 })
  })

  it('tells the holder their own seat has been through', async () => {
    await shareWithMember()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: memberUserId },
    })
    await scan(CODE)

    expect((await listed(member)).usedCount).toBe(1)
  })
})
