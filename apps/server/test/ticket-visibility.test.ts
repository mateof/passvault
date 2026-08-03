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
 * The creator's control over a shared barcode: when it can be seen, whether it is held back, and
 * whether the holder can hand it back or pass it on.
 *
 * The server is the authority, because the whole point is a code the device is not trusted to
 * unlock on its own. Everything here is checked from the two sides that matter: the creator, who
 * always sees their own barcode and decides everybody else's, and the holder, who sees theirs only
 * when the gate opens.
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

/** A shared event with one assigned ticket held by the member. Returns the ticket id. */
const sharedAssignedTicket = async (): Promise<string> => {
  const eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival', defaultAssignmentMode: 'ASSIGNED' },
    })
  ).json().eventId
  const ticketId = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: {
        tickets: [{ label: 'Un', barcode: { format: 'QR_CODE', value: 'SECRET-CODE' } }],
      },
    })
  ).json().ticketIds[0]
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
  return ticketId
}

const memberTicket = async (ticketId: string) => {
  const eventId = (
    await server.db.db
      .selectFrom('tickets')
      .select('event_id')
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow()
  ).event_id
  const tickets = (
    await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(member) })
  ).json().tickets
  return tickets.find((t: { id: string }) => t.id === ticketId)
}

/**
 * The holder's only route to their code: a per-ticket download, which is also what reveals it. The
 * list never carries a holder's barcode, so this stands in for "the member looked at it".
 */
const downloadBarcode = (ticketId: string, token = member) =>
  server.app.inject({ url: `/api/v1/tickets/${ticketId}/barcode`, headers: bearer(token) })

describe('holding a barcode back until a moment', () => {
  it('shows nothing to the holder before the visible-from time, and the code after', async () => {
    const ticketId = await sharedAssignedTicket()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/visibility`,
      headers: bearer(organiser),
      payload: { visibleFrom: future },
    })

    const locked = await memberTicket(ticketId)
    expect(locked.barcode).toBeNull()
    expect(locked.barcodeAvailable).toBe(false)
    expect(locked.locked).toBe(true)
    expect(locked.lockReason).toBe('notYet')
    expect(locked.visibleFrom).toBe(future)
    // And the download itself is refused while it is not yet time.
    expect((await downloadBarcode(ticketId)).statusCode).toBe(400)

    // A moment already past opens it.
    const past = new Date(Date.now() - 1000).toISOString()
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/visibility`,
      headers: bearer(organiser),
      payload: { visibleFrom: past },
    })
    const open = await memberTicket(ticketId)
    // Still not in the list — only offered — and served by the download.
    expect(open.barcode).toBeNull()
    expect(open.barcodeAvailable).toBe(true)
    expect(open.locked).toBe(false)
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')
  })

  it('never hides the barcode from the creator', async () => {
    const ticketId = await sharedAssignedTicket()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/visibility`,
      headers: bearer(organiser),
      payload: { visibleFrom: future },
    })

    const eventId = (
      await server.db.db
        .selectFrom('tickets')
        .select('event_id')
        .where('id', '=', ticketId)
        .executeTakeFirstOrThrow()
    ).event_id
    const seen = (
      await server.app.inject({
        url: `/api/v1/events/${eventId}/tickets`,
        headers: bearer(organiser),
      })
    ).json().tickets.find((t: { id: string }) => t.id === ticketId)
    expect(seen.barcode?.value).toBe('SECRET-CODE')
  })
})

describe('blocking', () => {
  it('hides the barcode while blocked and shows it again once unblocked', async () => {
    const ticketId = await sharedAssignedTicket()

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/block`,
      headers: bearer(organiser),
    })
    let seen = await memberTicket(ticketId)
    expect(seen.barcode).toBeNull()
    expect(seen.barcodeAvailable).toBe(false)
    expect(seen.lockReason).toBe('blocked')
    expect((await downloadBarcode(ticketId)).statusCode).toBe(400)

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/unblock`,
      headers: bearer(organiser),
    })
    seen = await memberTicket(ticketId)
    expect(seen.barcodeAvailable).toBe(true)
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')
  })

  it('cannot be blocked once the holder has seen the code', async () => {
    const ticketId = await sharedAssignedTicket()
    // The member downloads it while it is open, which reveals it.
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')

    const late = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/block`,
      headers: bearer(organiser),
    })
    expect(late.statusCode).toBe(400)
    expect(late.json().error).toBe('ticket.error.alreadyRevealed')
  })
})

