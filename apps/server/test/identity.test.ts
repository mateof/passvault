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
