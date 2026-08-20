import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appleArchive, applePass, googlePassLink } from '../src/wallet.js'
import { generateKeyPairSync } from 'node:crypto'
import {
  ADMIN,
  bearer,
  login,
  registerFirstAdmin,
  startTestServer,
  type TestServer,
} from './helpers.js'

/**
 * Issuing into the wallet a phone already has.
 *
 * Neither wallet can be entered anonymously: Apple refuses a pass not signed by a Pass Type ID
 * certificate, and Google only shows an object from a registered issuer. Those are the point of
 * the systems, not obstacles to route around, so what is tested here is that an installation
 * without credentials says so plainly instead of producing a file a phone rejects silently — and
 * that the half which needs nothing but a key produces something correct.
 */
let server: TestServer
let organiser: string
let ticketId: string

beforeEach(async () => {
  server = await startTestServer()
  await registerFirstAdmin(server)
  organiser = await login(server, ADMIN)
  await server.app.inject({
    method: 'POST',
    url: '/api/v1/vault/unlock',
    headers: bearer(organiser),
    payload: { passphrase: ADMIN.passphrase },
  })
  const eventId = (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: bearer(organiser),
      payload: { name: 'Festival', startsAt: '2026-06-21T20:00:00.000Z' },
    })
  ).json().eventId
  ticketId = (
    await server.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/tickets`,
      headers: bearer(organiser),
      payload: { tickets: [{ label: 'Fila 3', barcode: { format: 'QR_CODE', value: 'CODE-1' } }] },
    })
  ).json().ticketIds[0]
})

afterEach(async () => {
  await server.dispose()
})

describe('an installation with no developer account', () => {
  it('says neither wallet is available rather than offering a button', async () => {
    const response = await server.app.inject({ url: '/api/v1/wallet', headers: bearer(organiser) })

    expect(response.json()).toEqual({ apple: false, google: false })
  })

  it('refuses an Apple pass with a sentence, not a broken file', async () => {
    const response = await server.app.inject({
      url: `/api/v1/tickets/${ticketId}/pass.pkpass`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('wallet.error.notConfigured')
  })

  it('refuses a Google link the same way', async () => {
    const response = await server.app.inject({
      url: `/api/v1/tickets/${ticketId}/pass.google`,
      headers: bearer(organiser),
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('the Google link, which needs nothing but a signing key', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const config = {
    issuerId: '3388000000000000000',
    serviceAccountEmail: 'passvault@example.iam.gserviceaccount.com',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    classSuffix: 'passvault-event',
  }
  const contents = {
    serialNumber: 'ticket-1',
    eventName: 'Festival do Norte',
    venue: 'Recinto Ferial',
    startsAt: '2026-06-21T20:00:00.000Z',
    seat: 'Fila 3',
    holder: 'Brais',
    barcode: { format: 'QR_CODE', value: 'CODE-1' },
  }

  it('is a save link carrying a signed JWT', () => {
    const link = googlePassLink(config, contents)

    expect(link.startsWith('https://pay.google.com/gp/v/save/')).toBe(true)
    expect(link.split('/').pop()!.split('.')).toHaveLength(3)
  })

  it('carries the ticket inside the token', () => {
    const link = googlePassLink(config, contents)
    const body = link.split('/').pop()!.split('.')[1]!

    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))

    expect(claims.payload.eventTicketObjects[0]).toMatchObject({
      id: `${config.issuerId}.ticket-1`,
      barcode: { type: 'QR_CODE', value: 'CODE-1' },
    })
  })

  it('uses the ticket id, so re-adding updates the pass instead of duplicating it', () => {
    const first = googlePassLink(config, contents)
    const second = googlePassLink(config, contents)

    const idOf = (link: string) =>
      JSON.parse(Buffer.from(link.split('/').pop()!.split('.')[1]!, 'base64url').toString('utf8'))
        .payload.eventTicketObjects[0].id
    expect(idOf(first)).toBe(idOf(second))
  })

  it('refuses a symbology no wallet can show, rather than writing a pass nothing reads', () => {
    expect(() =>
      googlePassLink(config, {
        ...contents,
        barcode: { format: 'EAN_13', value: '8412345678901' },
      }),
    ).toThrow()
  })
})

describe('what an Apple pass is made of', () => {
  // The archive is this project's responsibility; the signature needs a developer account and is
  // the one part that cannot be checked without one.
  const config = {
    certificatePem: 'not a certificate',
    keyPem: 'not a key',
    wwdrPem: 'not a chain',
    passTypeIdentifier: 'pass.org.example.passvault',
    teamIdentifier: 'ABCDE12345',
    organizationName: 'PassVault',
  }
  const contents = {
    serialNumber: 'ticket-1',
    eventName: 'Festival do Norte',
    venue: 'Recinto Ferial',
    startsAt: '2026-06-21T20:00:00.000Z',
    seat: 'Fila 3',
    holder: 'Brais',
    barcode: { format: 'QR_CODE', value: 'CODE-1' },
  }

  it('carries the files Apple refuses a pass without', () => {
    const { files } = appleArchive(config, contents)

    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['pass.json', 'icon.png', 'icon@2x.png']),
    )
  })

  it('digests every file into the manifest, which is what the signature covers', () => {
    const { files, manifestJson } = appleArchive(config, contents)

    const manifest = JSON.parse(manifestJson)

    expect(Object.keys(manifest).sort()).toEqual(Object.keys(files).sort())
    // SHA-1 hex, because that is what the format specifies rather than what anybody would pick.
    for (const digest of Object.values(manifest)) {
      expect(digest).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('writes the barcode in Apple’s vocabulary, not this project’s', () => {
    const { files } = appleArchive(config, contents)

    const pass = JSON.parse(Buffer.from(files['pass.json']!).toString('utf8'))

    expect(pass.barcodes[0]).toMatchObject({
      format: 'PKBarcodeFormatQR',
      message: 'CODE-1',
    })
  })

  it('uses the ticket id as the serial, so re-adding updates the pass', () => {
    const { files } = appleArchive(config, contents)

    const pass = JSON.parse(Buffer.from(files['pass.json']!).toString('utf8'))

    expect(pass.serialNumber).toBe('ticket-1')
  })

  it('refuses a symbology no wallet can show', () => {
    expect(() =>
      appleArchive(config, { ...contents, barcode: { format: 'EAN_13', value: '8412345678901' } }),
    ).toThrow()
  })

  it('fails to sign without a real certificate, which is the honest outcome', async () => {
    // Not a silent unsigned pass: Apple would reject that at the phone with nothing an operator
    // could act on, so the refusal happens here where it can be read.
    await expect(applePass(config, contents)).rejects.toThrowError('wallet.error.signingFailed')
  })
})
