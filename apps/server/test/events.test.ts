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
 * Events, tickets, claims and payments, read as documentation.
 *
 * The two blocks worth reading first are "an event password changes who can decrypt", which is
 * the security story the whole feature exists for, and "two people claim the same ticket while
 * offline", which is the one genuinely hard problem in the product.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string

const EVENT = {
  name: 'Festival do Norte 2026',
  venue: 'Recinto Ferial',
  startsAt: '2026-08-14T19:00:00.000Z',
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

const createEvent = (token: string, payload: Record<string, unknown> = {}) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: bearer(token),
    payload: { ...EVENT, ...payload },
  })

const addTickets = (
  token: string,
  eventId: string,
  tickets: Record<string, unknown>[],
  password?: string,
) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/tickets`,
    headers: bearer(token),
    payload: { tickets, ...(password ? { password } : {}) },
  })

/**
 * Shares an event and has the recipient accept it.
 *
 * Two steps now rather than one: sharing offers, accepting holds. Almost every test below is
 * about what somebody can see once they hold an event, so the pair is written once here.
 */
const grantTo = async (
  token: string,
  eventId: string,
  userId: string,
  recipient = member,
  password?: string,
) => {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(token),
    payload: { subjectKind: 'USER', subjectId: userId },
  })
  await acceptInvitations(server, recipient, password)
  return response
}

const ticketsOf = (token: string, eventId: string) =>
  server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) })

describe('creating an event', () => {
  it('needs an unlocked vault, since the event key is wrapped by the creator’s own key', async () => {
    const fresh = await login(server, ADMIN)

    const response = await createEvent(fresh)

    // 423, not 401: the session is valid, the server merely lacks the one secret the user
    // holds. The distinction is what keeps a locked vault from looking like being signed out.
    expect(response.statusCode).toBe(423)
  })

  it('returns the new event', async () => {
    expect((await createEvent(organiser)).statusCode).toBe(201)
  })

  it('reads back the name the creator gave it', async () => {
    const { eventId } = (await createEvent(organiser)).json()

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(organiser),
    })

    expect(response.json().name).toBe(EVENT.name)
  })

  it('keeps the name out of the database in plaintext', async () => {
    await createEvent(organiser)

    const stored = await server.db.db.selectFrom('events').select('name_cipher').execute()

    expect(Buffer.from(stored[0]!.name_cipher).toString('utf8')).not.toContain('Festival')
  })

  it('leaves the start time queryable, because the wallet sorts by it', async () => {
    await createEvent(organiser)

    const stored = await server.db.db.selectFrom('events').select('starts_at').execute()

    expect(stored[0]?.starts_at).toBe(EVENT.startsAt)
  })
})

describe('an event password changes who can decrypt', () => {
  it('says an event without one is readable by the server', async () => {
    const response = await createEvent(organiser)

    expect(response.json().readableByServer).toBe(true)
  })

  it('says an event with one is not', async () => {
    const response = await createEvent(organiser, { password: 'entradas-2026' })

    expect(response.json().readableByServer).toBe(false)
  })

  it('lets a member open a password-less event with no extra secret', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await grantTo(organiser, eventId, memberUserId)

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
    })

    expect(response.json().name).toBe(EVENT.name)
  })

  it('refuses a member who has not supplied the event password', async () => {
    const { eventId } = (await createEvent(organiser, { password: 'entradas-2026' })).json()
    await grantTo(organiser, eventId, memberUserId, member, 'entradas-2026')

    // A fresh session, because accepting the invitation opened the event for the one that
    // answered — which is the point of asking there. The rule under test is that the password is
    // needed once per session, so the question has to be asked from a new one.
    const later = await login(server, MEMBER)
    await unlock(later, MEMBER.passphrase)
    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(later),
    })

    expect(response.json().error).toBe('event.passwordRequired')
  })

  it('opens for a member who supplies it', async () => {
    const { eventId } = (await createEvent(organiser, { password: 'entradas-2026' })).json()
    await grantTo(organiser, eventId, memberUserId, member, 'entradas-2026')

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/open`,
      headers: bearer(member),
      payload: { password: 'entradas-2026' },
    })

    expect(response.json().name).toBe(EVENT.name)
  })

  it('refuses the wrong password distinctly from a missing one', async () => {
    const { eventId } = (await createEvent(organiser, { password: 'entradas-2026' })).json()
    await grantTo(organiser, eventId, memberUserId, member, 'entradas-2026')

    const later = await login(server, MEMBER)
    await unlock(later, MEMBER.passphrase)
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/open`,
      headers: bearer(later),
      payload: { password: 'wrong' },
    })

    expect(response.json().error).toBe('event.error.wrongPassword')
  })

  it('asks for it only once per session', async () => {
    const { eventId } = (await createEvent(organiser, { password: 'entradas-2026' })).json()
    await grantTo(organiser, eventId, memberUserId, member, 'entradas-2026')
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/open`,
      headers: bearer(member),
      payload: { password: 'entradas-2026' },
    })

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(200)
  })

  it('lets the creator in without the password, through their own key slot', async () => {
    const { eventId } = (await createEvent(organiser, { password: 'entradas-2026' })).json()

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(200)
  })

  it('refuses somebody with no access at all', async () => {
    const { eventId } = (await createEvent(organiser)).json()

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('adding tickets', () => {
  it('stores them', async () => {
    const { eventId } = (await createEvent(organiser)).json()

    const response = await addTickets(organiser, eventId, [
      { label: 'Grada A 14-B', barcode: { format: 'QR_CODE', value: '8412-AAAA-0001' } },
    ])

    expect(response.json().ticketIds).toHaveLength(1)
  })

  it('keeps the barcode out of the database in plaintext', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await addTickets(organiser, eventId, [
      { barcode: { format: 'QR_CODE', value: '8412-AAAA-0001' } },
    ])

    const stored = await server.db.db.selectFrom('tickets').select('barcode_cipher').execute()

    expect(Buffer.from(stored[0]!.barcode_cipher!).toString('utf8')).not.toContain('8412')
  })

  it('leaves the barcode format readable, so a client knows how to render it', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await addTickets(organiser, eventId, [
      { barcode: { format: 'AZTEC', value: '8412-AAAA-0001' } },
    ])

    const stored = await server.db.db.selectFrom('tickets').select('barcode_format').execute()

    expect(stored[0]?.barcode_format).toBe('AZTEC')
  })

  it('refuses a member who is not the organiser', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await grantTo(organiser, eventId, memberUserId)

    const response = await addTickets(member, eventId, [{ label: 'sneaky' }])

    expect(response.statusCode).toBe(403)
  })
})

