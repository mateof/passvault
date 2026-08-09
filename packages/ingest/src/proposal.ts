import { v7 as uuidv7 } from 'uuid'
import type { BarcodeFormat, DocumentMediaType } from '@passvault/tkpak'
import { decodeBarcodes, type DecodedBarcode } from './barcode.js'
import { detectMediaType } from './detect.js'
import { IngestError } from './errors.js'
import { imageSize } from './image.js'
import { INGEST_LIMITS, assertFileSize } from './limits.js'
import { splitPages } from './pdf.js'
import { readPkpass } from './pkpass.js'
import type { PageRasterizer, RasterizedDocument } from './rasterizer.js'
import { cutIntoRegions, normalizeBox } from './sheet.js'

/**
 * Ingestion produces a proposal, never a saved result.
 *
 * Splitting a PDF one ticket per page is right most of the time and wrong often enough to
 * matter: vendors put two passes on a sheet, lead with a page of instructions, or repeat a
 * summary page carrying the same barcode as one of the tickets. A process that applied its
 * guess silently would create phantom tickets that someone then has to notice and delete.
 *
 * So this reports what it found, flags what looks off, suggests which pages are tickets,
 * and leaves the decision to the person who can see the actual document.
 */

export type ProposalWarningCode =
  | 'NO_BARCODE'
  | 'MULTIPLE_BARCODES'
  | 'TOO_MANY_BARCODES'
  | 'SHARED_PAGE'
  | 'SAME_CODE_ON_SHEET'
  | 'DUPLICATE_BARCODE'
  | 'PKPASS_DIGEST_MISMATCH'
  | 'PKPASS_SIGNATURE_UNVERIFIED'
  | 'PKPASS_NO_BARCODE'

export interface ProposalWarning {
  code: ProposalWarningCode
  pageNumber?: number
  detail?: Record<string, string | number>
}

export interface ProposedTicket {
  /** Provisional identifier, so the interface can track a row the user is editing. */
  id: string
  suggestedLabel: string
  barcode?: { format: BarcodeFormat; value: string }
  pageNumber?: number
  document: { mediaType: DocumentMediaType; bytes: Uint8Array }
  /** What this proposal suggests. The user can flip it. */
  include: boolean
  warnings: ProposalWarning[]
}

export interface IngestProposal {
  mediaType: DocumentMediaType
  pageCount: number
  tickets: ProposedTicket[]
  warnings: ProposalWarning[]
  /** Always true. Present so no caller can mistake a proposal for a finished import. */
  requiresReview: true
}

export interface ProposeOptions {
  /** Needed for PDFs. Injected so tests and the Android app can supply their own. */
  rasterizer?: PageRasterizer
  /** Label prefix, usually the event name once the user has typed one. */
  labelPrefix?: string
}

export async function propose(
  bytes: Uint8Array,
  options: ProposeOptions = {},
): Promise<IngestProposal> {
  assertFileSize(bytes.byteLength)
  const mediaType = detectMediaType(bytes)
  switch (mediaType) {
    case 'application/pdf':
      return proposeFromPdf(bytes, options)
    case 'image/png':
    case 'image/jpeg':
      return proposeFromImage(bytes, mediaType, options)
    case 'application/vnd.apple.pkpass':
      return proposeFromPkpass(bytes, options)
  }
}

