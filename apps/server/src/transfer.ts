import { hkdf, publicKeyFromPrivate } from '@passvault/crypto'
import { newId, toInstant } from '@passvault/db'
import {
  applyPaymentVisibility,
  inspectTkpak,
  openWithPassword,
  writeTkpak,
  type DocumentMediaType,
  type TkpakBundle,
  type TkpakDocument,
  type TkpakTicket,
} from '@passvault/tkpak'
import { badRequest, forbidden, notFound } from './errors.js'
import { findEvent, hasAccess, listEventDocuments, type EventDeps } from './events.js'
import { readBlob, storeBlob } from './blobs.js'
import * as repo from './repository.js'
import { addTickets, projectTickets } from './tickets.js'

/**
 * Exporting and importing `.tkpak` files through the API.
 *
 * The point of the format is that it needs no server, so this endpoint is a convenience rather
 * than the primary path: it lets somebody using the web interface hand a friend a file, and it
 * lets a phone that happens to be online push what it has. The Android app does the same thing
 * with no server involved at all.
 */
export interface TransferDeps extends EventDeps {
  blobDir: string
}

/**
 * The installation's signing identity.
 *
 * Derived from the master key rather than stored, so there is one less secret to back up and no
 * migration to add. Rotating the master key changes the identity, which is correct: a recipient
 * verifying a signature against a remembered key should notice that the server was re-keyed.
 */
export function serverSigningKey(deps: TransferDeps): Uint8Array {
  return hkdf(
    deps.crypto.masterKey,
    new Uint8Array(Buffer.from('passvault-server', 'utf8')),
    'passvault/v1/server-signing',
  )
}

export interface ExportInput {
  eventId: string
  viewerUserId: string
  eventKey: Uint8Array
  /** Password the recipient will need. Omitted only when sealing to a known recipient key. */
  password?: string
  recipientPublicKey?: Uint8Array
  ticketIds?: string[]
  includeDocuments?: boolean
  preview?: 'full' | 'minimal' | 'none'
  /** Recipient label, used to decide which payment records they are entitled to. */
  exportedFor?: string
}

export interface ExportResult {
  archive: Uint8Array
  fileId: string
  ticketCount: number
}

