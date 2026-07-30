import { describe, expect, it } from 'vitest'
import { countPages, splitPages } from '@passvault/ingest'
import { detectMediaType } from '@passvault/ingest'
import { ticketPdf } from './fixtures.js'

const threePages = () =>
  ticketPdf([
    { codes: [{ text: '8412-AAAA-0001' }] },
    { codes: [{ text: '8412-AAAA-0002' }] },
    { codes: [{ text: '8412-AAAA-0003' }] },
  ])

describe('reading a multi-page PDF', () => {
  it('counts its pages', async () => {
    expect(await countPages(await threePages())).toBe(3)
  })
})

describe('splitting a PDF', () => {
  it('produces one document per page', async () => {
    expect(await splitPages(await threePages())).toHaveLength(3)
  })

  it('numbers pages from one, as a viewer does', async () => {
    const pages = await splitPages(await threePages())

    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3])
  })

  it('produces documents that are themselves valid PDFs', async () => {
    const pages = await splitPages(await threePages())

    for (const page of pages) {
      expect(detectMediaType(page.bytes)).toBe('application/pdf')
    }
  })

  it('produces single-page documents', async () => {
    const pages = await splitPages(await threePages())

    for (const page of pages) {
      expect(await countPages(page.bytes)).toBe(1)
    }
  })

  it('handles a one-page document', async () => {
    const single = await ticketPdf([{ codes: [{ text: 'only' }] }])

    expect(await splitPages(single)).toHaveLength(1)
  })
})

describe('a PDF that cannot be read', () => {
  it('reports a damaged file rather than producing blank pages', async () => {
    const truncated = (await threePages()).slice(0, 200)

    await expect(countPages(truncated)).rejects.toThrowError(
      expect.objectContaining({ code: 'DAMAGED_FILE' }),
    )
  })
})
