import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN,
  MEMBER,
  bearer,
  login,
  registerFirstAdmin,
  setRegistrationMode,
  startTestServer,
  type TestServer,
} from './helpers.js'

/**
 * Groups: the people you share an event with more than once.
 *
 * The schema has had them since the first migration and there was no way to manage one — a group
 * could be created and added to, and never renamed, never deleted, and never listed by anybody
 * except the person who made it. The last of those was not a missing feature but a broken one:
 * the name was encrypted under the owner's own key, so a member asking for their groups got a
 * failed decryption rather than a list.
 *
 * Sharing is the other half. An event granted to a group is granted to everybody in it, and
 * removing somebody from the group closes the event for them without touching the event.
 */
let server: TestServer
let owner: string
let ownerUserId: string
let member: string
let memberUserId: string

const SECOND = {
  email: 'brais@example.org',
  password: 'outra-conta-larga',
  passphrase: 'frase-do-brais',
}

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  owner = await login(server, ADMIN)
  await unlock(owner, ADMIN.passphrase)
  await setRegistrationMode(server, owner, 'OPEN')
  ownerUserId = (await server.app.inject({ url: '/api/v1/me', headers: bearer(owner) })).json()
    .userId

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

const createGroup = async (token: string, name: string): Promise<string> =>
  (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: bearer(token),
      payload: { name },
    })
  ).json().groupId

const groups = (token: string) =>
  server.app.inject({ url: '/api/v1/groups', headers: bearer(token) })

