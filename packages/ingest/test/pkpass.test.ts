import { describe, expect, it } from 'vitest'
import { includedTickets, propose, readPkpass } from '@passvault/ingest'
import { pkpass } from './fixtures.js'

describe('reading an Apple Wallet pass', () => {
  it('reads the barcode payload', () => {
    expect(readPkpass(pkpass()).barcodes[0]?.value).toBe('8412-PKPASS-0001')
  })

  it('maps Apple format names to the project ones', () => {
    expect(readPkpass(pkpass()).barcodes[0]?.format).toBe('QR_CODE')
  })

  it('reads a PDF417 pass', () => {
    const pass = pkpass({
      barcodes: [{ format: 'PKBarcodeFormatPDF417', message: '8412-PKPASS-0417' }],
    })

    expect(readPkpass(pass).barcodes[0]?.format).toBe('PDF_417')
  })

  it('reads every barcode when a pass carries several', () => {
    const pass = pkpass({
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: 'one' },
        { format: 'PKBarcodeFormatAztec', message: 'two' },
      ],
    })

    expect(readPkpass(pass).barcodes).toHaveLength(2)
  })

  it('skips a barcode in a format it does not know rather than failing the pass', () => {
    const pass = pkpass({
      barcodes: [
        { format: 'PKBarcodeFormatSomethingNew', message: 'ignored' },
        { format: 'PKBarcodeFormatQR', message: 'kept' },
      ],
    })

    expect(readPkpass(pass).barcodes.map((barcode) => barcode.value)).toEqual(['kept'])
  })

  it('finds the event name in the free-form field array Apple defines', () => {
    expect(readPkpass(pkpass({ eventName: 'Festival do Norte 2026' })).eventName).toBe(
      'Festival do Norte 2026',
    )
  })

  it('finds the venue the same way', () => {
    expect(readPkpass(pkpass({ venue: 'Recinto Ferial' })).venue).toBe('Recinto Ferial')
  })

  it('keeps the rendered images so the pass can be shown, not only read', () => {
    expect(readPkpass(pkpass()).images.has('icon.png')).toBe(true)
  })

  it('rejects a ZIP with no pass.json', () => {
    const notAPass = pkpass()
    // Truncating produces a ZIP that no longer parses, which is the honest failure here.
    expect(() => readPkpass(notAPass.slice(0, 40))).toThrowError(
      expect.objectContaining({ code: 'PKPASS_MALFORMED' }),
    )
  })
})

describe('pass integrity', () => {
  it('confirms the digests of an untouched pass', () => {
    expect(readPkpass(pkpass()).integrity.digestsMatch).toBe(true)
  })

  it('detects a pass edited after it was signed', () => {
    expect(readPkpass(pkpass({ corruptDigest: true })).integrity.digestsMatch).toBe(false)
  })

  it('names the file whose digest is wrong', () => {
    expect(readPkpass(pkpass({ corruptDigest: true })).integrity.filesWithWrongDigest).toContain(
      'pass.json',
    )
  })

  it('notices when the signature file is missing', () => {
    expect(readPkpass(pkpass({ omitSignature: true })).integrity.signaturePresent).toBe(false)
  })

  it('never claims the signature was verified, since Apple’s chain is not checked', () => {
    // Deliberate: verifying the PKCS#7 signature needs Apple's WWDR certificate, and saying
    // a pass is authentic without doing that would be worse than reporting it unverified.
    expect(readPkpass(pkpass()).integrity.signatureVerified).toBe(false)
  })
})

describe('proposing tickets from a pass', () => {
  it('proposes one ticket per barcode', async () => {
    const proposal = await propose(pkpass())

    expect(proposal.tickets).toHaveLength(1)
  })

  it('suggests importing a pass whose digests match', async () => {
    const proposal = await propose(pkpass())

    expect(includedTickets(proposal)).toHaveLength(1)
  })

  it('warns that the signature is unverified', async () => {
    const proposal = await propose(pkpass())

    expect(
      proposal.warnings.some((warning) => warning.code === 'PKPASS_SIGNATURE_UNVERIFIED'),
    ).toBe(true)
  })

  it('warns when a digest does not match', async () => {
    const proposal = await propose(pkpass({ corruptDigest: true }))

    expect(proposal.warnings.some((warning) => warning.code === 'PKPASS_DIGEST_MISMATCH')).toBe(
      true,
    )
  })

  it('leaves an altered pass out of the suggested import', async () => {
    const proposal = await propose(pkpass({ corruptDigest: true }))

    expect(includedTickets(proposal)).toEqual([])
  })

  it('uses the event name as the ticket label', async () => {
    const proposal = await propose(pkpass({ eventName: 'Festival do Norte 2026' }))

    expect(proposal.tickets[0]?.suggestedLabel).toBe('Festival do Norte 2026')
  })

  it('proposes nothing importable when a pass carries no barcode', async () => {
    const proposal = await propose(pkpass({ barcodes: [] }))

    expect(includedTickets(proposal)).toEqual([])
  })

  it('still reports the pass so the user knows why nothing was imported', async () => {
    const proposal = await propose(pkpass({ barcodes: [] }))

    expect(proposal.warnings.some((warning) => warning.code === 'PKPASS_NO_BARCODE')).toBe(true)
  })

  it('keeps the whole pass as the ticket document, so it can be rendered later', async () => {
    const pass = pkpass()

    const proposal = await propose(pass)

    expect(proposal.tickets[0]?.document.mediaType).toBe('application/vnd.apple.pkpass')
  })
})
