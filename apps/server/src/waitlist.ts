import { newId, toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import { findEvent, hasAccess, type EventDeps } from './events.js'
import { notify, type NoticeKind } from './notifications.js'
import * as repo from './repository.js'

/**
 * The queue for a seat that comes back.
 *
 * Handing a seat back has always worked, and the seat has always gone straight to the free list
 * where it sat until the creator happened to look. The person who missed out had no way to say
 * "if one frees up, I want it" other than asking somebody to remember.
 *
 * ## What happens when a seat frees
 *
 * It depends on what the creator already decided, and the split is the whole point.
 *
 * Under **self-claim** the creator has already said that members take seats themselves. So the
 * first person waiting is given it: no new authority is being invented, the queue is just the
 * order they would have raced in.
 *
 * Under **assigned** or **open**, handing a seat to somebody is the creator's act. The queue does
 * not get to perform it. The first person waiting is told a seat has come free and the creator is
 * told who is waiting — which is the information neither of them had — and the creator assigns it,
 * as they always did.
 *
 * A queue that quietly handed out bearer tokens under a mode whose entire meaning is "the
 * organiser decides" would be the software overruling a decision somebody made on purpose.
 */

const OFFERED: NoticeKind = 'waitlist.seatFree' as NoticeKind
const WAITING: NoticeKind = 'waitlist.someoneWaiting' as NoticeKind

export interface WaitingEntry {
  userId: string
  handle: string | null
  since: string
  offeredAt: string | null
}

/** Joining. Anybody the event was shared with, because they are the people who could hold one. */
export async function joinWaitingList(
  deps: EventDeps,
  input: { eventId: string; userId: string },
): Promise<{ position: number }> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (
    event.creator_user_id !== input.userId &&
    !(await hasAccess(deps, input.eventId, input.userId))
  ) {
    throw forbidden()
  }
  if (event.creator_user_id === input.userId) {
    // The creator holds every seat that nobody else does. A queue of one, behind themselves.
    throw badRequest('waitlist.error.creator')
  }

  const existing = await deps.db.db
    .selectFrom('waiting_list')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst()
  if (!existing) {
    await deps.db.db
      .insertInto('waiting_list')
      .values({
        id: newId(),
        event_id: input.eventId,
        user_id: input.userId,
        created_at: toInstant(),
        offered_at: null,
      })
      .execute()
  }
  return { position: await positionOf(deps, input) }
}

export async function leaveWaitingList(
  deps: EventDeps,
  input: { eventId: string; userId: string },
): Promise<void> {
  await deps.db.db
    .deleteFrom('waiting_list')
    .where('event_id', '=', input.eventId)
    .where('user_id', '=', input.userId)
    .execute()
}

async function positionOf(
  deps: EventDeps,
  input: { eventId: string; userId: string },
): Promise<number> {
  const rows = await deps.db.db
    .selectFrom('waiting_list')
    .select('user_id')
    .where('event_id', '=', input.eventId)
    .orderBy('created_at', 'asc')
    .execute()
  return rows.findIndex((row) => row.user_id === input.userId) + 1
}

/** Who is waiting, in order. The creator's list — it names people who want their seats. */
export async function listWaiting(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string },
): Promise<WaitingEntry[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }
  const rows = await deps.db.db
    .selectFrom('waiting_list')
    .innerJoin('users', 'users.id', 'waiting_list.user_id')
    .select([
      'waiting_list.user_id',
      'waiting_list.created_at',
      'waiting_list.offered_at',
      'users.handle',
    ])
    .where('waiting_list.event_id', '=', input.eventId)
    .orderBy('waiting_list.created_at', 'asc')
    .execute()
  return rows.map((row) => ({
    userId: row.user_id,
    handle: row.handle,
    since: row.created_at,
    offeredAt: row.offered_at,
  }))
}

/**
 * A seat has come free. Called from wherever one does.
 *
 * Every failure is swallowed by the caller: a queue that could not be told is not a reason to fail
 * the return that freed the seat. Returning a ticket has to work whatever else is broken.
 */
export async function offerFreedSeat(
  deps: EventDeps,
  input: { ticketId: string; exceptUserId?: string },
): Promise<{ offeredTo: string | null; assigned: boolean }> {
  const ticket = await deps.db.db
    .selectFrom('tickets')
    .select(['id', 'event_id', 'assignment_mode', 'assignment_state', 'status'])
    .where('id', '=', input.ticketId)
    .executeTakeFirst()
  if (!ticket || ticket.status !== 'ACTIVE' || ticket.assignment_state !== 'FREE') {
    return { offeredTo: null, assigned: false }
  }
  const event = await findEvent(deps, ticket.event_id)
  if (!event) {
    return { offeredTo: null, assigned: false }
  }

  const queue = await deps.db.db
    .selectFrom('waiting_list')
    .select(['id', 'user_id', 'offered_at'])
    .where('event_id', '=', ticket.event_id)
    .orderBy('created_at', 'asc')
    .execute()
  // Not the person who just handed it back: offering somebody their own returned seat is the
  // software failing to notice what just happened.
  const next = queue.find((entry) => entry.user_id !== input.exceptUserId)
  if (!next) {
    return { offeredTo: null, assigned: false }
  }

  if (ticket.assignment_mode === 'SELF_CLAIM') {
    // The creator already said members take seats themselves. The queue is the order they would
    // have raced in, so taking it for them invents no authority.
    const claimed = await deps.db.db
      .updateTable('tickets')
      .set({
        assignment_state: 'CLAIMED',
        holder_user_id: next.user_id,
        assigned_at: toInstant(),
        returned_at: null,
        revealed_at: null,
        updated_at: toInstant(),
      })
      .where('id', '=', ticket.id)
      // Still free, or somebody beat the queue to it while this was being decided.
      .where('assignment_state', '=', 'FREE')
      .executeTakeFirst()
    if (Number(claimed.numUpdatedRows ?? 0) === 0) {
      return { offeredTo: null, assigned: false }
    }
    await deps.db.db.deleteFrom('waiting_list').where('id', '=', next.id).execute()
    await notify(deps, {
      userId: next.user_id,
      kind: OFFERED,
      payload: { eventId: ticket.event_id, ticketId: ticket.id, assigned: true },
    })
    await repo.recordAudit(deps.db, {
      actorUserId: next.user_id,
      action: 'ticket.waitlist.claimed',
      subjectKind: 'ticket',
      subjectId: ticket.id,
    })
    return { offeredTo: next.user_id, assigned: true }
  }

  // Assigned or open: telling, not giving. Handing a seat over is the creator's act, and a queue
  // that performed it would be overruling a decision they made on purpose.
  if (!next.offered_at) {
    await notify(deps, {
      userId: next.user_id,
      kind: OFFERED,
      payload: { eventId: ticket.event_id, ticketId: ticket.id, assigned: false },
    })
    await notify(deps, {
      userId: event.creator_user_id,
      kind: WAITING,
      payload: { eventId: ticket.event_id, ticketId: ticket.id, userId: next.user_id },
    })
    await deps.db.db
      .updateTable('waiting_list')
      .set({ offered_at: toInstant() })
      .where('id', '=', next.id)
      .execute()
  }
  return { offeredTo: next.user_id, assigned: false }
}
