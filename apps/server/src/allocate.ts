import { forbidden, notFound } from './errors.js'
import { findEvent, type EventDeps } from './events.js'
import { assignTicket } from './tickets.js'

/**
 * Handing a whole event out at once.
 *
 * Assigning was one ticket per request, which is correct and unusable at the size this product is
 * for: ten seats to a group of ten was ten round trips and ten decisions, made one at a time, with
 * no way to see whether the tenth had been missed. The organiser's actual question is "everybody
 * in this group gets one" and there was no way to say it.
 *
 * Deliberately not clever about *which* seat goes to whom. Free tickets in the order they were
 * imported, people in the order they were given, one each — the order a person would do it by
 * hand. Anything smarter would be the software deciding who sits at the front, which is a decision
 * the organiser has reasons for and this code does not know them.
 *
 * Reuses `assignTicket` per seat rather than writing its own update. The assignment rules — a
 * fresh reveal window, a cleared return, the encrypted holder label — live there, and a second
 * implementation would drift from them the first time one of the two changed.
 */

export interface AllocationResult {
  /** Seats handed out, in the order they were taken. */
  assigned: { ticketId: string; holderUserId: string }[]
  /** People who got nothing because the seats ran out, so the organiser is told rather than left
   *  to count. */
  unseated: string[]
  /** Seats still free after everybody had one. */
  remaining: number
}

export async function allocate(
  deps: EventDeps,
  input: {
    eventId: string
    actorUserId: string
    eventKey: Uint8Array
    /** In order. The first person gets the first free seat. */
    holderUserIds: string[]
  },
): Promise<AllocationResult> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }

  const free = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('status', '=', 'ACTIVE')
    .where('assignment_state', '=', 'FREE')
    .orderBy('created_at', 'asc')
    .execute()

  const assigned: { ticketId: string; holderUserId: string }[] = []
  const unseated: string[] = []
  // Deduplicated, keeping the first mention. Somebody named twice in a group and again by hand
  // should get one seat, not two — and the second would be silently taken from whoever is last
  // in the list.
  const people = [...new Set(input.holderUserIds)]

  for (const [index, holderUserId] of people.entries()) {
    const seat = free[index]
    if (!seat) {
      unseated.push(holderUserId)
      continue
    }
    await assignTicket(deps, {
      ticketId: seat.id,
      actorUserId: input.actorUserId,
      eventKey: input.eventKey,
      holderUserId,
    })
    assigned.push({ ticketId: seat.id, holderUserId })
  }

  return { assigned, unseated, remaining: Math.max(0, free.length - assigned.length) }
}