describe('who may see a barcode', () => {
  it('shows it to everyone for an open ticket', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await addTickets(organiser, eventId, [
      { assignmentMode: 'OPEN', barcode: { format: 'QR_CODE', value: '8412-OPEN-0001' } },
    ])
    await grantTo(organiser, eventId, memberUserId)

    const response = await ticketsOf(member, eventId)

    expect(response.json().tickets[0].barcode.value).toBe('8412-OPEN-0001')
  })

  it('hides it from a member when the ticket is allocated to somebody else', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await addTickets(organiser, eventId, [
      { assignmentMode: 'ASSIGNED', barcode: { format: 'QR_CODE', value: '8412-MINE-0001' } },
    ])
    await grantTo(organiser, eventId, memberUserId)

    const response = await ticketsOf(member, eventId)

    expect(response.json().tickets[0].barcode).toBeNull()
  })

  it('shows it to the member the ticket was allocated to', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    const { ticketIds } = (
      await addTickets(organiser, eventId, [
        { assignmentMode: 'ASSIGNED', barcode: { format: 'QR_CODE', value: '8412-MINE-0002' } },
      ])
    ).json()
    await grantTo(organiser, eventId, memberUserId)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketIds[0]}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: memberUserId },
    })

    const response = await ticketsOf(member, eventId)

    // The holder's barcode is not in the list; it is offered and downloaded on view.
    expect(response.json().tickets[0].barcode).toBeNull()
    expect(response.json().tickets[0].barcodeAvailable).toBe(true)
    const downloaded = await server.app.inject({
      url: `/api/v1/tickets/${ticketIds[0]}/barcode`,
      headers: bearer(member),
    })
    expect(downloaded.json().value).toBe('8412-MINE-0002')
  })

  it('always shows every barcode to the organiser', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await addTickets(organiser, eventId, [
      { assignmentMode: 'ASSIGNED', barcode: { format: 'QR_CODE', value: '8412-ORG-0001' } },
    ])

    const response = await ticketsOf(organiser, eventId)

    expect(response.json().tickets[0].barcode.value).toBe('8412-ORG-0001')
  })
})

