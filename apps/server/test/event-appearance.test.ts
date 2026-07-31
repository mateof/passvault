import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketPdf } from '../../../packages/ingest/test/fixtures.js'
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
 * How an event looks, and what it was imported from.
 *
 * Two features that share a reason for existing: a wallet of twelve events is a list of twelve
 * identical rectangles unless something tells them apart, and the file a person was actually
 * sent disappears entirely once it has been split into passes.
 *
 * The icon and the colour are plaintext and the picture is not, which is the line worth testing:
 * a category is not user data, and a poster carries a name, a date and often a seat.
 */
let server: TestServer
let organiser: string
let member: string
let eventId: string

/** A tiny valid PNG, written out so the test needs no canvas and no fixture file. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAB1AwTAAAAGUlEQVR4nGP8z4AATAxIHDgLxsIhjC' +
    'YOAP//AwB1lgQBAAAAAElFTkSuQmCC',
  'base64',
)

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  organiser = await login(server, ADMIN)
  await unlock(organiser, ADMIN.passphrase)
  await setRegistrationMode(server, organiser, 'OPEN')
  await server.app.inject({ method: 'POST', url: '/api/v1/registration', payload: MEMBER })
  member = await login(server, MEMBER)
  await unlock(member, MEMBER.passphrase)

  eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival do Norte', icon: 'concert', colour: 'amber' },
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

const event = (token = organiser) =>
  server.app.inject({ url: `/api/v1/events/${eventId}`, headers: bearer(token) })

describe('the mark an event is recognised by', () => {
  it('is kept from the moment it is created', async () => {
    expect((await event()).json()).toMatchObject({ icon: 'concert', colour: 'amber' })
  })

  it('can be changed afterwards', async () => {
    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}`,
      headers: bearer(organiser),
      payload: { icon: 'party', colour: 'pink' },
    })

    expect(response.json()).toMatchObject({ icon: 'party', colour: 'pink' })
  })

  it('refuses an icon this version does not know, rather than storing it', async () => {
    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}`,
      headers: bearer(organiser),
      payload: { icon: '"><script>' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('is not repainted by somebody the event was merely shared with', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/access`,
      headers: bearer(organiser),
      payload: {
        subjectKind: 'USER',
        subjectId: (await server.app.inject({ url: '/api/v1/me', headers: bearer(member) })).json()
          .userId,
      },
    })

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventId}`,
      headers: bearer(member),
      payload: { colour: 'red' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('a picture of the event', () => {
  const upload = (token = organiser) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/image`,
      headers: { ...bearer(token), 'content-type': 'image/png' },
      payload: PNG,
    })

  it('is stored and comes back byte for byte, having been encrypted in between', async () => {
    await upload()

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/image`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect(Buffer.from(response.rawPayload)).toEqual(PNG)
  })

  it('is announced on the event, so a list knows whether to fetch one', async () => {
    expect((await event()).json().hasImage).toBe(false)

    await upload()

    expect((await event()).json().hasImage).toBe(true)
  })

  it('can be removed, and the event falls back to its icon', async () => {
    await upload()

    await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${eventId}/image`,
      headers: bearer(organiser),
    })

    expect((await event()).json()).toMatchObject({ hasImage: false, icon: 'concert' })
  })

  it('refuses something that is not an image', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/image`,
      headers: { ...bearer(organiser), 'content-type': 'application/pdf' },
      payload: Buffer.from(await ticketPdf([{ codes: [{ text: '8412-NOT-AN-IMAGE' }] }])),
    })

    expect(response.statusCode).toBe(400)
  })

  it('is not there to be fetched when the event has none', async () => {
    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/image`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('the document tickets were split out of', () => {
  const ingestAndConfirm = async (): Promise<void> => {
    const pdf = await ticketPdf([
      { codes: [{ text: '8412-DOC-0001' }], heading: 'Entrada 1' },
      { codes: [{ text: '8412-DOC-0002' }], heading: 'Entrada 2' },
      { codes: [], heading: 'Como chegar' },
    ])
    const proposal = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest`,
      headers: { ...bearer(organiser), 'content-type': 'application/pdf' },
      payload: Buffer.from(pdf),
    })
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${proposal.json().ingestId}/confirm`,
      headers: bearer(organiser),
      payload: { include: [0, 1] },
    })
  }

  const documents = () =>
    server.app.inject({
      url: `/api/v1/events/${eventId}/documents`,
      headers: bearer(organiser),
    })

  it('is listed once the import is confirmed', async () => {
    await ingestAndConfirm()

    expect(documents().then((r) => r.json().documents)).resolves.toHaveLength(1)
  })

  it('says how many pages it had, including the ones that were not tickets', async () => {
    await ingestAndConfirm()

    expect((await documents()).json().documents[0]).toMatchObject({
      mediaType: 'PDF',
      pageCount: 3,
    })
  })

  it('names the tickets that came out of it', async () => {
    await ingestAndConfirm()

    expect((await documents()).json().documents[0].ticketIds).toHaveLength(2)
  })

  it('is nothing at all before anything has been imported', async () => {
    expect((await documents()).json().documents).toEqual([])
  })

  it('can be fetched whole, which is the point of keeping it', async () => {
    await ingestAndConfirm()
    const [document] = (await documents()).json().documents

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/documents/${document.id}`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
  })

  it('cannot be fetched through an event it does not belong to', async () => {
    await ingestAndConfirm()
    const [document] = (await documents()).json().documents
    const elsewhere = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: bearer(organiser),
        payload: { name: 'Outro evento' },
      })
    ).json().eventId

    const response = await server.app.inject({
      url: `/api/v1/events/${elsewhere}/documents/${document.id}`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(404)
  })

  it('becomes the cover, so an imported event is recognisable without choosing anything', async () => {
    await ingestAndConfirm()

    expect((await event()).json().hasImage).toBe(true)
  })

  it('does not replace a picture the organiser chose', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/image`,
      headers: { ...bearer(organiser), 'content-type': 'image/png' },
      payload: PNG,
    })

    await ingestAndConfirm()
    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/image`,
      headers: bearer(organiser),
    })

    expect(Buffer.from(response.rawPayload)).toEqual(PNG)
  })
})
