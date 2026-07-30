import { PDFDocument } from 'pdf-lib'
import { IngestError } from './errors.js'
import { assertPageCount } from './limits.js'

export interface SplitPage {
  /** 1-based, matching what the user sees in a viewer. */
  pageNumber: number
  /** A single-page PDF holding just this page, which is what a ticket ends up being. */
  bytes: Uint8Array
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // ignoreEncryption: false so a protected file is reported as such instead of producing
    // blank pages, which is what a silent failure looks like to the user.
    return await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/encrypt/i.test(message)) {
      throw new IngestError('ENCRYPTED_PDF', 'PDF is password protected', { cause })
    }
    throw new IngestError('DAMAGED_FILE', `PDF could not be read: ${message}`, { cause })
  }
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  const pages = (await load(bytes)).getPageCount()
  assertPageCount(pages)
  return pages
}

/**
 * Splits a document into one PDF per page.
 *
 * One page per ticket is the common case, not the rule: some vendors put two passes on a
 * sheet and others lead with a page of instructions. So this produces pages, and deciding
 * which pages are tickets is left to the proposal the user reviews.
 */
export async function splitPages(bytes: Uint8Array): Promise<SplitPage[]> {
  const source = await load(bytes)
  const pageCount = source.getPageCount()
  assertPageCount(pageCount)

  const pages: SplitPage[] = []
  for (let index = 0; index < pageCount; index += 1) {
    const single = await PDFDocument.create()
    const [copied] = await single.copyPages(source, [index])
    if (!copied) {
      throw new IngestError('DAMAGED_FILE', `page ${index + 1} could not be copied`)
    }
    single.addPage(copied)
    pages.push({ pageNumber: index + 1, bytes: await single.save({ useObjectStreams: false }) })
  }
  return pages
}

export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    await load(bytes)
    return false
  } catch (error) {
    if (error instanceof IngestError && error.code === 'ENCRYPTED_PDF') {
      return true
    }
    throw error
  }
}