async function proposeFromPdf(bytes: Uint8Array, options: ProposeOptions): Promise<IngestProposal> {
  const rasterizer = options.rasterizer
  if (!rasterizer) {
    throw new IngestError(
      'RASTERIZER_UNAVAILABLE',
      'reading barcodes from a PDF needs a page rasterizer; pass one in options.rasterizer',
    )
  }

  // Split before opening the rasterizer: the split needs the original bytes intact, and a
  // rasterizer is entitled to take ownership of what it is given.
  const pages = await splitPages(bytes)
  const tickets: ProposedTicket[] = []
  const warnings: ProposalWarning[] = []

  const rendered = await rasterizer.open(bytes)
  try {
    for (const page of pages) {
      const image = await rendered.renderPage(page.pageNumber, INGEST_LIMITS.renderWidth)
      const found = await decodeBarcodes(image)

      if (found.length === 0) {
        // Kept as a proposed ticket, excluded by default: an instructions page should not be
        // imported, but a page whose barcode simply failed to decode should not vanish either
        // — the user can see the page and decide.
        const warning: ProposalWarning = {
          code: 'NO_BARCODE',
          pageNumber: page.pageNumber,
        }
        warnings.push(warning)
        tickets.push({
          id: uuidv7(),
          suggestedLabel: labelFor(options, page.pageNumber),
          pageNumber: page.pageNumber,
          document: { mediaType: 'application/pdf', bytes: page.bytes },
          include: false,
          warnings: [warning],
        })
        continue
      }

      // The decoder is asked for one symbol over the limit precisely so this case can be
      // told apart from a page that merely reaches it. Dropping the surplus quietly would
      // present a short proposal as a complete one, and the missing seats would only turn
      // up when somebody was refused at the door.
      const kept = found.slice(0, INGEST_LIMITS.barcodesPerPage)
      const pageWarnings: ProposalWarning[] = []
      if (found.length > kept.length) {
        pageWarnings.push({
          code: 'TOO_MANY_BARCODES',
          pageNumber: page.pageNumber,
          detail: { limit: INGEST_LIMITS.barcodesPerPage },
        })
      }
      if (kept.length > 1) {
        pageWarnings.push({
          code: 'MULTIPLE_BARCODES',
          pageNumber: page.pageNumber,
          detail: { count: kept.length },
        })
      }

      const crops = await cropsFor(rendered, page.pageNumber, kept, image)
      if (kept.length > 1 && !crops) {
        pageWarnings.push({ code: 'SHARED_PAGE', pageNumber: page.pageNumber })
      }
      warnings.push(...pageWarnings)

      for (const [index, barcode] of kept.entries()) {
        tickets.push({
          id: uuidv7(),
          suggestedLabel: labelFor(
            options,
            page.pageNumber,
            kept.length > 1 ? index + 1 : undefined,
          ),
          barcode: { format: barcode.format, value: barcode.value },
          pageNumber: page.pageNumber,
          document: crops?.[index] ?? { mediaType: 'application/pdf', bytes: page.bytes },
          include: true,
          // A copy per ticket, because `flagDuplicates` appends to these.
          warnings: [...pageWarnings],
        })
      }
    }
  } finally {
    await rendered.close()
  }

  flagDuplicates(tickets, warnings)

  return {
    mediaType: 'application/pdf',
    pageCount: pages.length,
    tickets,
    warnings,
    requiresReview: true,
  }
}

/**
 * One image per barcode, when the sheet can be cut so that no ticket carries another's code.
 *
 * Rasterised rather than clipped. A PDF crop box, or a form XObject with a tight bounding
 * box, hides the neighbouring pass without removing it: the drawing commands stay in the
 * file and anybody who opens it with the right tool has the other seat's code. Rendering the
 * region drops it from the bytes. The cost is that the page's text stops being selectable,
 * which for a ticket that exists to be shown at a turnstile is the right way round.
 *
 * `undefined` means the page could not be divided — no straight cut separates the codes, or
 * this rasterizer cannot clip — and the caller falls back to the whole sheet with a warning.
 */
