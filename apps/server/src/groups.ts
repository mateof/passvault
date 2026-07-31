import { newId, toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import * as repo from './repository.js'
import type { EventDeps } from './events.js'

/**
 * Groups: the people you share an event with more than once.
 *
 * The schema has had groups and group-scoped event access since the first migration, and there was
 * no way to make one — so every share had to name an individual, and "the family" had to be typed
 * out again for every concert. This is the missing half.
 *
 * A group name is ciphertext like everything else of value: it is usually somebody's family or a
 * circle of friends, which is exactly the kind of thing a stolen database should not spell out.
 * Membership rows are not encrypted, because they are user ids and the graph is what the queries
 * need — knowing that two accounts share a group is not knowing what they call it.
 */

export interface GroupSummary {
  id: string
  name: string
  role: 'OWNER' | 'ORGANISER' | 'MEMBER'
  memberCount: number
}

const groupAad = (groupId: string) => ({
  table: 'groups',
  column: 'name_cipher',
  rowId: groupId,
})

export async function createGroup(
  deps: EventDeps,
  input: { ownerUserId: string; ownerDataKey: Uint8Array; name: string },
): Promise<{ groupId: string }> {
  const groupId = newId()
  const now = toInstant()

  await deps.db.db
    .insertInto('groups')
    .values({
      id: groupId,
      name_cipher: Buffer.from(
        deps.crypto.encryptField(input.ownerDataKey, input.name, groupAad(groupId)),
      ),
      owner_user_id: input.ownerUserId,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    })
    .execute()

  // The owner is a member as well as the owner. Otherwise every query that asks "which groups am
  // I in" has to special-case the person who made it.
  await deps.db.db
    .insertInto('group_members')
    .values({
      id: newId(),
      group_id: groupId,
      user_id: input.ownerUserId,
      role: 'OWNER',
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    })
    .execute()

  return { groupId }
}

export async function listGroups(
  deps: EventDeps,
  input: { userId: string; dataKey: Uint8Array },
): Promise<GroupSummary[]> {
  const rows = await deps.db.db
    .selectFrom('groups')
    .innerJoin('group_members', 'group_members.group_id', 'groups.id')
    .select([
      'groups.id',
      'groups.name_cipher',
      'groups.owner_user_id',
      'group_members.role',
    ])
    .where('group_members.user_id', '=', input.userId)
    .where('group_members.status', '=', 'ACTIVE')
    .where('groups.status', '=', 'ACTIVE')
    .execute()

  const summaries: GroupSummary[] = []
  for (const row of rows) {
    const members = await deps.db.db
      .selectFrom('group_members')
      .select('id')
      .where('group_id', '=', row.id)
      .where('status', '=', 'ACTIVE')
      .execute()
    summaries.push({
      id: row.id,
      // Decrypted with the caller's key, which only works because a group is readable by the
      // person who made it. Shared groups would need the same key-wrapping the events use; that
      // is the next step and not this one.
      name: deps.crypto.decryptField(
        input.dataKey,
        new Uint8Array(row.name_cipher),
        groupAad(row.id),
      ),
      role: row.role,
      memberCount: members.length,
    })
  }
  return summaries
}

async function requireOrganiser(
  deps: EventDeps,
  groupId: string,
  userId: string,
): Promise<void> {
  const membership = await deps.db.db
    .selectFrom('group_members')
    .select('role')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!membership) {
    throw notFound()
  }
  if (membership.role === 'MEMBER') {
    // A member can see who else is in the group and cannot change it. Adding people is what makes
    // a group a way to hand out tickets, so it is the owner's decision.
    throw forbidden()
  }
}

/**
 * Adds somebody by email.
 *
 * Looked up through the blind index rather than by scanning: addresses are stored encrypted, and
 * the mirror column is what makes "is this person here" answerable without decrypting every row.
 *
 * An address that belongs to no account is refused rather than held as a pending invitation. A
 * silent no-op would be worse — the owner would believe the ticket was shared.
 */
export async function addMember(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string; email: string },
): Promise<{ userId: string }> {
  await requireOrganiser(deps, input.groupId, input.actorUserId)

  const user = await repo.findUserByEmailIndex(
    deps.db,
    deps.crypto.emailIndex(input.email),
  )
  if (!user) {
    throw badRequest('groups.error.unknownEmail')
  }

  const existing = await deps.db.db
    .selectFrom('group_members')
    .select(['id', 'status'])
    .where('group_id', '=', input.groupId)
    .where('user_id', '=', user.id)
    .executeTakeFirst()

  if (existing) {
    // Rejoining reactivates the row it already had, so the history of who was in the group when
    // survives. A second row would make membership ambiguous.
    if (existing.status !== 'ACTIVE') {
      await deps.db.db
        .updateTable('group_members')
        .set({ status: 'ACTIVE', updated_at: toInstant() })
        .where('id', '=', existing.id)
        .execute()
    }
    return { userId: user.id }
  }

  await deps.db.db
    .insertInto('group_members')
    .values({
      id: newId(),
      group_id: input.groupId,
      user_id: user.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      created_at: toInstant(),
      updated_at: toInstant(),
    })
    .execute()

  return { userId: user.id }
}

/**
 * Removes somebody.
 *
 * Marked inactive rather than deleted: the row is what lets a past assignment still resolve to a
 * name, and access checks already require an active membership, so this takes effect immediately
 * without losing who held what.
 */
export async function removeMember(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string; userId: string },
): Promise<void> {
  await requireOrganiser(deps, input.groupId, input.actorUserId)

  const group = await deps.db.db
    .selectFrom('groups')
    .select('owner_user_id')
    .where('id', '=', input.groupId)
    .executeTakeFirst()
  if (group?.owner_user_id === input.userId) {
    // Removing the owner would leave a group nobody can administer.
    throw badRequest('groups.error.cannotRemoveOwner')
  }

  await deps.db.db
    .updateTable('group_members')
    .set({ status: 'INACTIVE', updated_at: toInstant() })
    .where('group_id', '=', input.groupId)
    .where('user_id', '=', input.userId)
    .execute()
}

export async function listMembers(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string },
): Promise<{ userId: string; role: string }[]> {
  const membership = await deps.db.db
    .selectFrom('group_members')
    .select('id')
    .where('group_id', '=', input.groupId)
    .where('user_id', '=', input.actorUserId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!membership) {
    throw notFound()
  }

  const rows = await deps.db.db
    .selectFrom('group_members')
    .select(['user_id', 'role'])
    .where('group_id', '=', input.groupId)
    .where('status', '=', 'ACTIVE')
    .execute()

  return rows.map((row) => ({ userId: row.user_id, role: row.role }))
}
