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
 * The barcode does not live in the operation log.
 *
 * The whole point of withholding a code is that it cannot reach a device the creator meant to keep
 * it from. The log is pulled whole by every member of an event, so a code carried inside it would
 * defeat that on the first sync. These tests hold the line: a barcode is absent from what a member
 * pulls, and it reaches the server only by the side-channel that rides alongside a sync — from
 * where the download endpoint, and nothing else, hands it out.
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

/** A shared event holding one assigned ticket, whose code is SECRET-CODE. Returns event + ticket. */
const sharedAssignedTicket = async (): Promise<{ eventId: string; ticketId: string }> => {
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
      payload: { tickets: [{ label: 'Un', barcode: { format: 'QR_CODE', value: 'SECRET-CODE' } }] },
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
  return { eventId, ticketId }
}

describe('the barcode never travels in the operation log', () => {
  it('is absent from the operations a member pulls', async () => {
    const { eventId } = await sharedAssignedTicket()

    // The member syncs: pushes nothing, pulls the event's whole log.
    const sync = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${eventId}`,
      headers: bearer(member),
      payload: { operations: [] },
    })
    expect(sync.statusCode).toBe(200)

    // The ticket is in the log — the member learns it exists — but the code is not.
    const serialised = JSON.stringify(sync.json().operations)
    expect(serialised).not.toContain('SECRET-CODE')
    expect(sync.json().operations.some((op: { type: string }) => op.type === 'ticket.add')).toBe(
      true,
    )
  })
})

describe('the sync side-channel is how a code reaches the server', () => {
  it('seals a barcode pushed alongside a sync, and serves it on download', async () => {
    const { eventId, ticketId } = await sharedAssignedTicket()

    // The creator's device uploads a code beside its log, the way an offline import would once it
    // reaches a server. Here it overwrites the seat's code, which proves the side-channel wrote it.
    const sync = await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${eventId}`,
      headers: bearer(organiser),
      payload: {
        operations: [],
        barcodes: [{ ticketId, format: 'QR_CODE', value: 'UPLOADED-CODE' }],
      },
    })
    expect(sync.statusCode).toBe(200)

    // And it is downloadable by the holder — the one path a code ever leaves the server.
    const downloaded = await server.app.inject({
      url: `/api/v1/tickets/${ticketId}/barcode`,
      headers: bearer(member),
    })
    expect(downloaded.json().value).toBe('UPLOADED-CODE')
  })

  it('ignores a barcode pushed by someone who is not the creator', async () => {
    const { eventId, ticketId } = await sharedAssignedTicket()

    // A member cannot set a code by pushing one alongside their own sync.
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/sync/${eventId}`,
      headers: bearer(member),
      payload: {
        operations: [],
        barcodes: [{ ticketId, format: 'QR_CODE', value: 'FORGED-CODE' }],
      },
    })

    const downloaded = await server.app.inject({
      url: `/api/v1/tickets/${ticketId}/barcode`,
      headers: bearer(member),
    })
    expect(downloaded.json().value).toBe('SECRET-CODE')
  })
})