async function cropsFor(
  rendered: RasterizedDocument,
  pageNumber: number,
  found: DecodedBarcode[],
  image: Uint8Array,
): Promise<{ mediaType: DocumentMediaType; bytes: Uint8Array }[] | undefined> {
  const renderRegion = rendered.renderRegion
  if (found.length < 2 || !renderRegion) {
    return undefined
  }
  // Barcode positions are in pixels of the render they were read from, and the cut works in
  // fractions of the page, so the size of that render is the missing term.
  const size = imageSize(image)
  if (!size) {
    return undefined
  }
  // Optional, and cheap to do without: it only decides where inside the gap the line goes.
  const ink = await rendered.inkMap?.(pageNumber).catch(() => undefined)
  const regions = cutIntoRegions(
    found.map((barcode) => normalizeBox(barcode.box, size)),
    ink,
  )
  if (!regions) {
    return undefined
  }

  const documents: { mediaType: DocumentMediaType; bytes: Uint8Array }[] = []
  for (const region of regions) {
    try {
      documents.push({
        mediaType: 'image/png',
        bytes: await renderRegion(pageNumber, region),
      })
    } catch {
      // A rasterizer that offers the method and then fails on a region is no more use than
      // one that never had it. Half a set of crops is worse than none, so the whole page
      // goes back to being the document and the warning explains what that means.
      return undefined
    }
  }
  return documents
}

async function proposeFromImage(
  bytes: Uint8Array,
  mediaType: 'image/png' | 'image/jpeg',
  options: ProposeOptions,
): Promise<IngestProposal> {
  const found = await decodeBarcodes(bytes)
  const warnings: ProposalWarning[] = []
  const tickets: ProposedTicket[] = []

  if (found.length === 0) {
    const warning: ProposalWarning = { code: 'NO_BARCODE', pageNumber: 1 }
    warnings.push(warning)
    tickets.push({
      id: uuidv7(),
      suggestedLabel: labelFor(options, 1),
      pageNumber: 1,
      document: { mediaType, bytes },
      // Unlike a PDF page, an image the user deliberately picked is probably a ticket even
      // if the barcode did not decode — a photograph at an angle, say — so it stays
      // included and the warning explains what is missing.
      include: true,
      warnings: [warning],
    })
  } else {
    const kept = found.slice(0, INGEST_LIMITS.barcodesPerPage)
    const shared: ProposalWarning[] = []
    if (found.length > kept.length) {
      shared.push({
        code: 'TOO_MANY_BARCODES',
        pageNumber: 1,
        detail: { limit: INGEST_LIMITS.barcodesPerPage },
      })
    }
    if (kept.length > 1) {
      shared.push({ code: 'MULTIPLE_BARCODES', pageNumber: 1, detail: { count: kept.length } })
      // Unlike a PDF page there is nothing to re-render a region from: the document *is* the
      // file the user chose. So every ticket carries every code on it, and saying so is the
      // most this path can do.
      shared.push({ code: 'SHARED_PAGE', pageNumber: 1 })
    }
    warnings.push(...shared)

    for (const [index, barcode] of kept.entries()) {
      tickets.push({
        id: uuidv7(),
        suggestedLabel: labelFor(options, 1, kept.length > 1 ? index + 1 : undefined),
        barcode: { format: barcode.format, value: barcode.value },
        pageNumber: 1,
        document: { mediaType, bytes },
        include: true,
        warnings: [...shared],
      })
    }
  }

  flagDuplicates(tickets, warnings)
  return { mediaType, pageCount: 1, tickets, warnings, requiresReview: true }
}

