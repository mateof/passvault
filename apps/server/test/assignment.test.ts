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
 * Who ends up holding which ticket.
 *
 * Three ways, and the difference between them is what a member sees:
 *
 *   * **open** — everybody the event is shared with sees every barcode. Four friends and one
 *     phone at the gate.
 *   * **assigned** — the organiser gives each ticket to a person, and that person sees theirs
 *     and nobody else's.
 *   * **self-claim** — the first to press claim takes a free one, one each.
 *
 * The self-claim case is the one worth reading. Coupons already covered a phone that was offline
 * when it decided; this covers somebody looking at the event, where asking an organiser for a
 * code per seat first would defeat the point of the mode.
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

const makeEvent = async (mode: string, count = 2): Promise<string> => {
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

/** Offers the event and has the recipient accept, which is what puts it in their wallet. */
const shareWith = async (eventId: string, email: string) => {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email },
  })
  await acceptInvitations(server, email === MEMBER.email ? member : second)
  return response
}

const ticketsOf = async (token: string, eventId: string) =>
  (await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) }))
    .json().tickets

const claim = (token: string, eventId: string) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/claim`,
    headers: bearer(token),
  })

describe('an open event', () => {
  it('shows every barcode to everybody it was shared with', async () => {
    const eventId = await makeEvent('OPEN')
    await shareWith(eventId, MEMBER.email)

    const tickets = await ticketsOf(member, eventId)

    expect(tickets).toHaveLength(2)
    expect(tickets.every((ticket: { barcode: unknown }) => ticket.barcode !== null)).toBe(true)
  })
})

describe('an event the organiser assigns', () => {
  it('shows a member the barcode of their own ticket and no other', async () => {
    const eventId = await makeEvent('ASSIGNED')
    await shareWith(eventId, MEMBER.email)
    const [first] = await ticketsOf(organiser, eventId)

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${first.id}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: memberUserId },
    })

    // A holder's barcode is never in the list — it is downloaded on view. What the list shows is
    // that it is available to them, for their own ticket and no other.
    const seen = await ticketsOf(member, eventId)
    expect(seen.find((ticket: { id: string }) => ticket.id === first.id).barcodeAvailable).toBe(true)
    expect(
      seen.filter((ticket: { barcodeAvailable: boolean }) => ticket.barcodeAvailable),
    ).toHaveLength(1)
  })

  it('shows the organiser every ticket and who holds it', async () => {
    const eventId = await makeEvent('ASSIGNED')
    await shareWith(eventId, MEMBER.email)
    const [first] = await ticketsOf(organiser, eventId)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${first.id}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: memberUserId },
    })

    const seen = await ticketsOf(organiser, eventId)

    expect(seen.every((ticket: { barcode: unknown }) => ticket.barcode !== null)).toBe(true)
    expect(seen.find((ticket: { id: string }) => ticket.id === first.id).holderUserId).toBe(
      memberUserId,
    )
  })
})

describe('claiming a free ticket', () => {
  it('gives one to whoever asks, with no coupon to hand out first', async () => {
    const eventId = await makeEvent('SELF_CLAIM')
    await shareWith(eventId, MEMBER.email)

    const response = await claim(member, eventId)

    expect(response.statusCode).toBe(201)
    const seen = await ticketsOf(organiser, eventId)
    expect(
      seen.find((ticket: { id: string }) => ticket.id === response.json().ticketId).holderUserId,
    ).toBe(memberUserId)
  })

  it('gives two people two different tickets', async () => {
    const eventId = await makeEvent('SELF_CLAIM')
    await shareWith(eventId, MEMBER.email)
    await shareWith(eventId, SECOND.email)

    const mine = await claim(member, eventId)
    const theirs = await claim(second, eventId)

    expect(mine.json().ticketId).not.toBe(theirs.json().ticketId)
  })

  it('is one each, because a race the first person wins twice is not one', async () => {
    const eventId = await makeEvent('SELF_CLAIM')
    await shareWith(eventId, MEMBER.email)
    await claim(member, eventId)

    const again = await claim(member, eventId)

    expect(again.statusCode).toBe(400)
    expect(again.json().error).toBe('claim.rejected.overAllowance')
  })

  it('has nothing left to give once they are taken', async () => {
    const eventId = await makeEvent('SELF_CLAIM', 1)
    await shareWith(eventId, MEMBER.email)
    await shareWith(eventId, SECOND.email)
    await claim(member, eventId)

    const late = await claim(second, eventId)

    expect(late.statusCode).toBe(400)
    expect(late.json().error).toBe('claim.error.notClaimable')
  })

  it('is not a way into an event nobody shared with you', async () => {
    const eventId = await makeEvent('SELF_CLAIM')

    const response = await claim(member, eventId)

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(await ticketsOf(organiser, eventId)).toMatchObject([
      { holderUserId: null },
      { holderUserId: null },
    ])
  })
})