describe('two people claim the same ticket while offline', () => {
  let eventId: string
  let ticketId: string
  let coupon: string
  let secondMember: string
  let secondUserId: string

  beforeEach(async () => {
    eventId = (await createEvent(organiser)).json().eventId
    ticketId = (
      await addTickets(organiser, eventId, [
        { assignmentMode: 'SELF_CLAIM', barcode: { format: 'QR_CODE', value: '8412-FREE-0001' } },
      ])
    ).json().ticketIds[0]

    const coupons = (
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/coupons`,
        headers: bearer(organiser),
        payload: {},
      })
    ).json()
    coupon = coupons.coupons[0].coupon

    await server.app.inject({
      method: 'POST',
      url: '/api/v1/registration',
      payload: { ...MEMBER, email: 'brais@example.org' },
    })
    secondMember = await login(server, { email: 'brais@example.org', password: MEMBER.password })
    await unlock(secondMember, MEMBER.passphrase)
    secondUserId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(secondMember) })
    ).json().userId

    await grantTo(organiser, eventId, memberUserId)
    // The second member answers for themselves: an invitation is one person's to accept.
    await grantTo(organiser, eventId, secondUserId, secondMember)
  })

  /** `reconcile: false` is a device replaying a claim it made with no connectivity. */
  const claimOffline = (token: string, lamport: number) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(token),
      payload: { coupon, lamport, reconcile: false },
    })

  const reconcile = () =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reconcile`,
      headers: bearer(organiser),
    })

  it('tells each of them it is provisional, not settled', async () => {
    const first = await claimOffline(member, 5)

    expect(first.json().state).toBe('PROVISIONAL')
  })

  it('shows the ticket as awaiting confirmation before reconciliation', async () => {
    await claimOffline(member, 5)

    const stored = await server.db.db
      .selectFrom('tickets')
      .select('assignment_state')
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow()

    expect(stored.assignment_state).toBe('PROVISIONAL')
  })

  it('confirms exactly one of them', async () => {
    await claimOffline(member, 5)
    await claimOffline(secondMember, 9)

    const outcome = (await reconcile()).json()

    expect(outcome.confirmed).toBeDefined()
    expect(outcome.rejected).toHaveLength(1)
  })

  it('confirms the lower logical clock, whatever order the claims arrived in', async () => {
    // The later-arriving claim carries the earlier logical clock, which is exactly the case a
    // wall clock or an arrival order would get wrong.
    await claimOffline(member, 9)
    await claimOffline(secondMember, 3)

    const outcome = (await reconcile()).json()

    expect(outcome.confirmed.userId).toBe(secondUserId)
  })

  it('gives the loser a reason rather than leaving the claim in limbo', async () => {
    await claimOffline(member, 3)
    await claimOffline(secondMember, 9)

    const outcome = (await reconcile()).json()

    expect(outcome.rejected[0].reason).toBe('claim.rejected.lostRace')
  })

  it('has a translated message for that reason', async () => {
    await claimOffline(member, 3)
    await claimOffline(secondMember, 9)
    const outcome = (await reconcile()).json()

    const { translate } = await import('@passvault/i18n')

    expect(translate('gl', outcome.rejected[0].reason)).toContain('antes ca ti')
  })

  it('ends with the ticket held by the winner', async () => {
    await claimOffline(member, 3)
    await claimOffline(secondMember, 9)
    await reconcile()

    const stored = await server.db.db
      .selectFrom('tickets')
      .select(['assignment_state', 'holder_user_id'])
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow()

    expect(stored.assignment_state).toBe('CLAIMED')
    expect(stored.holder_user_id).toBe(memberUserId)
  })

  it('reaches the same outcome whichever order the claims were recorded in', async () => {
    await claimOffline(secondMember, 9)
    await claimOffline(member, 3)

    const outcome = (await reconcile()).json()

    expect(outcome.confirmed.userId).toBe(memberUserId)
  })

  it('is idempotent: reconciling again changes nothing', async () => {
    await claimOffline(member, 3)
    await claimOffline(secondMember, 9)
    const first = (await reconcile()).json()

    const second = (await reconcile()).json()

    expect(second.finalState).toBe(first.finalState)
  })

  it('rejects a later claim on a ticket already settled', async () => {
    await claimOffline(member, 3)
    await reconcile()

    await claimOffline(secondMember, 9)
    const outcome = (await reconcile()).json()

    expect(outcome.rejected[0].reason).toBe('claim.rejected.lostRace')
  })

  it('discards a claim with a coupon that was never issued', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(member),
      payload: { coupon: 'invented-coupon', lamport: 1, reconcile: false },
    })
    void response

    const outcome = (await reconcile()).json()

    expect(outcome.confirmed).toBeUndefined()
  })

  it('leaves the ticket free when every claim was discarded', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(member),
      payload: { coupon: 'invented-coupon', lamport: 1, reconcile: false },
    })

    const outcome = (await reconcile()).json()

    expect(outcome.finalState).toBe('FREE')
  })

  it('refuses to claim a ticket the organiser allocated by hand', async () => {
    const assigned = (await addTickets(organiser, eventId, [{ assignmentMode: 'ASSIGNED' }])).json()
      .ticketIds[0]

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${assigned}/claim`,
      headers: bearer(member),
      payload: { coupon, lamport: 1 },
    })

    expect(response.json().error).toBe('claim.error.notClaimable')
  })

  it('settles immediately when the claim is made online', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(member),
      payload: { coupon, lamport: 1 },
    })

    expect(response.json().state).toBe('CLAIMED')
  })

  it('ignores a replayed claim, so an interrupted sync can be retried', async () => {
    const operationId = crypto.randomUUID()
    const payload = { coupon, lamport: 4, operationId, reconcile: false }
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(member),
      payload,
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/claim`,
      headers: bearer(member),
      payload,
    })

    const requests = await server.db.db.selectFrom('claim_requests').select('id').execute()

    expect(requests).toHaveLength(1)
  })
})

