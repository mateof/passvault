import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketPdf } from '../../../packages/ingest/test/fixtures.js'
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
 * The pass each ticket was cut from, and who may fetch it.
 *
 * Ingestion cuts a sheet holding several passes into one image per ticket so that handing a seat
 * to somebody does not hand them the codes printed beside it. That was stored, encrypted, carried
 * into every export — and served to nobody, because no route returned it.
 *
 * The rules that matter here are not about files. A pass has the barcode printed on it, so it is
 * the barcode in another shape: whoever may not download the code may not download the picture of
 * it, and fetching the picture closes the creator's window to take the seat back exactly as
 * fetching the code does.
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
      payload: { name: 'Aquapark', defaultAssignmentMode: 'ASSIGNED' },
    })
  ).json().eventId
}, 60_000)

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

/** Imports a sheet carrying two passes and saves both, which is the case this is all for. */
const importSharedSheet = async (): Promise<string[]> => {
  const pdf = await ticketPdf([
    { columns: 1, codes: [{ text: '8412-DOC-0001' }, { text: '8412-DOC-0002' }] },
  ])
  const proposed = await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/ingest`,
    headers: { ...bearer(organiser), 'content-type': 'application/pdf' },
    payload: Buffer.from(pdf),
  })
  const { ingestId } = proposed.json()
  const confirmed = await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
    headers: bearer(organiser),
    payload: {},
  })
  return confirmed.json().ticketIds
}

const document = (ticketId: string, token: string) =>
  server.app.inject({ url: `/api/v1/tickets/${ticketId}/document`, headers: bearer(token) })

const shareWithMember = async () => {
  await server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: MEMBER.email },
  })
  await acceptInvitations(server, member)
}

const assignToMember = (ticketId: string) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/tickets/${ticketId}/assign`,
    headers: bearer(organiser),
    payload: { holderUserId: memberUserId },
  })

const listed = async (ticketId: string, token: string) => {
  const tickets = (
    await server.app.inject({ url: `/api/v1/events/${eventId}/tickets`, headers: bearer(token) })
  ).json().tickets
  return tickets.find((ticket: { id: string }) => ticket.id === ticketId)
}

describe('the pass a ticket was cut from', () => {
  it('is served to the creator, as the image ingestion cut for it', async () => {
    const [first] = await importSharedSheet()

    const response = await document(String(first), organiser)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.rawPayload.length).toBeGreaterThan(0)
  })

  it('gives the two tickets off one sheet different passes', async () => {
    const [first, second] = await importSharedSheet()

    const one = await document(String(first), organiser)
    const other = await document(String(second), organiser)

    expect(Buffer.from(one.rawPayload).equals(Buffer.from(other.rawPayload))).toBe(false)
  })

  it('says in the list that there is one to fetch', async () => {
    const [first] = await importSharedSheet()

    expect(await listed(String(first), organiser)).toMatchObject({ documentAvailable: true })
  })

  it('is refused to somebody the event was never shared with', async () => {
    const [first] = await importSharedSheet()

    expect((await document(String(first), member)).statusCode).toBe(403)
  })

  it('is refused to a member of the event who does not hold this seat', async () => {
    const [first] = await importSharedSheet()
    await shareWithMember()

    // Shared, and assigned to nobody. An ASSIGNED ticket is not a shared wallet: being in the
    // event is not being entitled to a seat inside it.
    expect((await document(String(first), member)).statusCode).toBe(403)
  })
})

describe('a pass whose code is being withheld', () => {
  it('is refused while the code is, since it is the same secret in another shape', async () => {
    const [first] = await importSharedSheet()
    await shareWithMember()
    await assignToMember(String(first))
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${first}/block`,
      headers: bearer(organiser),
    })

    expect((await document(String(first), member)).statusCode).toBe(400)
  })

  it('reaches its holder once nothing is holding it back', async () => {
    const [first] = await importSharedSheet()
    await shareWithMember()
    await assignToMember(String(first))

    expect((await document(String(first), member)).statusCode).toBe(200)
  })
})

describe('fetching the pass counts as having seen the code', () => {
  it('marks the ticket revealed for its holder', async () => {
    const [first] = await importSharedSheet()
    await shareWithMember()
    await assignToMember(String(first))

    await document(String(first), member)

    expect(await listed(String(first), organiser)).toMatchObject({ revealed: true })
  })

  it('closes the window to block it, exactly as downloading the code does', async () => {
    const [first] = await importSharedSheet()
    await shareWithMember()
    await assignToMember(String(first))
    await document(String(first), member)

    const blocked = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${first}/block`,
      headers: bearer(organiser),
    })

    expect(blocked.statusCode).toBe(400)
  })

  it('does not mark it revealed when the creator looks at their own', async () => {
    const [first] = await importSharedSheet()

    await document(String(first), organiser)

    expect(await listed(String(first), organiser)).toMatchObject({ revealed: false })
  })
})
