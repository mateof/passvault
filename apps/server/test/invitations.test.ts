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
 * Being offered an event, and answering.
 *
 * Sharing used to put an event in somebody's wallet without asking. For a thing that carries a
 * friend's name, their seat and sometimes what they paid, that is the wrong default — and there
 * was nowhere to tell them either, so a share was invisible until they happened to look.
 *
 * The tests worth reading are the two that say what an invitation is *for*: an event does not
 * open until it is accepted, and the password is typed at the moment of accepting, by the person
 * who has to type it.
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
      payload: { name: 'Festival do Norte' },
    })
  ).json().eventId
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

const share = (payload: Record<string, unknown> = {}, event = eventId) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${event}/access`,
    headers: bearer(organiser),
    payload: { subjectKind: 'USER', email: MEMBER.email, ...payload },
  })

const invitations = (token = member) =>
  server.app.inject({ url: '/api/v1/invitations', headers: bearer(token) })

const notices = (token = member) =>
  server.app.inject({ url: '/api/v1/notifications', headers: bearer(token) })

const events = (token: string) =>
  server.app.inject({ url: '/api/v1/events', headers: bearer(token) })

const accept = (id: string, password?: string, token = member) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/invitations/${id}/accept`,
    headers: bearer(token),
    payload: password === undefined ? {} : { password },
  })

describe('being offered an event', () => {
  it('does not put it in the wallet before it is answered', async () => {
    await share()

    expect((await events(member)).json().events).toEqual([])
  })

  it('appears as something to answer', async () => {
    await share()

    expect((await invitations()).json().invitations).toMatchObject([{ eventId, state: 'PENDING' }])
  })

  it('arrives as a notice, naming the event and who sent it', async () => {
    // The name is in the notice rather than in the invitation, because the invitation is a row
    // about an event whose name is encrypted under a key the recipient does not have yet.
    await share()

    const [notice] = (await notices()).json().notifications
    expect(notice).toMatchObject({ kind: 'event.invited', read: false })
    expect(notice.payload.eventName).toBe('Festival do Norte')
  })

  it('is not sent to the creator, who already holds it', async () => {
    await share()

    expect((await notices(organiser)).json().notifications).toEqual([])
  })
})

describe('accepting', () => {
  it('is what puts the event in the wallet', async () => {
    await share()
    const [invitation] = (await invitations()).json().invitations

    const response = await accept(invitation.id)

    expect(response.statusCode).toBe(200)
    expect((await events(member)).json().events).toHaveLength(1)
  })

  it('takes the event password, which is where the recipient types it', async () => {
    const protectedEvent = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(organiser),
        payload: { name: 'Concerto', password: 'entradas-2026' },
      })
    ).json().eventId
    await share({}, protectedEvent)
    const [invitation] = (await invitations()).json().invitations

    const response = await accept(invitation.id, 'entradas-2026')

    expect(response.statusCode).toBe(200)
    expect((await events(member)).json().events).toHaveLength(1)
  })

  it('refuses a wrong password rather than accepting an event nobody can read', async () => {
    // An accepted event that cannot be decrypted is a row that renders as nothing, and the
    // failure would arrive later, in a list, indistinguishable from a bug.
    const protectedEvent = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(organiser),
        payload: { name: 'Concerto', password: 'entradas-2026' },
      })
    ).json().eventId
    await share({}, protectedEvent)
    const [invitation] = (await invitations()).json().invitations

    const response = await accept(invitation.id, 'wrong')

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect((await events(member)).json().events).toEqual([])
    expect((await invitations()).json().invitations[0].state).toBe('PENDING')
  })

  it('tells the person who shared it', async () => {
    await share()
    const [invitation] = (await invitations()).json().invitations

    await accept(invitation.id)

    expect((await notices(organiser)).json().notifications).toMatchObject([
      { kind: 'event.accepted' },
    ])
  })
})

describe('declining', () => {
  it('leaves the wallet alone and says so', async () => {
    await share()
    const [invitation] = (await invitations()).json().invitations

    await server.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitation.id}/decline`,
      headers: bearer(member),
    })

    expect((await events(member)).json().events).toEqual([])
    expect((await notices(organiser)).json().notifications).toMatchObject([
      { kind: 'event.declined' },
    ])
  })
})

describe('an invitation is one person’s to answer', () => {
  it('is not answerable by somebody else', async () => {
    await share()
    const [invitation] = (await invitations()).json().invitations

    const response = await accept(invitation.id, undefined, organiser)

    expect(response.statusCode).toBe(403)
  })
})

describe('taking a share back', () => {
  it('withdraws an invitation nobody has answered', async () => {
    await share()

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: { subjectKind: 'USER', email: MEMBER.email },
    })

    expect((await invitations()).json().invitations).toEqual([])
  })
})

describe('sharing with a group', () => {
  it('offers it to everybody in the circle, and to nobody who has not answered', async () => {
    const groupId = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/groups',
        headers: bearer(organiser),
        payload: { name: 'A familia' },
      })
    ).json().groupId
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/groups/${groupId}/members`,
      headers: bearer(organiser),
      payload: { email: MEMBER.email },
    })

    await share({ subjectKind: 'GROUP', subjectId: groupId, email: undefined })

    expect((await invitations()).json().invitations).toHaveLength(1)
    // Being in a group that was offered an event is not the same as holding it. Without this,
    // adding somebody to a group would fill their wallet with things they never agreed to.
    expect((await events(member)).json().events).toEqual([])
  })
})

describe('the notices list', () => {
  it('counts what has not been read, and stops counting once it has', async () => {
    await share()

    expect((await notices()).json().unread).toBe(1)

    await server.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: bearer(member),
      payload: {},
    })

    expect((await notices()).json().unread).toBe(0)
  })
})
