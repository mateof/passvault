import { beforeAll, describe, expect, it } from 'vitest'
import {
  INGEST_LIMITS,
  countPages,
  createPdfJsRasterizer,
  decodeBarcodes,
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

  it('records that both came off the same page', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets[0]?.pageNumber).toBe(proposal.tickets[1]?.pageNumber)
  })

  it('cuts the sheet, so no ticket carries the other seat’s code', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    for (const ticket of proposal.tickets) {
      const onDocument = await decodeBarcodes(ticket.document.bytes)

      expect(onDocument.map((code) => code.value)).toEqual([ticket.barcode?.value])
    }
  })

  it('hands over the cut region as an image, since a crop box would only hide the rest', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets.map((ticket) => ticket.document.mediaType)).toEqual([
      'image/png',
      'image/png',
    ])
  })

  it('does not warn that the page is shared, because it was divided', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.some((warning) => warning.code === 'SHARED_PAGE')).toBe(false)
  })
})

describe('a sheet with the passes stacked rather than side by side', () => {
  const pdf = () =>
    ticketPdf([{ columns: 1, codes: [{ text: '8412-STACK-0001' }, { text: '8412-STACK-0002' }] }])

  it('cuts across the sheet instead of down it', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    for (const ticket of proposal.tickets) {
      const onDocument = await decodeBarcodes(ticket.document.bytes)

      expect(onDocument.map((code) => code.value)).toEqual([ticket.barcode?.value])
    }
  })
})

describe('a sheet of four passes printed two by two', () => {
  const pdf = () =>
    ticketPdf([
      {
        columns: 2,
        codes: [
          { text: '8412-GRID-0001' },
          { text: '8412-GRID-0002' },
          { text: '8412-GRID-0003' },
          { text: '8412-GRID-0004' },
        ],
      },
    ])

  it('proposes four tickets', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets).toHaveLength(4)
  })

  it('separates a grid, which one cut across the page cannot do', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    for (const ticket of proposal.tickets) {
      const onDocument = await decodeBarcodes(ticket.document.bytes)

      expect(onDocument.map((code) => code.value)).toEqual([ticket.barcode?.value])
    }
  })
})

describe('a page carrying more codes than the limit allows', () => {
  // Thirty on one sheet, against a limit of twenty-four. Before, the surplus was dropped and
  // the proposal looked complete, so the missing seats were discovered at the turnstile.
  const pdf = () =>
    ticketPdf([
      {
        columns: 6,
        codes: Array.from({ length: 30 }, (_, index) => ({
          text: `8412-MANY-${String(index + 1).padStart(4, '0')}`,
        })),
      },
    ])

  it('says the page held more than it could take', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.some((warning) => warning.code === 'TOO_MANY_BARCODES')).toBe(true)
  })

  it('reports the limit it stopped at', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(
      proposal.warnings.find((warning) => warning.code === 'TOO_MANY_BARCODES')?.detail?.limit,
    ).toBe(INGEST_LIMITS.barcodesPerPage)
  })

  it('proposes exactly the limit, not one more', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets).toHaveLength(INGEST_LIMITS.barcodesPerPage)
  })

  it('puts the warning on the tickets too, where the user is looking', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(
      proposal.tickets.every((ticket) =>
        ticket.warnings.some((warning) => warning.code === 'TOO_MANY_BARCODES'),
      ),
    ).toBe(true)
  })
}, 120_000)

describe('a sheet whose codes cannot be separated', () => {
  it('keeps the whole page and says each ticket carries the others', async () => {
    const pdf = await ticketPdf([
      { codes: [{ text: '8412-TIGHT-0001' }, { text: '8412-TIGHT-0002' }] },
    ])
    // A rasterizer with no `renderRegion` is the case an older client presents, and it is the
    // same outcome as a layout no straight cut divides.
    const cannotCrop: PageRasterizer = {
      open: async (bytes) => {
        const document = await rasterizer.open(bytes)
        return {
          pageCount: document.pageCount,
          renderPage: document.renderPage,
          close: document.close,
        }
      },
    }

    const proposal = await propose(pdf, { rasterizer: cannotCrop })

    expect(proposal.warnings.some((warning) => warning.code === 'SHARED_PAGE')).toBe(true)
    expect(proposal.tickets.map((ticket) => ticket.document.mediaType)).toEqual([
      'application/pdf',
      'application/pdf',
    ])
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

describe('a sheet whose passes all carry the same code', () => {
  // What infoticketing and sacatuentrada print: one code for the whole order, repeated on
  // every pass. The passes are different tickets — different type, price and reference — and
  // unticking the second one threw a real ticket away.
  const pdf = () =>
    ticketPdf([
      {
        columns: 1,
        codes: [{ text: '8412-ORDER-0001' }, { text: '8412-ORDER-0001' }],
      },
    ])

  it('keeps both, because the repeat is the seller’s layout and not a summary page', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(includedTickets(proposal)).toHaveLength(2)
  })

  it('does not call it a duplicate, which would mean the same seat twice', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.warnings.some((warning) => warning.code === 'DUPLICATE_BARCODE')).toBe(false)
  })

  it('warns on both rows, since it is a property of the pair', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(
      proposal.tickets.every((ticket) =>
        ticket.warnings.some((warning) => warning.code === 'SAME_CODE_ON_SHEET'),
      ),
    ).toBe(true)
  })

  it('still cuts the sheet in two', async () => {
    const proposal = await propose(await pdf(), { rasterizer })

    expect(proposal.tickets.map((ticket) => ticket.document.mediaType)).toEqual([
      'image/png',
      'image/png',
    ])
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