function proposeFromPkpass(bytes: Uint8Array, options: ProposeOptions): IngestProposal {
  const contents = readPkpass(bytes)
  const warnings: ProposalWarning[] = []

  if (!contents.integrity.digestsMatch) {
    warnings.push({
      code: 'PKPASS_DIGEST_MISMATCH',
      detail: { files: contents.integrity.filesWithWrongDigest.join(', ') },
    })
  }
  if (!contents.integrity.signatureVerified) {
    warnings.push({
      code: 'PKPASS_SIGNATURE_UNVERIFIED',
      detail: { signaturePresent: String(contents.integrity.signaturePresent) },
    })
  }
  if (contents.barcodes.length === 0) {
    warnings.push({ code: 'PKPASS_NO_BARCODE' })
  }

  const label = contents.eventName ?? options.labelPrefix ?? contents.description ?? 'Pass'
  const tickets: ProposedTicket[] = contents.barcodes.map((barcode, index) => ({
    id: uuidv7(),
    suggestedLabel: contents.barcodes.length > 1 ? `${label} ${index + 1}` : label,
    barcode: { format: barcode.format, value: barcode.value },
    document: { mediaType: 'application/vnd.apple.pkpass', bytes },
    // A pass whose digests do not match was edited after signing. Excluded by default so
    // importing it is a deliberate choice.
    include: contents.integrity.digestsMatch,
    warnings: warnings.filter((warning) => warning.code !== 'PKPASS_NO_BARCODE'),
  }))

  if (tickets.length === 0) {
    tickets.push({
      id: uuidv7(),
      suggestedLabel: label,
      document: { mediaType: 'application/vnd.apple.pkpass', bytes },
      include: false,
      warnings: [{ code: 'PKPASS_NO_BARCODE' }],
    })
  }

  return {
    mediaType: 'application/vnd.apple.pkpass',
    pageCount: 1,
    tickets,
    warnings,
    requiresReview: true,
  }
}

/**
 * Flags barcodes that appear more than once, which means two different things.
 *
 * **On another page** it almost always means a summary or cover sheet carrying the same code
 * as a real ticket. Importing both would produce two tickets that are the same seat, and the
 * duplicate would be discovered at the turnstile. That one is unticked.
 *
 * **On the same page** it means nothing of the sort. Some sellers — infoticketing and
 * sacatuentrada among them — print one code for the whole order and repeat it on every pass
 * on the sheet; what tells the passes apart is the reference and the ticket type, not the
 * code. Unticking there threw away a real ticket, and it protected nothing: the code handed
 * out is identical either way, so keeping one row instead of two prevents no double entry
 * and only loses the second pass's type, price and reference. Both rows stay ticked, and the
 * warning says what to look at.
 *
 * Which of the two it is cannot be decided from the code alone, and this is the screen whose
 * entire purpose is that somebody who can see the document decides.
 */
function flagDuplicates(tickets: ProposedTicket[], warnings: ProposalWarning[]): void {
  const seen = new Map<string, ProposedTicket>()
  for (const ticket of tickets) {
    if (!ticket.barcode) {
      continue
    }
    const first = seen.get(ticket.barcode.value)
    if (!first) {
      seen.set(ticket.barcode.value, ticket)
      continue
    }

    if ((first.pageNumber ?? 1) === (ticket.pageNumber ?? 1)) {
      const warning: ProposalWarning = {
        code: 'SAME_CODE_ON_SHEET',
        ...(ticket.pageNumber === undefined ? {} : { pageNumber: ticket.pageNumber }),
      }
      warnings.push(warning)
      ticket.warnings.push(warning)
      // On the first one too. It is a property of the pair, and a warning on only the second
      // row reads as if the second row were the problem.
      if (!first.warnings.some((existing) => existing.code === 'SAME_CODE_ON_SHEET')) {
        first.warnings.push(warning)
      }
      continue
    }

    const warning: ProposalWarning = {
      code: 'DUPLICATE_BARCODE',
      ...(ticket.pageNumber === undefined ? {} : { pageNumber: ticket.pageNumber }),
      detail: { firstSeenOnPage: first.pageNumber ?? 1 },
    }
    warnings.push(warning)
    ticket.warnings.push(warning)
    ticket.include = false
  }
}

function labelFor(options: ProposeOptions, pageNumber: number, ordinal?: number): string {
  const prefix = options.labelPrefix ? `${options.labelPrefix} ` : ''
  const suffix = ordinal === undefined ? '' : `.${ordinal}`
  return `${prefix}${pageNumber}${suffix}`.trim()
}

/** The tickets the user has not excluded. What a confirmation step actually saves. */
export function includedTickets(proposal: IngestProposal): ProposedTicket[] {
  return proposal.tickets.filter((ticket) => ticket.include)
}
