import { v7 as uuidv7 } from 'uuid'
import type { BarcodeFormat, DocumentMediaType } from '@passvault/tkpak'
import { decodeBarcodes } from './barcode.js'
import { detectMediaType } from './detect.js'
import { IngestError } from './errors.js'
import { INGEST_LIMITS, assertFileSize } from './limits.js'
import { splitPages } from './pdf.js'
import { readPkpass } from './pkpass.js'
import type { PageRasterizer } from './rasterizer.js'

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

      if (found.length > 1) {
        warnings.push({
          code: 'MULTIPLE_BARCODES',
          pageNumber: page.pageNumber,
          detail: { count: found.length },
        })
      }

      for (const [index, barcode] of found.entries()) {
        const ticketWarnings: ProposalWarning[] =
          found.length > 1
            ? [
                {
                  code: 'MULTIPLE_BARCODES',
                  pageNumber: page.pageNumber,
                  detail: { count: found.length },
                },
              ]
            : []
        tickets.push({
          id: uuidv7(),
          suggestedLabel: labelFor(
            options,
            page.pageNumber,
            found.length > 1 ? index + 1 : undefined,
          ),
          barcode: { format: barcode.format, value: barcode.value },
          pageNumber: page.pageNumber,
          document: { mediaType: 'application/pdf', bytes: page.bytes },
          include: true,
          warnings: ticketWarnings,
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
    for (const [index, barcode] of found.entries()) {
      tickets.push({
        id: uuidv7(),
        suggestedLabel: labelFor(options, 1, found.length > 1 ? index + 1 : undefined),
        barcode: { format: barcode.format, value: barcode.value },
        pageNumber: 1,
        document: { mediaType, bytes },
        include: true,
        warnings: [],
      })
    }
    if (found.length > 1) {
      warnings.push({
        code: 'MULTIPLE_BARCODES',
        pageNumber: 1,
        detail: { count: found.length },
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
 * Flags barcodes that appear more than once.
 *
 * A repeated barcode almost always means a summary or cover page carrying the same code as
 * a real ticket. Importing both would produce two tickets that are the same seat, and the
 * duplicate would be discovered at the turnstile.
 */
function flagDuplicates(tickets: ProposedTicket[], warnings: ProposalWarning[]): void {
  const seen = new Map<string, number>()
  for (const ticket of tickets) {
    if (!ticket.barcode) {
      continue
    }
    const previous = seen.get(ticket.barcode.value)
    if (previous === undefined) {
      seen.set(ticket.barcode.value, ticket.pageNumber ?? 1)
      continue
    }
    const warning: ProposalWarning = {
      code: 'DUPLICATE_BARCODE',
      ...(ticket.pageNumber === undefined ? {} : { pageNumber: ticket.pageNumber }),
      detail: { firstSeenOnPage: previous },
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
