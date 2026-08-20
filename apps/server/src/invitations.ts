import { newId, toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import { findEvent, grantAccess, type EventDeps } from './events.js'
import { notify } from './notifications.js'

/**
 * Being offered an event, and answering.
 *
 * Sharing used to grant access outright: an event appeared in somebody's wallet without their
 * having agreed to hold it. For a thing that carries a friend's name, their seat and sometimes
 * what they paid, that is the wrong default — and it also left the recipient with nowhere to be
 * told about it, so a share was invisible until they happened to look.
 *
 * So a share creates an invitation and a notice. Access begins when the invitation is accepted,
 * and the acceptance is where an event password is typed: the password is what decrypts the
 * event, and the natural moment to ask for it is the moment somebody says yes.
 *
 * One row per person even when the invitation arrived through a group, because a group cannot
 * answer a question. `via_group_id` records how it arrived so that removing a group can withdraw
 * what the group brought and leave a personal invitation alone.
 */
export interface InvitationSummary {
  id: string
  eventId: string
  eventName: string
  invitedBy: string
  viaGroupId: string | null
  state: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN'
  passwordProtected: boolean
  createdAt: string
}

export async function invite(
  deps: EventDeps,
  input: {
    eventId: string
    userId: string
    invitedBy: string
    viaGroupId?: string | null
    /** The event's name, already decrypted by the caller who had the key. */
    eventName: string
    inviterName: string
    /** What they are being offered. Applied when they accept, since that is when access begins. */
    role?: 'ORGANISER' | 'MEMBER'
  },
): Promise<{ invitationId: string; alreadyInvited: boolean }> {
  const existing = await deps.db.db
    .selectFrom('event_invitations')
    .select(['id', 'state'])
    .where('event_id', '=', input.eventId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst()

  if (existing) {
    // Inviting somebody twice says the same thing twice. A withdrawn or declined invitation is
    // reopened rather than duplicated, so somebody who said no can be asked again without their
    // wallet growing a second copy of the same question.
    if (existing.state === 'ACCEPTED') {
      return { invitationId: existing.id, alreadyInvited: true }
    }
    await deps.db.db
      .updateTable('event_invitations')
      .set({
        state: 'PENDING',
        created_at: toInstant(),
        answered_at: null,
        role: input.role ?? 'MEMBER',
      })
      .where('id', '=', existing.id)
      .execute()
    await notifyInvited(deps, input)
    return { invitationId: existing.id, alreadyInvited: false }
  }

  const id = newId()
  await deps.db.db
    .insertInto('event_invitations')
    .values({
      id,
      event_id: input.eventId,
      user_id: input.userId,
      invited_by: input.invitedBy,
      via_group_id: input.viaGroupId ?? null,
      state: 'PENDING',
      created_at: toInstant(),
      answered_at: null,
      role: input.role ?? 'MEMBER',
    })
    .execute()

  await notifyInvited(deps, input)
  return { invitationId: id, alreadyInvited: false }
}

const notifyInvited = (
  deps: EventDeps,
  input: { eventId: string; userId: string; eventName: string; inviterName: string },
): Promise<void> =>
  notify(deps, {
    userId: input.userId,
    kind: 'event.invited',
    payload: {
      eventId: input.eventId,
      eventName: input.eventName,
      invitedBy: input.inviterName,
    },
  })

export async function listInvitations(
  deps: EventDeps,
  input: { userId: string; pendingOnly?: boolean },
): Promise<InvitationSummary[]> {
  let query = deps.db.db
    .selectFrom('event_invitations')
    .innerJoin('events', 'events.id', 'event_invitations.event_id')
    .select([
      'event_invitations.id',
      'event_invitations.event_id',
      'event_invitations.invited_by',
      'event_invitations.via_group_id',
      'event_invitations.state',
      'event_invitations.created_at',
      'events.password_protected',
    ])
    .where('event_invitations.user_id', '=', input.userId)
  if (input.pendingOnly) {
    query = query.where('event_invitations.state', '=', 'PENDING')
  }
  const rows = await query.orderBy('event_invitations.created_at', 'desc').execute()

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    // The name comes from the notice rather than from here: the event name is encrypted under a
    // key this reader does not have until they accept, which is the whole point of accepting.
    eventName: '',
    invitedBy: row.invited_by,
    viaGroupId: row.via_group_id,
    state: row.state,
    passwordProtected: row.password_protected === 1,
    createdAt: row.created_at,
  }))
}

/**
 * Says yes, which is what actually grants the access.
 *
 * The password is checked here by opening the event with it, because accepting an event you
 * cannot decrypt would put a row in a wallet that renders as nothing at all — the failure would
 * arrive later, in a list, with no way to tell it from a bug.
 */
