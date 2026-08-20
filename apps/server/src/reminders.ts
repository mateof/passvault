import { toInstant } from '@passvault/db'
import type { EventDeps } from './events.js'
import { notify, type NoticeKind } from './notifications.js'

/**
 * The things worth being told before they happen.
 *
 * Until now nothing in this server ever spoke first. Notices were written as a side effect of
 * somebody's request — you were told about an invitation because somebody sent one — which means
 * everything that matters because of *time* went unsaid. The countdown on a withheld code is only
 * a countdown if you happen to be looking at it.
 *
 * Four of them, and they were chosen by asking what a person would be annoyed to have missed:
 * the event is tomorrow, your code is about to open, you still owe for your seat, and — for the
 * organiser — there are seats nobody has taken and the night is close.
 *
 * ## Not being told twice
 *
 * There is no schedule table and no marker column. A reminder is due when its condition holds and
 * no notice of that kind exists for that person and that subject, which is a question the
 * notifications table can already answer. That is not a shortcut: a marker is a second record of
 * the same fact, and the failure it invites — the marker written, the notice lost — is worse than
 * the query it saves.
 *
 * The consequence is that the sweep is idempotent. Running it twice a minute, or twice after a
 * restart, or on two servers pointed at one database, sends each reminder once.
 */

export type ReminderKind =
  'reminder.eventTomorrow' | 'reminder.codeOpening' | 'reminder.unpaid' | 'reminder.seatsUnclaimed'

/** How far ahead each reminder looks. */
const HORIZON = {
  /** The evening before, roughly: anything starting inside a day. */
  eventTomorrow: 24 * 60 * 60 * 1000,
  /** Close enough to be worth putting a phone in a pocket for. */
  codeOpening: 60 * 60 * 1000,
  /** Long enough to do something about it, short enough not to nag a month early. */
  unpaid: 3 * 24 * 60 * 60 * 1000,
  seatsUnclaimed: 3 * 24 * 60 * 60 * 1000,
} as const

/**
 * Whether this person has already been told this about this thing.
 *
 * The payload is ciphertext under a key this path does not open, so the subject cannot be read
 * out of it. It is stored in the kind instead — `reminder.unpaid:<ticket id>` — which is plain
 * by design: that a reminder was sent is not a secret, and the alternative is decrypting every
 * notice a person holds on every sweep.
 */
async function alreadyTold(
  deps: EventDeps,
  input: { userId: string; kind: string },
): Promise<boolean> {
  const existing = await deps.db.db
    .selectFrom('notifications')
    .select('id')
    .where('user_id', '=', input.userId)
    .where('kind', '=', input.kind)
    .executeTakeFirst()
  return existing !== undefined
}

async function tell(
  deps: EventDeps,
  input: {
    userId: string
    kind: ReminderKind
    subjectId: string
    payload: Record<string, unknown>
  },
): Promise<boolean> {
  const stamped = `${input.kind}:${input.subjectId}`
  if (await alreadyTold(deps, { userId: input.userId, kind: stamped })) {
    return false
  }
  await notify(deps, {
    userId: input.userId,
    // The stamped kind is what is stored. Readers split on the colon, so a client that has never
    // heard of reminders still sees a notice it can file under something.
    kind: stamped as NoticeKind,
    payload: { ...input.payload, reminder: input.kind },
  })
  return true
}

/** Everybody who can see this event: its creator, and whoever it was shared with. */
async function audience(deps: EventDeps, eventId: string, creatorId: string): Promise<string[]> {
  const holders = await deps.db.db
    .selectFrom('tickets')
    .select('holder_user_id')
    .where('event_id', '=', eventId)
    .where('holder_user_id', 'is not', null)
    .execute()
  const people = new Set<string>([creatorId])
  for (const row of holders) {
    if (row.holder_user_id) {
      people.add(row.holder_user_id)
    }
  }
  return [...people]
}

export interface SweepResult {
  sent: number
}

/**
 * One pass. Cheap enough to run every few minutes and safe to run at any moment.
 *
 * Scoped to events that have not happened yet and start inside the widest horizon, so the cost is
 * proportional to what is coming up rather than to everything the installation has ever held.
 */
export async function sweepReminders(deps: EventDeps): Promise<SweepResult> {
  const now = Date.now()
  const nowInstant = toInstant()
  const widest = new Date(now + Math.max(...Object.values(HORIZON))).toISOString()

  const upcoming = await deps.db.db
    .selectFrom('events')
    .select(['id', 'creator_user_id', 'starts_at'])
    .where('status', '=', 'ACTIVE')
    .where('starts_at', 'is not', null)
    .where('starts_at', '>', nowInstant)
    .where('starts_at', '<', widest)
    .execute()

  let sent = 0

  for (const event of upcoming) {
    const startsAt = event.starts_at
    if (!startsAt) {
      continue
    }
    const until = new Date(startsAt).getTime() - now

    if (until <= HORIZON.eventTomorrow) {
      for (const userId of await audience(deps, event.id, event.creator_user_id)) {
        if (
          await tell(deps, {
            userId,
            kind: 'reminder.eventTomorrow',
            subjectId: event.id,
            payload: { eventId: event.id, startsAt },
          })
        ) {
          sent += 1
        }
      }
    }

    const tickets = await deps.db.db
      .selectFrom('tickets')
      .leftJoin('payments', 'payments.ticket_id', 'tickets.id')
      .select([
        'tickets.id',
        'tickets.holder_user_id',
        'tickets.assignment_state',
        'tickets.status',
        'payments.state as payment_state',
      ])
      .where('tickets.event_id', '=', event.id)
      .where('tickets.status', '=', 'ACTIVE')
      .execute()

    if (until <= HORIZON.unpaid) {
      for (const ticket of tickets) {
        const owing = ticket.payment_state === 'UNPAID' || ticket.payment_state === 'PARTIAL'
        if (!owing || !ticket.holder_user_id) {
          continue
        }
        if (
          await tell(deps, {
            userId: ticket.holder_user_id,
            kind: 'reminder.unpaid',
            subjectId: ticket.id,
            payload: { eventId: event.id, ticketId: ticket.id },
          })
        ) {
          sent += 1
        }
      }
    }

    if (until <= HORIZON.seatsUnclaimed) {
      const free = tickets.filter((ticket) => ticket.assignment_state === 'FREE').length
      if (free > 0) {
        if (
          await tell(deps, {
            userId: event.creator_user_id,
            kind: 'reminder.seatsUnclaimed',
            subjectId: event.id,
            payload: { eventId: event.id, free },
          })
        ) {
          sent += 1
        }
      }
    }
  }

  // Codes about to open are not tied to an event starting soon: a creator can set a moment months
  // out, or one an hour from now on an event next year. So they are swept on their own.
  const opening = new Date(now + HORIZON.codeOpening).toISOString()
  const waiting = await deps.db.db
    .selectFrom('tickets')
    .select(['id', 'event_id', 'holder_user_id', 'visible_from'])
    .where('status', '=', 'ACTIVE')
    .where('holder_user_id', 'is not', null)
    .where('visible_from', 'is not', null)
    .where('visible_from', '>', nowInstant)
    .where('visible_from', '<', opening)
    .execute()

  for (const ticket of waiting) {
    if (!ticket.holder_user_id) {
      continue
    }
    if (
      await tell(deps, {
        userId: ticket.holder_user_id,
        kind: 'reminder.codeOpening',
        subjectId: ticket.id,
        payload: {
          eventId: ticket.event_id,
          ticketId: ticket.id,
          visibleFrom: ticket.visible_from,
        },
      })
    ) {
      sent += 1
    }
  }

  return { sent }
}