export async function exportEvent(deps: TransferDeps, input: ExportInput): Promise<ExportResult> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (!(await hasAccess(deps, input.eventId, input.viewerUserId))) {
    throw forbidden()
  }
  if (!input.password && !input.recipientPublicKey) {
    throw badRequest('event.passwordRequired')
  }

  const isCreator = event.creator_user_id === input.viewerUserId
  // Reuses the same projection the API serves, so an export can never show more than the
  // exporter could already see. Writing a second query here is how the two drift apart.
  const projected = await projectTickets(deps, {
    eventId: input.eventId,
    viewerUserId: input.viewerUserId,
    eventKey: input.eventKey,
  })

  const chosen = input.ticketIds
    ? projected.filter((ticket) => input.ticketIds?.includes(ticket.id))
    : projected
  if (chosen.length === 0) {
    throw badRequest('claim.error.notClaimable')
  }

  const documents: TkpakDocument[] = []
  const tickets: TkpakTicket[] = chosen.map((ticket) => {
    const entry: TkpakTicket = {
      id: ticket.id,
      assignmentMode: ticket.assignmentMode as TkpakTicket['assignmentMode'],
      assignment: {
        state: ticket.assignmentState as TkpakTicket['assignment']['state'],
        ...(ticket.holderLabel ? { holderLabel: ticket.holderLabel } : {}),
        holderUserId: ticket.holderUserId,
      },
    }
    if (ticket.label) entry.label = ticket.label
    if (ticket.section) entry.section = ticket.section
    if (ticket.row) entry.row = ticket.row
    if (ticket.seat) entry.seat = ticket.seat
    if (ticket.barcode) {
      entry.barcode = {
        format: ticket.barcode.format as TkpakTicket['barcode'] extends undefined
          ? never
          : NonNullable<TkpakTicket['barcode']>['format'],
        value: ticket.barcode.value,
      }
    }
    if (ticket.payment) {
      entry.payment = {
        state: ticket.payment.state as NonNullable<TkpakTicket['payment']>['state'],
        visibility: ticket.payment.visibility as NonNullable<TkpakTicket['payment']>['visibility'],
        ...(ticket.payment.amountCents === null ? {} : { amountCents: ticket.payment.amountCents }),
        ...(ticket.payment.currency === null ? {} : { currency: ticket.payment.currency }),
        ...(ticket.payment.settledAt === null ? {} : { settledAt: ticket.payment.settledAt }),
      }
    }
    return entry
  })

  if (input.includeDocuments !== false) {
    const rows = await deps.db.db
      .selectFrom('tickets')
      .select(['id', 'document_blob_id', 'document_page'])
      .where('event_id', '=', input.eventId)
      .where('document_blob_id', 'is not', null)
      .execute()
    for (const row of rows) {
      const ticket = tickets.find((entry) => entry.id === row.id)
      if (!ticket || !row.document_blob_id) {
        continue
      }
      const blob = await readBlob(deps, { blobId: row.document_blob_id, eventKey: input.eventKey })
      documents.push({ id: row.document_blob_id, mediaType: blob.mediaType, bytes: blob.bytes })
      ticket.documentBlobId = row.document_blob_id
      if (row.document_page !== null) {
        ticket.documentPage = row.document_page
      }
    }
  }

  // The file the tickets were split out of, whole, beside the pages. Sending only the pages
  // sends only what ingestion kept — and the pages it drops are the map, the terms and the gate
  // instructions, which is exactly what somebody receiving a ticket for a venue they have never
  // been to needs. Skipped for a partial export: a person receiving one seat is not being sent
  // everybody's document.
  const eventDocumentIds: string[] = []
  if (input.includeDocuments !== false && !input.ticketIds) {
    for (const document of await listEventDocuments(deps, input.eventId)) {
      if (documents.some((held) => held.id === document.id)) {
        continue
      }
      const blob = await readBlob(deps, { blobId: document.id, eventKey: input.eventKey })
      documents.push({ id: document.id, mediaType: blob.mediaType, bytes: blob.bytes })
      eventDocumentIds.push(document.id)
    }
  }

  const projection = projectEventForBundle(deps, event, input.eventKey)
  const bundle: Omit<TkpakBundle, 'fileId'> = {
    exportedAt: toInstant(),
    ...(input.exportedFor ? { exportedFor: input.exportedFor } : {}),
    event: {
      ...projection,
      ...(eventDocumentIds.length > 0 ? { documentIds: eventDocumentIds } : {}),
    },
    tickets,
    operations: [],
  }

  // Filtered a second time against the recipient rather than the exporter. An organiser exporting
  // for Ana must not include Brais's private amount just because the organiser can see it.
  const filtered = applyPaymentVisibility(
    { ...bundle, fileId: 'pending' },
    {
      isCreator: isCreator && !input.exportedFor,
      ...(input.exportedFor ? { holderLabel: input.exportedFor } : {}),
    },
  )

  const signingKey = serverSigningKey(deps)
  const written = await writeTkpak({
    issuer: {
      deviceId: deviceIdFor(deps),
      privateKey: signingKey,
      displayName: 'PassVault server',
    },
    bundle: { ...filtered, tickets: filtered.tickets },
    documents,
    ...(input.password ? { password: input.password } : {}),
    ...(input.recipientPublicKey ? { recipientPublicKey: input.recipientPublicKey } : {}),
    ...(deps.argon2Params ? { argon2Params: deps.argon2Params } : {}),
    preview: input.preview ?? 'full',
  })

  // Recorded on every exported ticket. Not revocation — hygiene, so the exporter can see that a
  // copy is in circulation and does not also present it at the gate.
  for (const ticket of tickets) {
    await deps.db.db
      .updateTable('tickets')
      .set({ exported_at: toInstant(), updated_at: toInstant() })
      .where('id', '=', ticket.id)
      .execute()
  }

  await repo.recordAudit(deps.db, {
    actorUserId: input.viewerUserId,
    action: 'event.exported',
    subjectKind: 'event',
    subjectId: input.eventId,
  })

  return { archive: written.archive, fileId: written.fileId, ticketCount: tickets.length }
}

function projectEventForBundle(
  deps: TransferDeps,
  event: Awaited<ReturnType<typeof findEvent>> & object,
  eventKey: Uint8Array,
): TkpakBundle['event'] {
  const decrypt = (column: string, stored: Uint8Array | null): string | null =>
    stored === null
      ? null
      : deps.crypto.decryptField(eventKey, stored, {
          table: 'events',
          column,
          rowId: event.id,
        })

  const projection: TkpakBundle['event'] = {
    id: event.id,
    name: decrypt('name_cipher', event.name_cipher) ?? '',
    defaultAssignmentMode:
      event.default_assignment_mode as TkpakBundle['event']['defaultAssignmentMode'],
    passwordProtected: event.password_protected === 1,
  }
  const venue = decrypt('venue_cipher', event.venue_cipher)
  const notes = decrypt('notes_cipher', event.notes_cipher)
  if (venue) projection.venue = venue
  if (notes) projection.notes = notes
  if (event.starts_at) projection.startsAt = event.starts_at
  if (event.time_zone) projection.timeZone = event.time_zone
  return projection
}

/** A stable device identifier for this installation, derived so it needs no storage. */
function deviceIdFor(deps: TransferDeps): string {
  const key = serverSigningKey(deps)
  const hex = Buffer.from(publicKeyFromPrivate(key)).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

export interface ImportResult {
  eventId: string
  ticketCount: number
  signatureValid: boolean
  issuerKnown: boolean
}

/**
 * Imports a `.tkpak` into a new event owned by the importer.
 *
 * Into a new event rather than merging into an existing one: the file carries somebody else's
 * identifiers, and quietly folding them into an event the importer already has is how two
 * different people's tickets end up in one list with no way to tell them apart. Merging is a
 * synchronisation concern, and synchronisation has an operation log for it.
 */
/** The column's spelling of a media type. The wire uses the full type; the schema uses a code. */
const MEDIA_TYPE_CODES: Record<DocumentMediaType, 'PDF' | 'PNG' | 'JPEG' | 'PKPASS'> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'application/vnd.apple.pkpass': 'PKPASS',
}