export async function acceptInvitation(
  deps: EventDeps,
  input: {
    invitationId: string
    userId: string
    sessionId: string
    password?: string
    /** Opens the event, so a wrong password is refused here rather than discovered later. */
    openEvent: (eventId: string, password?: string) => Promise<unknown>
  },
): Promise<{ eventId: string }> {
  const invitation = await require(deps, input.invitationId, input.userId)
  if (invitation.state === 'ACCEPTED') {
    return { eventId: invitation.event_id }
  }
  if (invitation.state === 'WITHDRAWN') {
    throw badRequest('invitation.error.withdrawn')
  }

  const event = await findEvent(deps, invitation.event_id)
  if (!event) {
    throw notFound()
  }

  /*
   * How access begins depends on how the invitation arrived, and the difference matters when it
   * is taken away again.
   *
   * A personal invitation grants a personal access row: one person was offered it, one person
   * holds it, and revoking names them.
   *
   * One that came through a group grants nothing of its own. The group's access row is what
   * opens the event and this acceptance is what says the person agreed to hold it — both are
   * required. Granting a personal row here instead would survive the group being deleted, and
   * deleting a group is exactly how somebody stops a circle seeing their events.
   */
  const personal = invitation.via_group_id === null

  // Marked accepted before the event is opened, because opening is what checks whether the
  // caller may — and for a group invitation the acceptance is half of that answer. Rolled back
  // below if the password turns out to be wrong, so a refusal leaves the invitation unanswered
  // rather than accepted-but-unreadable.
  await deps.db.db
    .updateTable('event_invitations')
    .set({ state: 'ACCEPTED', answered_at: toInstant() })
    .where('id', '=', invitation.id)
    .execute()

  if (personal) {
    await grantAccess(deps, {
      eventId: invitation.event_id,
      actorUserId: event.creator_user_id,
      subjectKind: 'USER',
      subjectId: input.userId,
      // What they were offered, not a fixed MEMBER. The creator's choice was made when they
      // shared it; this is only the moment it takes effect.
      role: invitation.role ?? 'MEMBER',
    })
  }

  try {
    await input.openEvent(invitation.event_id, input.password)
  } catch (cause) {
    await deps.db.db
      .updateTable('event_invitations')
      .set({ state: 'PENDING', answered_at: null })
      .where('id', '=', invitation.id)
      .execute()
    if (personal) {
      await deps.db.db
        .updateTable('event_access')
        .set({ revoked_at: toInstant() })
        .where('event_id', '=', invitation.event_id)
        .where('subject_kind', '=', 'USER')
        .where('subject_id', '=', input.userId)
        .execute()
    }
    throw cause
  }

  await notify(deps, {
    userId: event.creator_user_id,
    kind: 'event.accepted',
    payload: { eventId: invitation.event_id, userId: input.userId },
  })

  return { eventId: invitation.event_id }
}

export async function declineInvitation(
  deps: EventDeps,
  input: { invitationId: string; userId: string },
): Promise<void> {
  const invitation = await require(deps, input.invitationId, input.userId)
  await deps.db.db
    .updateTable('event_invitations')
    .set({ state: 'DECLINED', answered_at: toInstant() })
    .where('id', '=', invitation.id)
    .execute()

  const event = await findEvent(deps, invitation.event_id)
  if (event) {
    await notify(deps, {
      userId: event.creator_user_id,
      kind: 'event.declined',
      payload: { eventId: invitation.event_id, userId: input.userId },
    })
  }
}

/**
 * Withdraws what a group or a person was offered.
 *
 * Paired with revoking access rather than replacing it: a pending invitation and a granted access
 * are two different states, and taking one away has to take the other with it or an event stays
 * offered to somebody it was taken away from.
 */
export async function withdrawInvitations(
  deps: EventDeps,
  input: { eventId: string; userId?: string; viaGroupId?: string },
): Promise<void> {
  let query = deps.db.db
    .updateTable('event_invitations')
    .set({ state: 'WITHDRAWN', answered_at: toInstant() })
    .where('event_id', '=', input.eventId)
    .where('state', '=', 'PENDING')
  if (input.userId) {
    query = query.where('user_id', '=', input.userId)
  }
  if (input.viaGroupId) {
    query = query.where('via_group_id', '=', input.viaGroupId)
  }
  await query.execute()
}

async function require(
  deps: EventDeps,
  invitationId: string,
  userId: string,
): Promise<{
  id: string
  event_id: string
  state: string
  via_group_id: string | null
  role: 'ORGANISER' | 'MEMBER'
}> {
  const row = await deps.db.db
    .selectFrom('event_invitations')
    .select(['id', 'event_id', 'user_id', 'state', 'via_group_id', 'role'])
    .where('id', '=', invitationId)
    .executeTakeFirst()
  if (!row) {
    throw notFound()
  }
  if (row.user_id !== userId) {
    // Somebody else's invitation. Not theirs to answer, and not theirs to know about either.
    throw forbidden()
  }
  return row
}
