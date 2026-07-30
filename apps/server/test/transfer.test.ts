import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectTkpak, openWithPassword } from '@passvault/tkpak'
import { barcodePng, ticketPdf } from '../../../packages/ingest/test/fixtures.js'
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
 * Handing tickets to somebody else, and taking somebody else's in.
 *
 * The `.tkpak` format exists so this works with no server at all; these endpoints are the
 * convenience path for the web interface and for a phone that happens to be online. The
 * behaviour they must share with the offline path is what the tests check: the same visibility
 * rules, the same signature, and the same honesty about what an export cannot be taken back.
 */
let server: TestServer
let organiser: string
let member: string
let memberUserId: string
let eventId: string

const EXPORT_PASSWORD = 'sempre-en-galiza'

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
      payload: { name: 'Festival do Norte 2026', venue: 'Recinto Ferial' },
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

const addTickets = (tickets: Record<string, unknown>[]) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/tickets`,
    headers: bearer(organiser),
    payload: { tickets },
  })

const exportEvent = (token: string, payload: Record<string, unknown> = {}) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/export`,
    headers: bearer(token),
    payload: { password: EXPORT_PASSWORD, ...payload },
  })

describe('exporting an event', () => {
  beforeEach(async () => {
    await addTickets([
      { label: 'Grada A 14-B', barcode: { format: 'QR_CODE', value: '8412-EXP-0001' } },
      { label: 'Grada A 14-C', barcode: { format: 'AZTEC', value: '8412-EXP-0002' } },
    ])
  })

  it('returns a file', async () => {
    const response = await exportEvent(organiser)

    expect(response.statusCode).toBe(200)
  })

  it('declares the interchange media type', async () => {
    const response = await exportEvent(organiser)

    expect(response.headers['content-type']).toBe('application/vnd.passvault.tkpak')
  })

  it('says outright that the file cannot be taken back', async () => {
    const response = await exportEvent(organiser)

    expect(response.headers['x-passvault-revocable']).toBe('false')
  })

  it('produces a file that opens with the password given', async () => {
    const response = await exportEvent(organiser)

    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(opened.bundle.tickets).toHaveLength(2)
  })

  it('carries the barcodes', async () => {
    const response = await exportEvent(organiser)

    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(opened.bundle.tickets.map((ticket) => ticket.barcode?.value)).toEqual([
      '8412-EXP-0001',
      '8412-EXP-0002',
    ])
  })

  it('carries the event name', async () => {
    const response = await exportEvent(organiser)

    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(opened.bundle.event.name).toBe('Festival do Norte 2026')
  })

  it('is signed by this installation', async () => {
    const response = await exportEvent(organiser)

    expect(inspectTkpak(new Uint8Array(response.rawPayload)).signatureValid).toBe(true)
  })

  it('names the event in the preview so a recipient can tell forwarded files apart', async () => {
    const response = await exportEvent(organiser)

    expect(inspectTkpak(new Uint8Array(response.rawPayload)).manifest.preview?.eventName).toBe(
      'Festival do Norte 2026',
    )
  })

  it('can be asked to reveal nothing but the ticket count', async () => {
    const response = await exportEvent(organiser, { preview: 'minimal' })

    expect(inspectTkpak(new Uint8Array(response.rawPayload)).manifest.preview).toEqual({
      ticketCount: 2,
    })
  })

  it('exports only the tickets that were asked for', async () => {
    const { tickets } = (
      await server.app.inject({
        url: `/api/v1/events/${eventId}/tickets`,
        headers: bearer(organiser),
      })
    ).json()

    const response = await exportEvent(organiser, { ticketIds: [tickets[0].id] })
    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(opened.bundle.tickets).toHaveLength(1)
  })

  it('records on each ticket that a copy is in circulation', async () => {
    await exportEvent(organiser)

    const stored = await server.db.db.selectFrom('tickets').select('exported_at').execute()

    expect(stored.every((row) => row.exported_at !== null)).toBe(true)
  })

  it('refuses to export without a password or a recipient key', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/export`,
      headers: bearer(organiser),
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses somebody with no access to the event', async () => {
    const response = await exportEvent(member)

    expect(response.statusCode).toBe(403)
  })
})

describe('an export never shows more than the exporter could see', () => {
  it('omits a payment record the recipient is not entitled to', async () => {
    const { ticketIds } = (
      await addTickets([{ label: 'one', barcode: { format: 'QR_CODE', value: '8412-VIS-0001' } }])
    ).json()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketIds[0]}/payment`,
      headers: bearer(organiser),
      payload: { state: 'UNPAID', amountCents: 9999, currency: 'EUR', visibility: 'CREATOR_ONLY' },
    })

    // Exported for Ana, who is not the organiser and does not hold the ticket.
    const response = await exportEvent(organiser, { exportedFor: 'Ana' })
    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(JSON.stringify(opened.bundle)).not.toContain('9999')
  })

  it('keeps a record marked visible to everybody', async () => {
    const { ticketIds } = (
      await addTickets([{ label: 'one', barcode: { format: 'QR_CODE', value: '8412-VIS-0002' } }])
    ).json()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketIds[0]}/payment`,
      headers: bearer(organiser),
      payload: { state: 'PAID', amountCents: 4500, currency: 'EUR', visibility: 'ALL' },
    })

    const response = await exportEvent(organiser, { exportedFor: 'Ana' })
    const opened = await openWithPassword(new Uint8Array(response.rawPayload), EXPORT_PASSWORD)

    expect(opened.bundle.tickets[0]?.payment?.amountCents).toBe(4500)
  })
})

describe('inspecting a received file before opening it', () => {
  it('reports the ticket count without any password', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-INS-0001' } }])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/import/inspect',
      headers: { ...bearer(member), 'content-type': 'application/vnd.passvault.tkpak' },
      payload: archive,
    })

    expect(response.json().ticketCount).toBe(1)
  })

  it('says whether a password is needed', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-INS-0002' } }])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/import/inspect',
      headers: { ...bearer(member), 'content-type': 'application/vnd.passvault.tkpak' },
      payload: archive,
    })

    expect(response.json().needsPassword).toBe(true)
  })
})

describe('importing a received file', () => {
  const importArchive = (token: string, archive: Buffer, password: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/import',
      headers: {
        ...bearer(token),
        'content-type': 'application/vnd.passvault.tkpak',
        'x-passvault-password': password,
      },
      payload: archive,
    })

  it('creates an event owned by the importer', async () => {
    await addTickets([
      { label: 'Grada A 14-B', barcode: { format: 'QR_CODE', value: '8412-IMP-0001' } },
    ])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await importArchive(member, archive, EXPORT_PASSWORD)

    expect(response.statusCode).toBe(201)
  })

  it('brings the tickets across', async () => {
    await addTickets([
      { label: 'one', barcode: { format: 'QR_CODE', value: '8412-IMP-0002' } },
      { label: 'two', barcode: { format: 'QR_CODE', value: '8412-IMP-0003' } },
    ])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await importArchive(member, archive, EXPORT_PASSWORD)

    expect(response.json().ticketCount).toBe(2)
  })

  it('makes them readable by the importer, under their own event key', async () => {
    await addTickets([{ label: 'one', barcode: { format: 'QR_CODE', value: '8412-IMP-0004' } }])
    const archive = (await exportEvent(organiser)).rawPayload
    const { eventId: imported } = (await importArchive(member, archive, EXPORT_PASSWORD)).json()

    const response = await server.app.inject({
      url: `/api/v1/events/${imported}/tickets`,
      headers: bearer(member),
    })

    expect(response.json().tickets[0].barcode.value).toBe('8412-IMP-0004')
  })

  it('confirms the signature verified', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-IMP-0005' } }])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await importArchive(member, archive, EXPORT_PASSWORD)

    expect(response.json().signatureValid).toBe(true)
  })

  it('refuses the wrong password', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-IMP-0006' } }])
    const archive = (await exportEvent(organiser)).rawPayload

    const response = await importArchive(member, archive, 'nunca-mais')

    expect(response.json().error).toBe('tkpak.error.WRONG_PASSWORD')
  })

  it('needs an unlocked vault, since the imported event is keyed to the importer', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-IMP-0007' } }])
    const archive = (await exportEvent(organiser)).rawPayload
    const locked = await login(server, MEMBER)

    const response = await importArchive(locked, archive, EXPORT_PASSWORD)

    expect(response.statusCode).toBe(401)
  })

  it('does not fold somebody else’s tickets into an event the importer already has', async () => {
    await addTickets([{ barcode: { format: 'QR_CODE', value: '8412-IMP-0008' } }])
    const archive = (await exportEvent(organiser)).rawPayload

    const { eventId: imported } = (await importArchive(member, archive, EXPORT_PASSWORD)).json()

    expect(imported).not.toBe(eventId)
  })
})

describe('ingesting a ticket document', () => {
  const ingest = (bytes: Uint8Array, contentType: string) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest`,
      headers: { ...bearer(organiser), 'content-type': contentType },
      payload: Buffer.from(bytes),
    })

  it('proposes one ticket per page of a multi-page PDF', async () => {
    const pdf = await ticketPdf([
      { codes: [{ text: '8412-ING-0001' }] },
      { codes: [{ text: '8412-ING-0002' }] },
    ])

    const response = await ingest(pdf, 'application/pdf')

    expect(response.json().entries).toHaveLength(2)
  })

  it('reads the barcodes', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-ING-0003' }] }])

    const response = await ingest(pdf, 'application/pdf')

    expect(response.json().entries[0].barcode.value).toBe('8412-ING-0003')
  })

  it('says the result needs reviewing rather than saving it', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-ING-0004' }] }])

    const response = await ingest(pdf, 'application/pdf')

    expect(response.json().requiresReview).toBe(true)
  })

  it('creates no tickets until the proposal is confirmed', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-ING-0005' }] }])
    await ingest(pdf, 'application/pdf')

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(response.json().tickets).toEqual([])
  })

  it('excludes a page with no barcode from the suggestion', async () => {
    const pdf = await ticketPdf([
      { codes: [], heading: 'Please bring photo identification' },
      { codes: [{ text: '8412-ING-0006' }] },
    ])

    const response = await ingest(pdf, 'application/pdf')

    expect(response.json().entries[0].include).toBe(false)
  })

  it('creates the tickets on confirmation', async () => {
    const pdf = await ticketPdf([
      { codes: [{ text: '8412-ING-0007' }] },
      { codes: [{ text: '8412-ING-0008' }] },
    ])
    const { ingestId } = (await ingest(pdf, 'application/pdf')).json()

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
      headers: bearer(organiser),
      payload: {},
    })

    expect(response.json().ticketIds).toHaveLength(2)
  })

  it('honours the user overriding which pages are tickets', async () => {
    const pdf = await ticketPdf([
      { codes: [{ text: '8412-ING-0009' }] },
      { codes: [{ text: '8412-ING-0010' }] },
    ])
    const { ingestId } = (await ingest(pdf, 'application/pdf')).json()

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
      headers: bearer(organiser),
      payload: { include: [1] },
    })

    expect(response.json().ticketIds).toHaveLength(1)
  })

  it('reports how many entries were skipped', async () => {
    const pdf = await ticketPdf([
      { codes: [], heading: 'Instructions' },
      { codes: [{ text: '8412-ING-0011' }] },
    ])
    const { ingestId } = (await ingest(pdf, 'application/pdf')).json()

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
      headers: bearer(organiser),
      payload: {},
    })

    expect(response.json().skipped).toBe(1)
  })

  it('carries the barcode onto the created ticket', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-ING-0012' }] }])
    const { ingestId } = (await ingest(pdf, 'application/pdf')).json()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
      headers: bearer(organiser),
      payload: {},
    })

    const response = await server.app.inject({
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
    })

    expect(response.json().tickets[0].barcode.value).toBe('8412-ING-0012')
  })

  it('accepts a plain image of a ticket', async () => {
    const png = await barcodePng('8412-ING-0013')

    const response = await ingest(png, 'image/png')

    expect(response.json().entries[0].barcode.value).toBe('8412-ING-0013')
  })

  it('rejects a file it does not recognise', async () => {
    const response = await ingest(
      new Uint8Array(Buffer.from('this is a text file', 'utf8')),
      'application/octet-stream',
    )

    expect(response.json().error).toBe('ingest.error.unsupportedFile')
  })

  it('stores the ticket document encrypted, so the filesystem never holds a readable ticket', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-ING-0014' }] }])
    const { ingestId } = (await ingest(pdf, 'application/pdf')).json()
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/ingest/${ingestId}/confirm`,
      headers: bearer(organiser),
      payload: {},
    })

    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const blob = await server.db.db
      .selectFrom('blobs')
      .select('storage_path')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow()
    const onDisk = await readFile(resolve(server.config.blobDir, blob.storage_path))

    expect(onDisk.subarray(0, 4).toString('ascii')).not.toBe('%PDF')
  })
})