describe('payment gating', () => {
  it('withholds the barcode while unpaid and releases it once paid', async () => {
    const ticketId = await sharedAssignedTicket()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/payment`,
      headers: bearer(organiser),
      payload: { state: 'UNPAID', amountCents: 2000, currency: 'EUR', visibility: 'ALL' },
    })

    expect((await memberTicket(ticketId)).lockReason).toBe('unpaid')
    expect((await downloadBarcode(ticketId)).statusCode).toBe(400)

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/payment`,
      headers: bearer(organiser),
      payload: { state: 'PAID', amountCents: 2000, currency: 'EUR', visibility: 'ALL' },
    })
    expect((await memberTicket(ticketId)).barcodeAvailable).toBe(true)
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')
  })
})

describe('returning a seat', () => {
  it('frees it while the code is still locked, and refuses once it has been seen', async () => {
    const ticketId = await sharedAssignedTicket()
    // Block it so the member cannot reveal it, then return is allowed.
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/block`,
      headers: bearer(organiser),
    })

    const returned = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/return`,
      headers: bearer(member),
    })
    expect(returned.json()).toMatchObject({ returned: true })

    const row = await server.db.db
      .selectFrom('tickets')
      .select(['holder_user_id', 'assignment_state', 'returned_at'])
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow()
    expect(row.holder_user_id).toBeNull()
    expect(row.assignment_state).toBe('FREE')
    expect(row.returned_at).not.toBeNull()
  })

  it('refuses a return once the barcode has been revealed', async () => {
    const ticketId = await sharedAssignedTicket()
    // Downloading the code is what reveals it.
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')

    const late = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/return`,
      headers: bearer(member),
    })
    expect(late.statusCode).toBe(400)
    expect(late.json().error).toBe('ticket.error.alreadyRevealed')
  })
})

describe('share permission', () => {
  it('is off by default and can be lent by the creator', async () => {
    const ticketId = await sharedAssignedTicket()
    expect((await memberTicket(ticketId)).sharePermitted).toBe(false)

    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/share-permission`,
      headers: bearer(organiser),
      payload: { permitted: true },
    })
    expect((await memberTicket(ticketId)).sharePermitted).toBe(true)
  })

  it('is the creator only to grant', async () => {
    const ticketId = await sharedAssignedTicket()
    const denied = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tickets/${ticketId}/share-permission`,
      headers: bearer(member),
      payload: { permitted: true },
    })
    expect(denied.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('unassigning a seat', () => {
  it('frees it while the holder has not downloaded the code', async () => {
    const ticketId = await sharedAssignedTicket()
    const done = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/unassign`,
      headers: bearer(organiser),
    })
    expect(done.json()).toMatchObject({ unassigned: true })

    const row = await server.db.db
      .selectFrom('tickets')
      .select(['holder_user_id', 'assignment_state'])
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow()
    expect(row.holder_user_id).toBeNull()
    expect(row.assignment_state).toBe('FREE')
  })

  it('refuses once the holder has downloaded the code', async () => {
    const ticketId = await sharedAssignedTicket()
    expect((await downloadBarcode(ticketId)).json().value).toBe('SECRET-CODE')

    const late = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/unassign`,
      headers: bearer(organiser),
    })
    expect(late.statusCode).toBe(400)
    expect(late.json().error).toBe('ticket.error.alreadyRevealed')
  })

  it('is refused to anyone but the creator', async () => {
    const ticketId = await sharedAssignedTicket()
    const denied = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/unassign`,
      headers: bearer(member),
    })
    expect(denied.statusCode).toBeGreaterThanOrEqual(400)
  })
})