export async function importArchive(
  deps: TransferDeps,
  input: {
    importerUserId: string
    importerDataKey: Uint8Array
    sessionId: string
    archive: Uint8Array
    password: string
  },
): Promise<ImportResult> {
  const inspection = inspectTkpak(input.archive)
  const opened = await openWithPassword(input.archive, input.password)

  const { createEvent } = await import('./events.js')
  const created = await createEvent(deps, {
    creatorUserId: input.importerUserId,
    creatorDataKey: input.importerDataKey,
    name: opened.bundle.event.name,
    ...(opened.bundle.event.venue ? { venue: opened.bundle.event.venue } : {}),
    ...(opened.bundle.event.notes ? { notes: opened.bundle.event.notes } : {}),
    ...(opened.bundle.event.startsAt ? { startsAt: opened.bundle.event.startsAt } : {}),
    ...(opened.bundle.event.timeZone ? { timeZone: opened.bundle.event.timeZone } : {}),
    defaultAssignmentMode: opened.bundle.event.defaultAssignmentMode,
  })
  deps.vaults.unlockEvent(input.sessionId, created.eventId, created.eventKey)

  const blobIdByOriginal = new Map<string, string>()
  for (const document of opened.documents.values()) {
    const stored = await storeBlob(deps, {
      eventId: created.eventId,
      eventKey: created.eventKey,
      mediaType: document.mediaType,
      bytes: document.bytes,
    })
    blobIdByOriginal.set(document.id, stored.id)
  }

  // The originals recorded as imports, so they are listed as the event's documents rather than
  // sitting on disk as blobs nothing points at. Everything else in the file is one ticket's page,
  // reached from that ticket, and calling those originals would list a page per seat.
  for (const originalId of opened.bundle.event.documentIds ?? []) {
    const storedId = blobIdByOriginal.get(originalId)
    const document = opened.documents.get(originalId)
    if (!storedId || !document) {
      continue
    }
    await deps.db.db
      .insertInto('ingest_batches')
      .values({
        id: newId(),
        event_id: created.eventId,
        created_by: input.importerUserId,
        source_media_type: MEDIA_TYPE_CODES[document.mediaType],
        source_blob_id: storedId,
        // Split wherever the file came from, so nothing was counted or detected here.
        page_count: null,
        detected_count: null,
        state: 'CONFIRMED',
        failure_reason: null,
        created_at: toInstant(),
        updated_at: toInstant(),
      })
      .execute()
  }

  await addTickets(deps, {
    eventId: created.eventId,
    actorUserId: input.importerUserId,
    eventKey: created.eventKey,
    tickets: opened.bundle.tickets.map((ticket) => ({
      ...(ticket.label ? { label: ticket.label } : {}),
      ...(ticket.section ? { section: ticket.section } : {}),
      ...(ticket.row ? { row: ticket.row } : {}),
      ...(ticket.seat ? { seat: ticket.seat } : {}),
      ...(ticket.barcode ? { barcode: ticket.barcode } : {}),
      ...(ticket.documentBlobId && blobIdByOriginal.has(ticket.documentBlobId)
        ? { documentBlobId: blobIdByOriginal.get(ticket.documentBlobId) }
        : {}),
      ...(ticket.documentPage === undefined ? {} : { documentPage: ticket.documentPage }),
      assignmentMode: ticket.assignmentMode,
    })),
  })

  const knownDevice = await deps.db.db
    .selectFrom('devices')
    .select('id')
    .where('signing_public_key', '=', opened.manifest.issuer.publicKey)
    .executeTakeFirst()

  await repo.recordAudit(deps.db, {
    actorUserId: input.importerUserId,
    action: 'event.imported',
    subjectKind: 'event',
    subjectId: created.eventId,
  })

  return {
    eventId: created.eventId,
    ticketCount: opened.bundle.tickets.length,
    signatureValid: inspection.signatureValid,
    // Not an error. An unknown issuer is the normal case for a file from a friend you have never
    // paired with, and the interface says the sender could not be verified rather than refusing.
    issuerKnown: knownDevice !== undefined,
  }
}

export function inspectArchive(archive: Uint8Array): {
  ticketCount: number | null
  eventName: string | null
  needsPassword: boolean
  signatureValid: boolean
} {
  const inspection = inspectTkpak(archive)
  return {
    ticketCount: inspection.manifest.preview?.ticketCount ?? null,
    eventName: inspection.manifest.preview?.eventName ?? null,
    needsPassword: inspection.canOpenWithPassword,
    signatureValid: inspection.signatureValid,
  }
}

export const newOperationId = (): string => newId()
