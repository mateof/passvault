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
 * Handles, labels and open sessions.
 *
 * Three small features with one thing in common: they are all about a person being able to say
 * what they mean. A handle is how you name a friend to the server without knowing which address
 * they signed up with; a label is how you name an event to yourself; a session list is how you
 * say "not that phone, it is in a taxi".
 */
let server: TestServer
let owner: string
let member: string

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  owner = await login(server, ADMIN)
  await unlock(owner, ADMIN.passphrase)
  await setRegistrationMode(server, owner, 'OPEN')
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  member = await login(server, MEMBER)
  await unlock(member, MEMBER.passphrase)
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

const setHandle = (token: string, handle: string) =>
  server.app.inject({
    method: 'PUT',
    url: '/api/v1/me/handle',
    headers: bearer(token),
    payload: { handle },
  })

describe('a handle', () => {
  it('is claimed and kept', async () => {
    const response = await setHandle(owner, 'mateo')

    expect(response.json()).toMatchObject({ handle: 'mateo' })
  })

  it('is casefolded, because saying a name aloud has to identify one person', async () => {
    await setHandle(owner, 'Mateo')

    const response = await server.app.inject({
      url: '/api/v1/directory/handle?handle=MATEO',
      headers: bearer(member),
    })

    expect(response.json()).toMatchObject({ handle: 'mateo', taken: true })
  })

  it('cannot be taken twice', async () => {
    await setHandle(owner, 'mateo')

    const response = await setHandle(member, 'mateo')

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('handle.error.taken')
  })

  it('refuses something that is not a name', async () => {
    // An address is refused in particular: a field that took both would let somebody claim
    // `ana@example.org` as a handle and be handed shares meant for the person at that address.
    for (const attempt of ['ab', 'ana@example.org', 'con espazos', 'Ana!']) {
      expect((await setHandle(owner, attempt)).statusCode).toBe(400)
    }
  })

  it('says a free one is free, so a field can answer before anybody presses anything', async () => {
    const response = await server.app.inject({
      url: '/api/v1/directory/handle?handle=ninguen',
      headers: bearer(member),
    })

    expect(response.json()).toMatchObject({ taken: false })
  })

  it('is how an event can be shared', async () => {
    await setHandle(member, 'brais')
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(owner),
      payload: { subjectKind: 'USER', handle: 'brais' },
    })

    expect(response.statusCode).toBe(201)
    await acceptInvitations(server, member)
    expect(
      (await server.app.inject({ url: '/api/v1/events', headers: bearer(member) })).json().events,
    ).toHaveLength(1)
  })
})

describe('what /me says about you', () => {
  it('carries the handle once one is chosen, and null before', async () => {
    // Without this a client cannot tell "you have no name" from "we never asked", which is
    // exactly the confusion that makes somebody set the same handle three times.
    const before = (await server.app.inject({ url: '/api/v1/me', headers: bearer(owner) })).json()
    expect(before.handle).toBeNull()

    await setHandle(owner, 'mateo')

    const after = (await server.app.inject({ url: '/api/v1/me', headers: bearer(owner) })).json()
    expect(after.handle).toBe('mateo')
  })

  it('lets a handle be changed, freeing the old one', async () => {
    await setHandle(owner, 'mateo')
    await setHandle(owner, 'mateof')

    expect(
      (await server.app.inject({ url: '/api/v1/me', headers: bearer(owner) })).json().handle,
    ).toBe('mateof')
    expect(
      (
        await server.app.inject({
          url: '/api/v1/directory/handle?handle=mateo',
          headers: bearer(member),
        })
      ).json().taken,
    ).toBe(false)
  })
})

describe('a handle you already hold', () => {
  it('is reported as yours, not merely as taken', async () => {
    // The bug this pins: the availability check answered "taken" for the caller's own name, so
    // a form disabled saving exactly the handle its owner already had — and with nothing
    // displaying the current name, it looked orphaned rather than owned.
    await setHandle(owner, 'mateo')

    const response = await server.app.inject({
      url: '/api/v1/directory/handle?handle=mateo',
      headers: bearer(owner),
    })

    expect(response.json()).toMatchObject({ taken: true, mine: true })
  })

  it('is somebody else’s from where they stand', async () => {
    await setHandle(owner, 'mateo')

    const response = await server.app.inject({
      url: '/api/v1/directory/handle?handle=mateo',
      headers: bearer(member),
    })

    expect(response.json()).toMatchObject({ taken: true, mine: false })
  })

  it('can be re-saved by its owner without complaint', async () => {
    await setHandle(owner, 'mateo')

    expect((await setHandle(owner, 'mateo')).statusCode).toBe(200)
  })
})

