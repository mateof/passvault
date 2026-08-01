import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
 * Deleting an account, watched from both sides of the line it has to hold.
 *
 * Theirs goes: events with their tickets and their files on disk, groups, labels, credentials,
 * sessions. The shared record stays: another person's event keeps its history even when this
 * account wrote some of it, because that log belongs to everyone in the event.
 */
let server: TestServer
let admin: string
let member: string
let memberUserId: string

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  admin = await login(server, ADMIN)
  await unlock(admin, ADMIN.passphrase)
  await setRegistrationMode(server, admin, 'OPEN')
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

describe('an administrator deleting an account', () => {
  it('removes the account, its events, and the files those events kept on disk', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(member),
        payload: { name: 'O evento de Brais' },
      })
    ).json().eventId
    const pdf = await ticketPdf([{ codes: [{ text: '8412-DEL-0001' }] }])
    const proposal = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest`,
      headers: { ...bearer(member), 'content-type': 'application/pdf' },
      payload: Buffer.from(pdf),
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${proposal.json().ingestId}/confirm`,
      headers: bearer(member),
      payload: { include: [0] },
    })
    const stored = await server.db.db.selectFrom('blobs').select('storage_path').execute()
    expect(stored.length).toBeGreaterThan(0)

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${memberUserId}`,
      headers: bearer(admin),
    })

    expect(response.json()).toMatchObject({ deleted: true })
    expect(await server.db.db.selectFrom('users').selectAll().where('id', '=', memberUserId).execute()).toEqual([])
    expect(await server.db.db.selectFrom('events').selectAll().execute()).toEqual([])
    expect(await server.db.db.selectFrom('tickets').selectAll().execute()).toEqual([])
    expect(await server.db.db.selectFrom('user_keys').selectAll().where('user_id', '=', memberUserId).execute()).toEqual([])
    // The ciphertext files went with the rows. Rows without files are a broken listing; files
    // without rows are undecryptable bytes squatting on somebody's disk forever.
    for (const blob of stored) {
      expect(existsSync(join(server.config.blobDir, blob.storage_path))).toBe(false)
    }
  })

  it('is refused for the deleter themselves, who have their own route', async () => {
    const adminId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(admin) })).json()
      .userId

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${adminId}`,
      headers: bearer(admin),
    })

    expect(response.statusCode).toBe(400)
  })

  it('never deletes the last administrator', async () => {
    // Promote the member, delete the original admin, then try to delete the only one left —
    // by the admin route the answer must be a refusal, or the installation ends up ownerless.
    await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${memberUserId}`,
      headers: bearer(admin),
      payload: { isAdmin: true },
    })
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(member),
      payload: { password: MEMBER.password },
    })
    expect(response.statusCode).toBe(200)

    const last = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(admin),
      payload: { password: ADMIN.password },
    })
    expect(last.statusCode).toBe(400)
    expect(last.json().error).toBe('admin.error.lastAdmin')
  })
})

describe('deleting your own account', () => {
  it('asks for the password, and a wrong one deletes nothing', async () => {
    const wrong = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(member),
      payload: { password: 'not-my-password' },
    })
    expect(wrong.statusCode).toBe(403)

    const right = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(member),
      payload: { password: MEMBER.password },
    })
    expect(right.json()).toMatchObject({ deleted: true })
    // The session died with the account.
    expect(
      (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).statusCode,
    ).toBe(401)
  })

  it('frees the seats they held in somebody else’s event', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(admin),
        payload: { name: 'Festival', defaultAssignmentMode: 'SELF_CLAIM' },
      })
    ).json().eventId
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(admin),
      payload: { tickets: [{ label: 'Un', assignmentMode: 'SELF_CLAIM' }] },
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(admin),
      payload: { subjectKind: 'USER', email: MEMBER.email },
    })
    await acceptInvitations(server, member)
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/claim`,
      headers: bearer(member),
    })

    await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(member),
      payload: { password: MEMBER.password },
    })

    // The organiser's event survives untouched except that the seat is takeable again: a
    // claimed seat pointed at a deleted account is one nobody can show and nobody can take.
    const tickets = (
      await server.app.inject({
        url: `/api/v1/events/${eventId}/tickets`,
        headers: bearer(admin),
      })
    ).json().tickets
    expect(tickets[0]).toMatchObject({ holderUserId: null, assignmentState: 'FREE' })
  })

  it('leaves the shared history in place, unattributed', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(admin),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: bearer(member),
      payload: { password: MEMBER.password },
    })

    // The admin's own event and its creation record are none of the deleted account's to take.
    const operations = await server.db.db
      .selectFrom('operations')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute()
    expect(operations.length).toBeGreaterThan(0)
  })
})

describe('deleting one event', () => {
  it('removes it whole, files included, for its creator', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(member),
        payload: { name: 'Un erro' },
      })
    ).json().eventId
    const pdf = await ticketPdf([{ codes: [{ text: '8412-DEL-0002' }] }])
    const proposal = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest`,
      headers: { ...bearer(member), 'content-type': 'application/pdf' },
      payload: Buffer.from(pdf),
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${proposal.json().ingestId}/confirm`,
      headers: bearer(member),
      payload: { include: [0] },
    })
    const stored = await server.db.db.selectFrom('blobs').select('storage_path').execute()

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
    })

    expect(response.json()).toMatchObject({ deleted: true })
    expect(await server.db.db.selectFrom('events').selectAll().execute()).toEqual([])
    expect(await server.db.db.selectFrom('tickets').selectAll().execute()).toEqual([])
    expect(await server.db.db.selectFrom('operations').selectAll().execute()).toEqual([])
    for (const blob of stored) {
      expect(existsSync(join(server.config.blobDir, blob.storage_path))).toBe(false)
    }
  })

  it('is refused to anybody who is not its creator nor an administrator', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(admin),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
    expect(await server.db.db.selectFrom('events').selectAll().execute()).toHaveLength(1)
  })
})

describe('withdrawing a ticket', () => {
  it('writes the tombstone into the log, so phones learn at the next synchronisation', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(admin),
        payload: { name: 'Festival' },
      })
    ).json().eventId
    const ticketId = (
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/tickets`,
        headers: bearer(admin),
        payload: { tickets: [{ label: 'Un' }] },
      })
    ).json().ticketIds[0]

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/withdraw`,
      headers: bearer(admin),
    })

    expect(response.json()).toMatchObject({ withdrawn: true })
    const kinds = await server.db.db.selectFrom('operations').select('type').execute()
    expect(kinds.map((row) => row.type)).toContain('ticket.remove')
  })
})
