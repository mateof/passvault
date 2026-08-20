import { toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import { findEvent, type EventDeps } from './events.js'
import * as repo from './repository.js'

/** The same reference `tickets.ts` seals its columns under, so the two agree byte for byte. */
const field = (ticketId: string, column: string) => ({
  table: 'tickets',
  column,
  rowId: ticketId,
})

/**
 * Admitting a seat at the door.
 *
 * The threat model is blunt about what this cannot be. A barcode is a bearer token; two people can
 * arrive with the same one and the turnstile will let the first through. Nothing here changes
 * that, and nothing here should be read as claiming to.
 *
 * What it changes is *when somebody finds out*. Until now a duplicated code was discovered by the
 * person refused at the gate, with no way to tell which of the two was the copy or when the other
 * went through. Now the second scan says so on the spot, to somebody standing there who can ask a
 * question — and the count says how many times it has happened, which a yes-or-no flag cannot.
 *
 * The stated goal of the whole design is "preventing mistakes, keeping an audit trail, and keeping
 * the exposure window small". This is the audit trail arriving in time to be useful.
 */

export type CheckInOutcome =
  /** First time through. */
  | 'ADMITTED'
  /** A real ticket of this event that has already been admitted. */
  | 'ALREADY_USED'
  /** A real ticket the creator has since withdrawn. */
  | 'WITHDRAWN'
  /** No ticket of this event carries that code. */
  | 'UNKNOWN'

export interface CheckInResult {
  outcome: CheckInOutcome
  ticketId?: string
  label?: string | null
  holder?: string | null
  /** When it was first admitted. Present on a repeat, which is what makes the repeat readable. */
  firstUsedAt?: string | null
  /** How many times this code has now been presented, this scan included. */
  usedCount?: number
}

/**
 * Who may work the door: the creator, and anybody they made an organiser of the event.
 *
 * A member is not enough. Being given a seat is not being given the guest list, and the outcome of
 * a scan says who holds which ticket.
 */
async function assertDoorStaff(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string },
): Promise<void> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id === input.actorUserId) {
    return
  }
  const direct = await deps.db.db
    .selectFrom('event_access')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('subject_kind', '=', 'USER')
    .where('subject_id', '=', input.actorUserId)
    .where('role', '=', 'ORGANISER')
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (direct) {
    return
  }
  const viaGroup = await deps.db.db
    .selectFrom('event_access')
    .innerJoin('group_members', 'group_members.group_id', 'event_access.subject_id')
    .select('event_access.id')
    .where('event_access.event_id', '=', input.eventId)
    .where('event_access.subject_kind', '=', 'GROUP')
    .where('event_access.role', '=', 'ORGANISER')
    .where('event_access.revoked_at', 'is', null)
    .where('group_members.user_id', '=', input.actorUserId)
    .where('group_members.status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!viaGroup) {
    throw forbidden('event.error.notCreator')
  }
}

/** The decrypted label, so a scan names a person rather than a row id. */
function readable(
  deps: EventDeps,
  eventKey: Uint8Array,
  ticketId: string,
  column: 'label_cipher' | 'holder_label_cipher',
  stored: Buffer | Uint8Array | null,
): string | null {
  if (!stored) {
    return null
  }
  try {
    return deps.crypto.decryptField(eventKey, new Uint8Array(stored), field(ticketId, column))
  } catch {
    // A door queue is the worst possible place to fail over a label. The outcome is what matters.
    return null
  }
}

/**
 * Records a presentation of a ticket and says what the door should do about it.
 *
 * Every scan of a known ticket counts, admitted or not. That is deliberate: the number that
 * matters at a gate is how many times this code has been shown, and a repeat that did not
 * increment would make the third attempt look like the second.
 */
