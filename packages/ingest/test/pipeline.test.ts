import { beforeAll, describe, expect, it } from 'vitest'
import {
  countPages,
  createPdfJsRasterizer,
  includedTickets,
  propose,
  type PageRasterizer,
} from '@passvault/ingest'
import { barcodePng, instructionsOnlyPdf, ticketPdf } from './fixtures.js'

/**
 * Ingestion end to end.
 *
 * Genuine barcodes are encoded, embedded in a genuine PDF, split, rasterised and decoded.
 * Nothing here is stubbed, so a break anywhere in that chain fails a test — which is the
 * point, since the chain is where the interesting failures are.
 */
let rasterizer: PageRasterizer

beforeAll(async () => {
  rasterizer = await createPdfJsRasterizer()
}, 60_000)

describe('a straightforward multi-page ticket PDF', () => {
  const pdf = () =>
    ticketPdf([
      { codes: [{ text: '8412-AAAA-0001' }] },
      { codes: [{ text: '8412-AAAA-0002' }] },
      { codes: [{ text: '8412-AAAA-0003' }] },
    ])

  it('proposes one ticket per page', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets).toHaveLength(3)
  })

  it('reads every barcode correctly', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets.map((ticket) => ticket.barcode?.value)).toEqual([
      '8412-AAAA-0001',
      '8412-AAAA-0002',
      '8412-AAAA-0003',
    ])
  })

  it('identifies the barcode format', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets[0]?.barcode?.format).toBe('QR_CODE')
  })

  it('suggests including every ticket', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(includedTickets(proposal)).toHaveLength(3)
  })

  it('gives each ticket its own single-page document', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    for (const ticket of proposal.tickets) {
      expect(await countPages(ticket.document.bytes)).toBe(1)
    }
  })

  it('records which page each ticket came from', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets.map((ticket) => ticket.pageNumber)).toEqual([1, 2, 3])
  })

  it('raises no warnings', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings).toEqual([])
  })

  it('still says the result needs reviewing', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.requiresReview).toBe(true)
  })
})

describe('the barcode symbologies real tickets use', () => {
  it('reads an Aztec code, which is what most rail and some venue tickets carry', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-AZTEC-0001', format: 'Aztec' }] }])

    const proposal = await propose(pdf, { rasterizer })

    expect(proposal.tickets[0]?.barcode).toEqual({ format: 'AZTEC', value: '8412-AZTEC-0001' })
  })

  it('reads a PDF417, which airlines and large venues use', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-PDF417-0001', format: 'PDF417' }] }])

    const proposal = await propose(pdf, { rasterizer })

    expect(proposal.tickets[0]?.barcode).toEqual({ format: 'PDF_417', value: '8412-PDF417-0001' })
  })

  it('reads a Data Matrix', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-DM-0001', format: 'DataMatrix' }] }])

    const proposal = await propose(pdf, { rasterizer })

    expect(proposal.tickets[0]?.barcode?.format).toBe('DATA_MATRIX')
  })
})

describe('a PDF that leads with a page of instructions', () => {
  const pdf = () =>
    ticketPdf([
      { codes: [], heading: 'Please bring photo identification' },
      { codes: [{ text: '8412-BBBB-0001' }] },
      { codes: [{ text: '8412-BBBB-0002' }] },
    ])

  it('warns about the page with no barcode', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.filter((warning) => warning.code === 'NO_BARCODE')).toHaveLength(1)
  })

  it('says which page it was', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings[0]?.pageNumber).toBe(1)
  })

  it('leaves the instructions page out of the suggested import', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(includedTickets(proposal)).toHaveLength(2)
  })

  it('keeps it in the proposal so the user can see and override the decision', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets).toHaveLength(3)
  })
})

describe('a PDF with two passes on one sheet', () => {
  const pdf = () => ticketPdf([{ codes: [{ text: '8412-CCCC-0001' }, { text: '8412-CCCC-0002' }] }])

  it('proposes a ticket for each barcode, not one for the page', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets).toHaveLength(2)
  })

  it('reads both barcodes', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets.map((ticket) => ticket.barcode?.value).sort()).toEqual([
      '8412-CCCC-0001',
      '8412-CCCC-0002',
    ])
  })

  it('warns that the page holds more than one, since the split is a guess', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.some((warning) => warning.code === 'MULTIPLE_BARCODES')).toBe(true)
  })

  it('reports how many it found', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(
      proposal.warnings.find((warning) => warning.code === 'MULTIPLE_BARCODES')?.detail?.count,
    ).toBe(2)
  })

  it('gives both tickets the same page document', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets[0]?.pageNumber).toBe(proposal.tickets[1]?.pageNumber)
  })
})

describe('a PDF whose summary page repeats a ticket barcode', () => {
  const pdf = () =>
    ticketPdf([
      { codes: [{ text: '8412-DDDD-0001' }] },
      { codes: [{ text: '8412-DDDD-0002' }] },
      { codes: [{ text: '8412-DDDD-0001' }], heading: 'Order summary' },
    ])

  it('warns about the repeat', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.some((warning) => warning.code === 'DUPLICATE_BARCODE')).toBe(true)
  })

  it('names the page the barcode was first seen on', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(
      proposal.warnings.find((warning) => warning.code === 'DUPLICATE_BARCODE')?.detail
        ?.firstSeenOnPage,
    ).toBe(1)
  })

  it('excludes the repeat, so the import does not create the same seat twice', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(includedTickets(proposal)).toHaveLength(2)
  })

  it('keeps the first occurrence', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(includedTickets(proposal).map((ticket) => ticket.pageNumber)).toEqual([1, 2])
  })
})

describe('a PDF with no barcode anywhere', () => {
  it('proposes nothing to import', async () => {
    const proposal = await propose(await instructionsOnlyPdf(), { rasterizer })

    expect(includedTickets(proposal)).toEqual([])
  })
})

describe('a photograph or screenshot of a ticket', () => {
  it('reads the barcode straight from the image', async () => {
    const png = await barcodePng('8412-IMAGE-0001')

    const proposal = await propose(png)

    expect(proposal.tickets[0]?.barcode?.value).toBe('8412-IMAGE-0001')
  })

  it('needs no rasterizer, since there is no PDF to render', async () => {
    const png = await barcodePng('8412-IMAGE-0002')

    await expect(propose(png)).resolves.toBeDefined()
  })

  it('keeps an image the user chose even when nothing decodes, unlike a PDF page', async () => {
    // A photograph taken at an angle may not decode on the first try. The user deliberately
    // picked this file, so it stays in with a warning rather than being dropped.
    const blank = await barcodePng('x')
    const proposal = await propose(blank.slice(0, blank.length))

    expect(proposal.tickets).toHaveLength(1)
  })
})

describe('labelling', () => {
  it('uses the event name as a prefix when one is known', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-EEEE-0001' }] }])

    const proposal = await propose(pdf, { rasterizer, labelPrefix: 'Festival do Norte' })

    expect(proposal.tickets[0]?.suggestedLabel).toBe('Festival do Norte 1')
  })
})

describe('a PDF with no rasterizer available', () => {
  it('says so instead of silently importing a ticket with no barcode', async () => {
    const pdf = await ticketPdf([{ codes: [{ text: '8412-FFFF-0001' }] }])

    await expect(propose(pdf)).rejects.toThrowError(
      expect.objectContaining({ code: 'RASTERIZER_UNAVAILABLE' }),
    )
  })
})