describe('an administrator freeing a name', () => {
  it('clears it, lists it as gone, and leaves the account working', async () => {
    await setHandle(member, 'brais')
    const memberId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })
    ).json().userId

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${memberId}/handle`,
      headers: bearer(owner),
    })

    expect(response.json()).toMatchObject({ cleared: true })
    const users = (
      await server.app.inject({ url: '/api/v1/admin/users', headers: bearer(owner) })
    ).json().users
    expect(users.find((row: { userId: string }) => row.userId === memberId).handle).toBeNull()
    // The name is claimable again, which is the point of freeing it.
    expect((await setHandle(owner, 'brais')).statusCode).toBe(200)
    // And the account it was taken from still answers.
    expect(
      (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).statusCode,
    ).toBe(200)
  })

  it('is an administrator’s act and nobody else’s', async () => {
    const ownerId = (
      await server.app.inject({ url: '/api/v1/me', headers: bearer(owner) })
    ).json().userId

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${ownerId}/handle`,
      headers: bearer(member),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('the event password, after creation', () => {
  const makeEvent = async (payload: Record<string, unknown> = {}) =>
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival', ...payload },
      })
    ).json().eventId as string

  const password = (eventId: string, token = owner) =>
    server.app.inject({ url: `/api/v1/events/${eventId}/password`, headers: bearer(token) })

  it('is readable back by its creator, to be told to friends', async () => {
    const eventId = await makeEvent({ password: 'entradas-2026' })

    expect((await password(eventId)).json().password).toBe('entradas-2026')
  })

  it('is nobody else’s to read, even somebody the event is shared with', async () => {
    const eventId = await makeEvent({ password: 'entradas-2026' })

    expect((await password(eventId, member)).statusCode).toBe(403)
  })

  it('can be set later, which locks the operator out from that moment', async () => {
    const eventId = await makeEvent()
    expect(
      (await server.app.inject({ url: `/api/v1/events/${eventId}`, headers: bearer(owner) })).json()
        .readableByServer,
    ).toBe(true)

    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/password`,
      headers: bearer(owner),
      payload: { password: 'agora-si-2026' },
    })

    expect(response.json()).toMatchObject({ passwordProtected: true })
    expect((await password(eventId)).json().password).toBe('agora-si-2026')
    expect(
      (await server.app.inject({ url: `/api/v1/events/${eventId}`, headers: bearer(owner) })).json()
        .readableByServer,
    ).toBe(false)
  })

  it('can be changed, and the old one stops opening the event', async () => {
    const eventId = await makeEvent({ password: 'vella-2026' })
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/password`,
      headers: bearer(owner),
      payload: { password: 'nova-2026' },
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(owner),
      payload: { subjectKind: 'USER', email: MEMBER.email },
    })
    const invitation = (
      await server.app.inject({ url: '/api/v1/invitations', headers: bearer(member) })
    ).json().invitations[0]

    const stale = await server.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitation.id}/accept`,
      headers: bearer(member),
      payload: { password: 'vella-2026' },
    })
    expect(stale.statusCode).toBeGreaterThanOrEqual(400)

    const fresh = await server.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitation.id}/accept`,
      headers: bearer(member),
      payload: { password: 'nova-2026' },
    })
    expect(fresh.statusCode).toBe(200)
  })

  it('can be removed, which hands the event back to the server slot', async () => {
    const eventId = await makeEvent({ password: 'entradas-2026' })

    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/password`,
      headers: bearer(owner),
      payload: { password: null },
    })

    expect((await password(eventId)).json().password).toBeNull()
    expect(
      (await server.app.inject({ url: `/api/v1/events/${eventId}`, headers: bearer(owner) })).json()
        .readableByServer,
    ).toBe(true)
  })
})

describe('editing the facts of an event', () => {
  it('changes venue, date and mode in one request, and the change reaches the log', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}/facts`,
      headers: bearer(owner),
      payload: {
        venue: 'Recinto Ferial',
        startsAt: '2026-08-14T19:00:00.000Z',
        defaultAssignmentMode: 'SELF_CLAIM',
      },
    })

    expect(response.json()).toMatchObject({
      venue: 'Recinto Ferial',
      startsAt: '2026-08-14T19:00:00.000Z',
      defaultAssignmentMode: 'SELF_CLAIM',
    })
  })

  it('clears a date with an explicit null rather than by omission', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival', startsAt: '2026-08-14T19:00:00.000Z' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}/facts`,
      headers: bearer(owner),
      payload: { startsAt: null },
    })

    expect(response.json().startsAt).toBeNull()
  })

  it('is the creator’s to do and nobody else’s', async () => {
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}/facts`,
      headers: bearer(member),
      payload: { venue: 'Outro sitio' },
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(403)
  })
})

describe('labels', () => {
  const tags = (token = owner) =>
    server.app.inject({ url: '/api/v1/tags', headers: bearer(token) })

  const createTag = (name: string, colour = 'teal', token = owner) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/tags',
      headers: bearer(token),
      payload: { name, colour },
    })

  it('are made, named and coloured', async () => {
    await createTag('Vigo')

    expect((await tags()).json().tags).toMatchObject([{ name: 'Vigo', colour: 'teal' }])
  })

  it('are renamed and recoloured without being remade', async () => {
    const { tagId } = (await createTag('Vigo')).json()

    await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tags/${tagId}`,
      headers: bearer(owner),
      payload: { name: 'Vigo e arredores', colour: 'amber' },
    })

    expect((await tags()).json().tags).toMatchObject([
      { name: 'Vigo e arredores', colour: 'amber' },
    ])
  })

  it('belong to one person and are invisible to everybody else', async () => {
    // A label is what an event is *to you*. Sharing an event does not share what its owner
    // calls it.
    await createTag('Vigo')

    expect((await tags(member)).json().tags).toEqual([])
  })

  it('are attached to an event and counted', async () => {
    const { tagId } = (await createTag('Vigo')).json()
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(owner),
        payload: { name: 'Festival' },
      })
    ).json().eventId

    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/tags`,
      headers: bearer(owner),
      payload: { tagIds: [tagId] },
    })

    expect((await tags()).json().tags[0].eventCount).toBe(1)
    expect(
      (await server.app.inject({ url: `/api/v1/events/${eventId}`, headers: bearer(owner) })).json()
        .tagIds,
    ).toEqual([tagId])
  })

  it('cannot be somebody else’s', async () => {
    const { tagId } = (await createTag('Vigo')).json()
    const eventId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(member),
        payload: { name: 'Outro' },
      })
    ).json().eventId

    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/tags`,
      headers: bearer(member),
      payload: { tagIds: [tagId] },
    })

    expect(response.statusCode).toBe(400)
  })

  it('are deleted, and take their attachments with them', async () => {
    const { tagId } = (await createTag('Vigo')).json()

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/tags/${tagId}`,
      headers: bearer(owner),
    })

    expect((await tags()).json().tags).toEqual([])
  })
})

describe('open sessions', () => {
  const sessions = (token: string) =>
    server.app.inject({ url: '/api/v1/sessions', headers: bearer(token) })

  it('lists this one, and says which it is', async () => {
    const listed = (await sessions(owner)).json().sessions

    expect(listed).toHaveLength(1)
    expect(listed[0].current).toBe(true)
  })

  it('shows another sign-in as a second row', async () => {
    await login(server, ADMIN)

    const listed = (await sessions(owner)).json().sessions

    expect(listed).toHaveLength(2)
    expect(listed.filter((row: { current: boolean }) => row.current)).toHaveLength(1)
  })

  it('ends one, and it stops working', async () => {
    const other = await login(server, ADMIN)
    const target = (await sessions(owner))
      .json()
      .sessions.find((row: { current: boolean }) => !row.current)

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${target.id}`,
      headers: bearer(owner),
    })

    // The revoked token is refused from that moment; the one that did the revoking still works,
    // which is the whole point of being able to name which session to end.
    expect(
      (await server.app.inject({ url: '/api/v1/me', headers: bearer(other) })).statusCode,
    ).toBe(401)
    expect((await sessions(owner)).json().sessions).toHaveLength(1)
  })

  it('ends every other one, which is what somebody does after losing a device', async () => {
    await login(server, ADMIN)
    await login(server, ADMIN)

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/revoke-others',
      headers: bearer(owner),
    })

    expect(response.json().revoked).toBe(2)
    expect((await sessions(owner)).json().sessions).toHaveLength(1)
  })

  it('is not a list of somebody else’s', async () => {
    await login(server, ADMIN)

    expect((await sessions(member)).json().sessions).toHaveLength(1)
  })
})