const addMember = (token: string, groupId: string, email: string) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/groups/${groupId}/members`,
    headers: bearer(token),
    payload: { email },
  })

const members = (token: string, groupId: string) =>
  server.app.inject({ url: `/api/v1/groups/${groupId}/members`, headers: bearer(token) })

describe('making a group', () => {
  it('is listed for the person who made it', async () => {
    await createGroup(owner, 'A familia')

    expect((await groups(owner)).json().groups).toMatchObject([
      { name: 'A familia', role: 'OWNER', memberCount: 1, isOwner: true },
    ])
  })

  it('is listed for the people in it, which the owner’s key could never have done', async () => {
    // The bug this replaces: the name was encrypted under the owner's data key, so this request
    // did not return the wrong name — it failed outright, and a member's group list was an error.
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    expect((await groups(member)).json().groups).toMatchObject([
      { name: 'A familia', role: 'MEMBER', isOwner: false },
    ])
  })

  it('counts the owner as a member, so every query does not special-case them', async () => {
    const groupId = await createGroup(owner, 'A familia')

    expect((await members(owner, groupId)).json().members).toMatchObject([
      { userId: ownerUserId, role: 'OWNER', email: ADMIN.email, isSelf: true },
    ])
  })
})

describe('the people in a group', () => {
  it('are added by address, which is the only handle anybody knows', async () => {
    const groupId = await createGroup(owner, 'A familia')

    const response = await addMember(owner, groupId, MEMBER.email)

    expect(response.statusCode).toBe(201)
    expect((await members(owner, groupId)).json().members).toHaveLength(2)
  })

  it('come back with their addresses, since a list of identifiers is not a list of people', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    expect(
      (await members(owner, groupId)).json().members.map((row: { email: string }) => row.email),
    ).toContain(MEMBER.email)
  })

  it('cannot be an address nobody here uses', async () => {
    // Refused rather than held as a pending invitation. Accepting it silently would leave the
    // owner believing the ticket was shared with somebody who will never see it.
    const groupId = await createGroup(owner, 'A familia')

    const response = await addMember(owner, groupId, 'ninguen@example.org')

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('groups.error.unknownEmail')
  })

  it('can be removed, and the row survives so past assignments still resolve', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/groups/${groupId}/members/${memberUserId}`,
      headers: bearer(owner),
    })

    expect(response.statusCode).toBe(200)
    expect((await members(owner, groupId)).json().members).toHaveLength(1)
  })

  it('never include the owner among the removable', async () => {
    const groupId = await createGroup(owner, 'A familia')

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/groups/${groupId}/members/${ownerUserId}`,
      headers: bearer(owner),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('groups.error.cannotRemoveOwner')
  })

  it('are not rearranged by a member, who may look and not touch', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)
    await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: SECOND })

    const response = await addMember(member, groupId, SECOND.email)

    expect(response.statusCode).toBe(403)
  })
})

describe('renaming and deleting', () => {
  it('renames without disturbing who is in it', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}`,
      headers: bearer(owner),
      payload: { name: 'A familia e os curmáns' },
    })

    expect(response.statusCode).toBe(200)
    expect((await groups(owner)).json().groups[0]).toMatchObject({
      name: 'A familia e os curmáns',
      memberCount: 2,
    })
  })

  it('deletes a group, which stops being listed for anybody', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/groups/${groupId}`,
      headers: bearer(owner),
    })

    expect((await groups(owner)).json().groups).toEqual([])
    expect((await groups(member)).json().groups).toEqual([])
  })

  it('closes the events the deleted group was opening', async () => {
    // The reason somebody deletes a group is usually that it should no longer be letting people
    // in. A group that is gone from every list and still granting access would be worse than
    // useless — it would be invisible.
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(owner),
      payload: { subjectKind: 'GROUP', subjectId: groupId },
    })
    expect(
      (await server.app.inject({ url: '/api/v1/events', headers: bearer(member) })).json().events,
    ).toHaveLength(1)

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/groups/${groupId}`,
      headers: bearer(owner),
    })

    expect(
      (await server.app.inject({ url: '/api/v1/events', headers: bearer(member) })).json().events,
    ).toEqual([])
  })

  it('is the owner’s decision, not an organiser’s', async () => {
    const groupId = await createGroup(owner, 'A familia')
    await addMember(owner, groupId, MEMBER.email)

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/groups/${groupId}`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('looking somebody up before sharing with them', () => {
  it('says an address is here', async () => {
    const response = await server.app.inject({
      url: `/api/v1/directory/lookup?email=${encodeURIComponent(MEMBER.email)}`,
      headers: bearer(owner),
    })

    expect(response.json()).toMatchObject({ exists: true, userId: memberUserId })
  })

  it('says an address is not, which is what a typo looks like', async () => {
    const response = await server.app.inject({
      url: '/api/v1/directory/lookup?email=ninguen@example.org',
      headers: bearer(owner),
    })

    expect(response.json()).toMatchObject({ exists: false })
    expect(response.json().userId).toBeUndefined()
  })

  it('answers nobody who is not signed in, since it is an existence oracle', async () => {
    const response = await server.app.inject({
      url: '/api/v1/directory/lookup?email=ana@example.org',
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('sharing an event', () => {
  let eventId: string

  beforeEach(async () => {
    eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId
  })

  const share = (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(owner),
      payload,
    })

  const access = (token = owner) =>
    server.app.inject({ url: `/api/v1/events/${eventId}/access`, headers: bearer(token) })

  it('takes a person by address, because nobody knows anybody’s identifier', async () => {
    const response = await share({ subjectKind: 'USER', email: MEMBER.email })

    expect(response.statusCode).toBe(201)
    expect((await access()).json().access).toMatchObject([
      { subjectKind: 'USER', subjectId: memberUserId, label: MEMBER.email },
    ])
  })

  it('refuses an address nobody here uses, rather than sharing with nobody', async () => {
    const response = await share({ subjectKind: 'USER', email: 'ninguen@example.org' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('groups.error.unknownUser')
  })

  it('names the group it was shared with, so sharing can be looked at', async () => {
    const groupId = await createGroup(owner, 'A familia')

    await share({ subjectKind: 'GROUP', subjectId: groupId })

    expect((await access()).json().access).toMatchObject([
      { subjectKind: 'GROUP', subjectId: groupId, label: 'A familia' },
    ])
  })

  it('lists one entry when the same share is made twice', async () => {
    await share({ subjectKind: 'USER', email: MEMBER.email })
    await share({ subjectKind: 'USER', email: MEMBER.email })

    expect((await access()).json().access).toHaveLength(1)
  })

  it('drops the entry when access is revoked', async () => {
    await share({ subjectKind: 'USER', email: MEMBER.email })

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(owner),
      payload: { subjectKind: 'USER', email: MEMBER.email },
    })

    expect((await access()).json().access).toEqual([])
  })

  it('is not a guest list a member gets to read', async () => {
    await share({ subjectKind: 'USER', email: MEMBER.email })

    expect((await access(member)).statusCode).toBe(403)
  })
})
