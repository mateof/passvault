import { forbidden, notFound } from './errors.js'
import { findEvent, type EventDeps } from './events.js'

/**
 * Reading the trail.
 *
 * `audit_events` has been written from fourteen places since the beginning and read from none:
 * there was no route that returned any of it. A record nobody can look at is a record that exists
 * to be believed in rather than consulted, and the one moment anybody wants it — who withdrew that
 * ticket, when did this account change hands, how many times was that code presented — is the
 * moment it was unavailable.
 *
 * Two audiences, and the difference is the whole design.
 *
 * The **administrator** sees the installation's own trail: accounts created, promoted, suspended,
 * deleted. That is their job and it is about the instance.
 *
 * The **creator of an event** sees what happened to that event's tickets and nothing else. Not the
 * account trail, not another organiser's event. It answers "what happened to my seats", which is
 * the question an organiser actually has, without turning every organiser into an auditor of the
 * server.
 *
 * `detail_cipher` is never returned. It is sealed under a key this path does not open, and the
 * action, the subject and the time are what makes a trail readable; the payload adds detail nobody
 * has asked for at the cost of a decryption on a screen that lists two hundred rows.
 */

export interface AuditEntry {
  id: string
  action: string
  subjectKind: string | null
  subjectId: string | null
  createdAt: string
  /** The actor's public name, when they have one. Their id otherwise: a trail cannot have gaps. */
  actor: string | null
}

const PAGE = 200

async function withActors(
  deps: EventDeps,
  rows: {
    id: string
    action: string
    subject_kind: string | null
    subject_id: string | null
    created_at: string
    actor_user_id: string | null
  }[],
): Promise<AuditEntry[]> {
  const ids = [...new Set(rows.map((row) => row.actor_user_id).filter(Boolean))] as string[]
  const handles = new Map<string, string | null>()
  if (ids.length > 0) {
    const found = await deps.db.db
      .selectFrom('users')
      .select(['id', 'handle'])
      .where('id', 'in', ids)
      .execute()
    for (const user of found) {
      handles.set(user.id, user.handle)
    }
  }
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    actor: row.actor_user_id ? (handles.get(row.actor_user_id) ?? row.actor_user_id) : null,
  }))
}

/** The installation's trail, newest first. Administrators only. */
export async function installationAudit(
  deps: EventDeps,
  input: { actorUserId: string; limit?: number },
): Promise<AuditEntry[]> {
  const actor = await deps.db.db
    .selectFrom('users')
    .select('is_admin')
    .where('id', '=', input.actorUserId)
    .executeTakeFirst()
  if (!actor || actor.is_admin !== 1) {
    throw forbidden()
  }
  const rows = await deps.db.db
    .selectFrom('audit_events')
    .select(['id', 'action', 'subject_kind', 'subject_id', 'created_at', 'actor_user_id'])
    .orderBy('created_at', 'desc')
    .limit(Math.min(input.limit ?? PAGE, PAGE))
    .execute()
  return withActors(deps, rows)
}

/**
 * What happened to one event's tickets, newest first. Its creator only.
 *
 * Selected by subject rather than by a column on the audit row, because there is no event_id
 * there: an audit line names a ticket. So the event's ticket ids are gathered and the trail is
 * read for those, plus the lines written against the event itself — an unknown code presented at
 * its door belongs to the event, since by definition it belongs to no ticket.
 */
export async function eventAudit(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string; limit?: number },
): Promise<AuditEntry[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden('event.error.notCreator')
  }

  const tickets = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .execute()
  const subjects = [input.eventId, ...tickets.map((ticket) => ticket.id)]

  const rows = await deps.db.db
    .selectFrom('audit_events')
    .select(['id', 'action', 'subject_kind', 'subject_id', 'created_at', 'actor_user_id'])
    .where('subject_id', 'in', subjects)
    .orderBy('created_at', 'desc')
    .limit(Math.min(input.limit ?? PAGE, PAGE))
    .execute()
  return withActors(deps, rows)
}
