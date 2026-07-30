import { describe, expect, it } from 'vitest'
import { generateAgreementKeyPair } from '@passvault/crypto'
import { inspectTkpak, openWithPassword, openWithRecipientKey, writeTkpak } from '@passvault/tkpak'
import { ARGON2, EVENT_PASSWORD, aBundle, aPdfDocument, aRecipient, anIssuer } from './fixtures.js'

describe('exporting and importing with an event password', () => {
  it('returns the tickets that were exported', async () => {
    const bundle = aBundle()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle,
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(opened.bundle.tickets).toEqual(bundle.tickets)
  })

  it('returns the event as it was exported', async () => {
    const bundle = aBundle()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle,
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(opened.bundle.event).toEqual(bundle.event)
  })

  it('rejects the wrong password without hinting at the right one', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    await expect(openWithPassword(archive, 'nunca máis')).rejects.toThrowError(
      expect.objectContaining({ code: 'WRONG_PASSWORD' }),
    )
  })

  it('returns the ticket documents alongside the metadata', async () => {
    const document = aPdfDocument()
    const bundle = aBundle()
    bundle.tickets[0]!.documentBlobId = document.id

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle,
      documents: [document],
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(opened.documents.get(document.id)?.bytes).toEqual(document.bytes)
  })

  it('preserves the media type of each document', async () => {
    const document = aPdfDocument()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      documents: [document],
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(opened.documents.get(document.id)?.mediaType).toBe('application/pdf')
  })

  it('identifies the device that produced the file', async () => {
    const issuer = anIssuer('Mateo')

    const { archive } = await writeTkpak({
      issuer,
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })
    const opened = await openWithPassword(archive, EVENT_PASSWORD)

    expect(opened.manifest.issuer.deviceId).toBe(issuer.deviceId)
  })
})

describe('exporting to a known recipient', () => {
  it('opens with the recipient key and needs no password', async () => {
    const recipient = aRecipient()
    const bundle = aBundle()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle,
      recipientPublicKey: recipient.publicKey,
    })
    const opened = openWithRecipientKey(archive, recipient.privateKey, recipient.publicKey)

    expect(opened.bundle.tickets).toEqual(bundle.tickets)
  })

  it('cannot be opened by anyone else', async () => {
    const recipient = aRecipient()
    const stranger = generateAgreementKeyPair()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      recipientPublicKey: recipient.publicKey,
    })

    expect(() =>
      openWithRecipientKey(archive, stranger.privateKey, stranger.publicKey),
    ).toThrowError(expect.objectContaining({ code: 'NO_USABLE_KEY_SLOT' }))
  })

  it('cannot be opened with a password, because it has no password slot', async () => {
    const recipient = aRecipient()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      recipientPublicKey: recipient.publicKey,
    })

    await expect(openWithPassword(archive, EVENT_PASSWORD)).rejects.toThrowError(
      expect.objectContaining({ code: 'NO_USABLE_KEY_SLOT' }),
    )
  })
})

describe('a file with both a password and a recipient slot', () => {
  it('opens with the password', async () => {
    const recipient = aRecipient()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
      recipientPublicKey: recipient.publicKey,
    })

    await expect(openWithPassword(archive, EVENT_PASSWORD)).resolves.toBeDefined()
  })

  it('opens with the recipient key', async () => {
    const recipient = aRecipient()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
      recipientPublicKey: recipient.publicKey,
    })

    expect(() =>
      openWithRecipientKey(archive, recipient.privateKey, recipient.publicKey),
    ).not.toThrow()
  })

  it('yields the same file key both ways, so the ciphertext is stored once', async () => {
    const recipient = aRecipient()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
      recipientPublicKey: recipient.publicKey,
    })

    const viaPassword = await openWithPassword(archive, EVENT_PASSWORD)
    const viaKey = openWithRecipientKey(archive, recipient.privateKey, recipient.publicKey)

    expect(viaPassword.bundle).toEqual(viaKey.bundle)
  })
})

describe('writing a file nobody could open', () => {
  it('is refused rather than produced', async () => {
    const attempt = writeTkpak({ issuer: anIssuer(), bundle: aBundle() })

    await expect(attempt).rejects.toThrowError(
      expect.objectContaining({ code: 'NO_USABLE_KEY_SLOT' }),
    )
  })
})

describe('inspecting a file before decrypting it', () => {
  it('reports how many tickets it holds without any key', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    expect(inspectTkpak(archive).manifest.preview?.ticketCount).toBe(4)
  })

  it('names the event by default, so a recipient can tell forwarded files apart', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    expect(inspectTkpak(archive).manifest.preview?.eventName).toBe('Festival do Norte 2026')
  })

  it('reveals nothing but the count when minimal metadata is asked for', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
      preview: 'minimal',
    })

    expect(inspectTkpak(archive).manifest.preview).toEqual({ ticketCount: 4 })
  })

  it('omits the preview entirely when asked', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
      preview: 'none',
    })

    expect(inspectTkpak(archive).manifest.preview).toBeUndefined()
  })

  it('never puts a barcode in the cleartext preview', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    expect(JSON.stringify(inspectTkpak(archive).manifest.preview)).not.toContain('8412')
  })

  it('says the file can be opened with a password', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    expect(inspectTkpak(archive).canOpenWithPassword).toBe(true)
  })

  it('lists the recipient a sealed file is addressed to', async () => {
    const recipient = aRecipient()

    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      recipientPublicKey: recipient.publicKey,
    })

    expect(inspectTkpak(archive).sealedFor).toHaveLength(1)
  })

  it('confirms the signature of an untouched file', async () => {
    const { archive } = await writeTkpak({
      issuer: anIssuer(),
      bundle: aBundle(),
      password: EVENT_PASSWORD,
      argon2Params: ARGON2,
    })

    expect(inspectTkpak(archive).signatureValid).toBe(true)
  })
})