describe('payment records', () => {
  let eventId: string
  let ticketId: string

  beforeEach(async () => {
    eventId = (await createEvent(organiser)).json().eventId
    ticketId = (
      await addTickets(organiser, eventId, [
        { assignmentMode: 'ASSIGNED', barcode: { format: 'QR_CODE', value: '8412-PAY-0001' } },
      ])
    ).json().ticketIds[0]
    await grantTo(organiser, eventId, memberUserId)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: bearer(organiser),
      payload: { holderUserId: memberUserId },
    })
  })

  const record = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/payment`,
      headers: bearer(token),
      payload,
    })

  it('is recorded by the organiser', async () => {
    const response = await record(organiser, {
      state: 'PAID',
      amountCents: 4500,
      currency: 'EUR',
      visibility: 'ALL',
    })

    expect(response.statusCode).toBe(200)
  })

  it('cannot be recorded by the holder, which would make it worthless', async () => {
    const response = await record(member, { state: 'PAID', visibility: 'ALL' })

    expect(response.statusCode).toBe(403)
  })

  it('is visible to the group when marked ALL', async () => {
    await record(organiser, {
      state: 'PAID',
      amountCents: 4500,
      currency: 'EUR',
      visibility: 'ALL',
    })

    const response = await ticketsOf(member, eventId)

    expect(response.json().tickets[0].payment.state).toBe('PAID')
  })

  it('is visible to the holder when marked HOLDER_ONLY', async () => {
    await record(organiser, { state: 'UNPAID', visibility: 'HOLDER_ONLY' })

    const response = await ticketsOf(member, eventId)

    expect(response.json().tickets[0].payment.state).toBe('UNPAID')
  })

  it('is omitted entirely from a CREATOR_ONLY record, not merely flagged', async () => {
    await record(organiser, {
      state: 'UNPAID',
      amountCents: 4500,
      currency: 'EUR',
      visibility: 'CREATOR_ONLY',
    })

    const response = await ticketsOf(member, eventId)

    expect(response.json().tickets[0].payment).toBeUndefined()
  })

  it('does not leak the amount of a hidden record anywhere in the response', async () => {
    await record(organiser, {
      state: 'UNPAID',
      amountCents: 9999,
      currency: 'EUR',
      visibility: 'CREATOR_ONLY',
    })

    const response = await ticketsOf(member, eventId)

    expect(response.body).not.toContain('9999')
  })

  it('stays visible to the organiser', async () => {
    await record(organiser, {
      state: 'UNPAID',
      amountCents: 9999,
      currency: 'EUR',
      visibility: 'CREATOR_ONLY',
    })

    const response = await ticketsOf(organiser, eventId)

    expect(response.json().tickets[0].payment.amountCents).toBe(9999)
  })

  it('refuses an amount without a currency, which is not a sum of money', async () => {
    const response = await record(organiser, {
      state: 'PAID',
      amountCents: 4500,
      visibility: 'ALL',
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('withdrawing a ticket', () => {
  it('says outright that it does not recall what was already delivered', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    const { ticketIds } = (await addTickets(organiser, eventId, [{ label: 'one' }])).json()

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketIds[0]}/withdraw`,
      headers: bearer(organiser),
    })

    expect(response.json()).toEqual({ withdrawn: true, recallsDeliveredTickets: false })
  })

  it('is refused to anybody but the organiser', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    const { ticketIds } = (await addTickets(organiser, eventId, [{ label: 'one' }])).json()
    await grantTo(organiser, eventId, memberUserId)

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketIds[0]}/withdraw`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('revoking access', () => {
  it('stops future access', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await grantTo(organiser, eventId, memberUserId)
    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', subjectId: memberUserId },
    })
    const fresh = await login(server, MEMBER)
    await unlock(fresh, MEMBER.passphrase)

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: bearer(fresh),
    })

    expect(response.statusCode).toBe(403)
  })

  it('says outright that it does not recall what was already delivered', async () => {
    const { eventId } = (await createEvent(organiser)).json()
    await grantTo(organiser, eventId, memberUserId)

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', subjectId: memberUserId },
    })

    expect(response.json().recallsDeliveredTickets).toBe(false)
  })
})
