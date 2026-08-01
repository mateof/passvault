import { newId, toInstant } from '@passvault/db'
import { badRequest, forbidden, notFound } from './errors.js'
import type { EventDeps } from './events.js'

/**
 * Labels, which are the user's own vocabulary for their wallet.
 *
 * An icon and a colour say what kind of thing an event is; a label says what it is *to you* —
 * "Vigo trips", "work", "Ana's birthday". Two different jobs, which is why this is not an
 * extension of the icon set: the icon list is closed because a concert should look the same in
 * everybody's wallet, and a label is open because nobody else's vocabulary is any of our business.
 *
 * The name is ciphertext under the owner's data key, and the colour is not: a name is user data
 * and a colour is one of eight values that ends up in a class name.
 *
 * Labels belong to a person, not to an event. Sharing an event does not share what its owner
 * calls it — the person you shared with has their own wallet and their own words for it.
 */
export const TAG_COLOURS = [
  'violet',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
] as const

export type TagColour = (typeof TAG_COLOURS)[number]

const tagAad = (tagId: string) => ({ table: 'tags', column: 'name_cipher', rowId: tagId })

export interface Tag {
  id: string
  name: string
  colour: string
  /** How many of this person's events carry it, so a list of labels is not a list of guesses. */
  eventCount: number
}

export async function createTag(
  deps: EventDeps,
  input: { ownerUserId: string; dataKey: Uint8Array; name: string; colour: string },
): Promise<{ tagId: string }> {
  const id = newId()
  await deps.db.db
    .insertInto('tags')
    .values({
      id,
      owner_user_id: input.ownerUserId,
      name_cipher: Buffer.from(deps.crypto.encryptField(input.dataKey, input.name, tagAad(id))),
      colour: colourOf(input.colour),
      created_at: toInstant(),
    })
    .execute()
  return { tagId: id }
}

export async function listTags(
  deps: EventDeps,
  input: { ownerUserId: string; dataKey: Uint8Array },
): Promise<Tag[]> {
  const rows = await deps.db.db
    .selectFrom('tags')
    .select(['id', 'name_cipher', 'colour'])
    .where('owner_user_id', '=', input.ownerUserId)
    .orderBy('created_at', 'asc')
    .execute()

  const used = await deps.db.db.selectFrom('event_tags').select(['tag_id']).execute()

  return rows.map((row) => ({
    id: row.id,
    // A label that cannot be decrypted comes back empty rather than failing the list: the vault
    // may have been reset, and one unreadable name is not a reason for a screen to be an error.
    name: read(deps, input.dataKey, row.id, new Uint8Array(row.name_cipher)),
    colour: row.colour,
    eventCount: used.filter((link) => link.tag_id === row.id).length,
  }))
}

function read(deps: EventDeps, dataKey: Uint8Array, id: string, stored: Uint8Array): string {
  try {
    return deps.crypto.decryptField(dataKey, stored, tagAad(id))
  } catch {
    return ''
  }
}

export async function updateTag(
  deps: EventDeps,
  input: {
    tagId: string
    ownerUserId: string
    dataKey: Uint8Array
    name?: string
    colour?: string
  },
): Promise<void> {
  await requireOwner(deps, input.tagId, input.ownerUserId)
  const changes: Record<string, Buffer | string> = {}
  if (input.name !== undefined) {
    changes.name_cipher = Buffer.from(
      deps.crypto.encryptField(input.dataKey, input.name, tagAad(input.tagId)),
    )
  }
  if (input.colour !== undefined) {
    changes.colour = colourOf(input.colour)
  }
  if (Object.keys(changes).length === 0) {
    return
  }
  await deps.db.db.updateTable('tags').set(changes).where('id', '=', input.tagId).execute()
}

/**
 * Deletes a label, and the links to it.
 *
 * Outright rather than archived, unlike a group: a label is a word somebody chose, it grants
 * nothing and nobody else can see it, so there is no history worth keeping. The links go first
 * because a foreign key pointing at a deleted row is how a wallet stops loading.
 */
export async function deleteTag(
  deps: EventDeps,
  input: { tagId: string; ownerUserId: string },
): Promise<void> {
  await requireOwner(deps, input.tagId, input.ownerUserId)
  await deps.db.db.deleteFrom('event_tags').where('tag_id', '=', input.tagId).execute()
  await deps.db.db.deleteFrom('tags').where('id', '=', input.tagId).execute()
}

export async function setEventTags(
  deps: EventDeps,
  input: { eventId: string; ownerUserId: string; tagIds: string[] },
): Promise<void> {
  const mine = await deps.db.db
    .selectFrom('tags')
    .select('id')
    .where('owner_user_id', '=', input.ownerUserId)
    .execute()
  const allowed = new Set(mine.map((row) => row.id))
  // Somebody else's label cannot be attached to anything. Silently dropping it would be a way to
  // discover which identifiers exist by watching what survives.
  if (input.tagIds.some((tagId) => !allowed.has(tagId))) {
    throw badRequest('tags.error.unknown')
  }

  await deps.db.db
    .deleteFrom('event_tags')
    .where('event_id', '=', input.eventId)
    .where(
      'tag_id',
      'in',
      mine.map((row) => row.id),
    )
    .execute()

  for (const tagId of input.tagIds) {
    await deps.db.db
      .insertInto('event_tags')
      .values({ event_id: input.eventId, tag_id: tagId, created_at: toInstant() })
      .execute()
  }
}

/** Which of this person's labels each event carries, for a whole wallet at once. */
export async function tagsByEvent(
  deps: EventDeps,
  input: { ownerUserId: string },
): Promise<Map<string, string[]>> {
  const rows = await deps.db.db
    .selectFrom('event_tags')
    .innerJoin('tags', 'tags.id', 'event_tags.tag_id')
    .select(['event_tags.event_id', 'event_tags.tag_id'])
    .where('tags.owner_user_id', '=', input.ownerUserId)
    .execute()

  const byEvent = new Map<string, string[]>()
  for (const row of rows) {
    byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row.tag_id])
  }
  return byEvent
}

async function requireOwner(deps: EventDeps, tagId: string, userId: string): Promise<void> {
  const row = await deps.db.db
    .selectFrom('tags')
    .select('owner_user_id')
    .where('id', '=', tagId)
    .executeTakeFirst()
  if (!row) {
    throw notFound()
  }
  if (row.owner_user_id !== userId) {
    throw forbidden()
  }
}

const colourOf = (value: string): string =>
  (TAG_COLOURS as readonly string[]).includes(value) ? value : 'violet'
