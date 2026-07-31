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
 *
 * The name is encrypted under a key derived per group from the master key, not under the owner's
 * data key. The first draft used the owner's, which made a group unreadable to everybody in it
 * except the person who created it: the moment a member asked for their own list, the decryption
 * failed and the request died. This is the same trade a password-less event already makes and
 * docs/security.md already states — the operator can read it, a stolen database cannot.
 */

export interface GroupSummary {
  id: string
  name: string
  role: 'OWNER' | 'ORGANISER' | 'MEMBER'
  memberCount: number
  /** Whether the caller may rename or delete it, which the interface has to know before drawing. */
  isOwner: boolean
}

const groupAad = (groupId: string) => ({
  table: 'groups',
  column: 'name_cipher',
  rowId: groupId,
})

/** Derived per group, so one group's name never opens another's. */
const groupKey = (deps: EventDeps, groupId: string): Uint8Array =>
  deps.crypto.serverKey(`group:${groupId}`, 'email')

/**
 * The name, however it happens to be stored.
 *
 * Groups made before the key changed are still under the owner's data key, and there is no
 * migration that could reach them — the server cannot decrypt with a key it never holds. So the
 * owner's key is tried second, and when it works the row is rewritten under the group key. The
 * group repairs itself the first time its owner looks at it, and until then a member sees a
 * placeholder rather than an error page.
 */
async function readGroupName(
  deps: EventDeps,
  row: { id: string; name_cipher: Uint8Array | Buffer },
  fallbackKey?: Uint8Array,
): Promise<string> {
  const stored = new Uint8Array(row.name_cipher)
  try {
    return deps.crypto.decryptField(groupKey(deps, row.id), stored, groupAad(row.id))
  } catch {
    if (!fallbackKey) {
      return ''
    }
    const name = (() => {
      try {
        return deps.crypto.decryptField(fallbackKey, stored, groupAad(row.id))
      } catch {
        return ''
      }
    })()
    if (name === '') {
      return ''
    }
    await deps.db.db
      .updateTable('groups')
      .set({
        name_cipher: Buffer.from(
          deps.crypto.encryptField(groupKey(deps, row.id), name, groupAad(row.id)),
        ),
        updated_at: toInstant(),
      })
      .where('id', '=', row.id)
      .execute()
    return name
  }
}

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
        deps.crypto.encryptField(groupKey(deps, groupId), input.name, groupAad(groupId)),
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
      name: await readGroupName(deps, row, input.dataKey),
      role: row.role,
      memberCount: members.length,
      isOwner: row.owner_user_id === input.userId,
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
 * Renames a group.
 *
 * "The family" becomes "Family and the Souto cousins" and nothing else about it changes: the
 * members stay, and so does every event already shared with it. Without this the only way to fix
 * a typo was to build the group again and re-share everything.
 */
export async function renameGroup(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string; name: string },
): Promise<void> {
  await requireOrganiser(deps, input.groupId, input.actorUserId)
  await deps.db.db
    .updateTable('groups')
    .set({
      name_cipher: Buffer.from(
        deps.crypto.encryptField(groupKey(deps, input.groupId), input.name, groupAad(input.groupId)),
      ),
      updated_at: toInstant(),
    })
    .where('id', '=', input.groupId)
    .where('status', '=', 'ACTIVE')
    .execute()
}

/**
 * Deletes a group, and with it the access every event granted through it.
 *
 * Marked inactive rather than erased, like a departed member: past assignments still resolve to
 * the people who held them. The access rows are revoked outright, though — a group that no longer
 * exists must not still be opening events, which is the whole reason somebody deletes one.
 *
 * The owner alone, not any organiser. Deleting is the one action nobody can undo from the
 * interface, and an organiser was trusted to add people rather than to dissolve the circle.
 */
export async function deleteGroup(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string },
): Promise<void> {
  const group = await deps.db.db
    .selectFrom('groups')
    .select('owner_user_id')
    .where('id', '=', input.groupId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!group) {
    throw notFound()
  }
  if (group.owner_user_id !== input.actorUserId) {
    throw forbidden('groups.error.ownerOnly')
  }

  // Stamped rather than deleted, which is how every other revocation in the schema reads and
  // what keeps a record of the access having existed.
  await deps.db.db
    .updateTable('event_access')
    .set({ revoked_at: toInstant() })
    .where('subject_kind', '=', 'GROUP')
    .where('subject_id', '=', input.groupId)
    .where('revoked_at', 'is', null)
    .execute()

  await deps.db.db
    .updateTable('groups')
    .set({ status: 'ARCHIVED', updated_at: toInstant() })
    .where('id', '=', input.groupId)
    .execute()
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

/**
 * Who is in a group, by name rather than by identifier.
 *
 * The address is included, because a list of UUIDs is not a list of people and the owner added
 * every one of them by typing exactly this. Members see each other: a group is a circle that
 * already shares events, and hiding the addresses would leave an owner unable to tell which of
 * two accounts belonging to the same person they invited.
 */
export async function listMembers(
  deps: EventDeps,
  input: { groupId: string; actorUserId: string },
): Promise<{ userId: string; role: string; email: string; isSelf: boolean }[]> {
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
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .select(['group_members.user_id', 'group_members.role', 'users.email_cipher'])
    .where('group_members.group_id', '=', input.groupId)
    .where('group_members.status', '=', 'ACTIVE')
    .execute()

  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    // Decrypted here rather than through the accounts module, which wants a mailer and a
    // configuration to do the same two lines. The key is derived per user for exactly this.
    email: deps.crypto.decryptField(
      deps.crypto.serverKey(row.user_id, 'email'),
      new Uint8Array(row.email_cipher),
      { table: 'users', column: 'email_cipher', rowId: row.user_id },
    ),
    isSelf: row.user_id === input.actorUserId,
  }))
}