async function present(
  deps: EventDeps,
  input: {
    ticket: {
      id: string
      event_id: string
      status: string
      used_at: string | null
      used_count: number
      label_cipher: Buffer | Uint8Array | null
      holder_label_cipher: Buffer | Uint8Array | null
      holder_user_id: string | null
    }
    actorUserId: string
    eventKey: Uint8Array
  },
): Promise<CheckInResult> {
  const { ticket } = input
  const count = ticket.used_count + 1
  const outcome: CheckInOutcome =
    ticket.status === 'WITHDRAWN' ? 'WITHDRAWN' : ticket.used_at ? 'ALREADY_USED' : 'ADMITTED'

  const handle = ticket.holder_user_id
    ? ((
        await deps.db.db
          .selectFrom('users')
          .select('handle')
          .where('id', '=', ticket.holder_user_id)
          .executeTakeFirst()
      )?.handle ?? null)
    : null

  await deps.db.db
    .updateTable('tickets')
    .set({
      used_count: count,
      // The first admission is the one that stands. A second scan does not move the time, or the
      // record of when this seat went in would be rewritten by whoever copied it.
      ...(outcome === 'ADMITTED'
        ? { used_at: toInstant(), used_by_user_id: input.actorUserId }
        : {}),
      updated_at: toInstant(),
    })
    .where('id', '=', ticket.id)
    .execute()

  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: `ticket.checkin.${outcome.toLowerCase()}`,
    subjectKind: 'ticket',
    subjectId: ticket.id,
  })

  return {
    outcome,
    ticketId: ticket.id,
    label: readable(deps, input.eventKey, ticket.id, 'label_cipher', ticket.label_cipher),
    holder:
      handle ??
      readable(deps, input.eventKey, ticket.id, 'holder_label_cipher', ticket.holder_label_cipher),
    firstUsedAt: ticket.used_at,
    usedCount: count,
  }
}

/**
 * Admits whatever a scanner just read.
 *
 * The code arrives as the value off the symbol, and every ticket of the event is decrypted to find
 * it. Linear, and that is fine: an event is hundreds of seats, not millions, and the alternative —
 * an index over barcodes — would mean storing something derived from a code the server is built
 * not to be able to read at rest.
 *
 * An unknown code is not an error. Somebody presenting a ticket for the wrong night is the most
 * ordinary thing that happens at a door, and it deserves an answer, not a 404.
 */
export async function checkInByBarcode(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string; eventKey: Uint8Array; value: string },
): Promise<CheckInResult> {
  await assertDoorStaff(deps, input)
  if (input.value.length === 0) {
    throw badRequest('checkin.error.empty')
  }

  const rows = await deps.db.db
    .selectFrom('tickets')
    .select([
      'id',
      'event_id',
      'status',
      'used_at',
      'used_count',
      'barcode_cipher',
      'label_cipher',
      'holder_label_cipher',
      'holder_user_id',
    ])
    .where('event_id', '=', input.eventId)
    .where('barcode_cipher', 'is not', null)
    .execute()

  for (const row of rows) {
    if (!row.barcode_cipher) {
      continue
    }
    let value: string
    try {
      value = deps.crypto.decryptField(
        input.eventKey,
        new Uint8Array(row.barcode_cipher),
        field(row.id, 'barcode_cipher'),
      )
    } catch {
      continue
    }
    if (value === input.value) {
      return present(deps, {
        ticket: row,
        actorUserId: input.actorUserId,
        eventKey: input.eventKey,
      })
    }
  }

  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'ticket.checkin.unknown',
    subjectKind: 'event',
    subjectId: input.eventId,
  })
  return { outcome: 'UNKNOWN' }
}

/** The same, for a seat picked off the list rather than scanned — a phone with a dead screen. */
export async function checkInTicket(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string; eventKey: Uint8Array },
): Promise<CheckInResult> {
  const ticket = await deps.db.db
    .selectFrom('tickets')
    .select([
      'id',
      'event_id',
      'status',
      'used_at',
      'used_count',
      'label_cipher',
      'holder_label_cipher',
      'holder_user_id',
    ])
    .where('id', '=', input.ticketId)
    .executeTakeFirst()
  if (!ticket) {
    throw notFound()
  }
  await assertDoorStaff(deps, { eventId: ticket.event_id, actorUserId: input.actorUserId })
  return present(deps, { ticket, actorUserId: input.actorUserId, eventKey: input.eventKey })
}

/**
 * Undoes an admission.
 *
 * Somebody will scan the wrong row, and a door with no undo is one where the fix is a database
 * client. The count goes back to nothing as well: a mistaken scan that left "presented twice"
 * behind would accuse the next holder of something that never happened.
 */
export async function undoCheckIn(
  deps: EventDeps,
  input: { ticketId: string; actorUserId: string },
): Promise<void> {
  const ticket = await deps.db.db
    .selectFrom('tickets')
    .select(['id', 'event_id'])
    .where('id', '=', input.ticketId)
    .executeTakeFirst()
  if (!ticket) {
    throw notFound()
  }
  await assertDoorStaff(deps, { eventId: ticket.event_id, actorUserId: input.actorUserId })
  await deps.db.db
    .updateTable('tickets')
    .set({ used_at: null, used_by_user_id: null, used_count: 0, updated_at: toInstant() })
    .where('id', '=', input.ticketId)
    .execute()
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'ticket.checkin.undone',
    subjectKind: 'ticket',
    subjectId: input.ticketId,
  })
}
