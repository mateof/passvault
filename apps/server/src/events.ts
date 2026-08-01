import {
  SLOT_CREATOR,
  SLOT_EVENT_PASSWORD,
  addKeySlot,
  addPasswordSlot,
  createDataKey,
  emptyEnvelope,
  hasSlot,
  isKeyMismatch,
  openSealedEnvelope,
  sealEnvelope,
  unlockWithKey,
  unlockWithPassword,
  type Argon2Params,
  type KeyEnvelope,
} from '@passvault/crypto'
import { newId, toInstant, type DatabaseHandle } from '@passvault/db'
import type { AssignmentMode } from '@passvault/tkpak'
import { mediaTypeOf } from './blobs.js'
import type { CryptoContext } from './crypto-context.js'
import { badRequest, forbidden, notFound, unauthorized } from './errors.js'
import * as repo from './repository.js'
import type { VaultCache } from './vault.js'

/**
 * Event keys, and what an event password actually buys.
 *
 * Every event has its own data key, wrapped in a small envelope with up to three slots:
 *
 *   * **creator** — wrapped by the creator's own data key, so they never retype anything.
 *   * **event-password** — present only when the creator set one. Derived with Argon2id.
 *   * **server** — present only when the creator did *not* set one, wrapped by a key derived
 *     from the master key.
 *
 * The last two are mutually exclusive, and that is the whole point. Without a password the
 * server has to be able to decrypt, because members expect to open the event and there is no
 * secret they hold that could unwrap it — so the operator can read those tickets. Setting a
 * password removes the server slot, and from that moment the barcodes are unreadable to the
 * operator, to a database thief, and to anyone the password was not given to.
 *
 * So the password is not a gate in front of data the server already holds in the clear. It
 * changes who can decrypt at all. That is what makes it worth the friction of telling your
 * friends a password over a messaging app, and it is stated in docs/security.md so nobody
 * assumes a password-less event is private from whoever runs the instance.
 */
export const SLOT_SERVER = 'server'

export interface EventDeps {
  db: DatabaseHandle
  crypto: CryptoContext
  vaults: VaultCache
  argon2Params?: Argon2Params
}

export interface CreateEventInput {
  /**
   * The identifier to create it under, when it already has one.
   *
   * A phone creates events offline and signs a log of operations against that id. Publishing one
   * has to keep it: an id minted here would orphan every operation the device has already signed
   * and every ticket that refers to them.
   */
  eventId?: string
  creatorUserId: string
  creatorDataKey: Uint8Array
  name: string
  venue?: string
  notes?: string
  startsAt?: string
  timeZone?: string
  defaultAssignmentMode?: AssignmentMode
  /** Omit for an event the server can read; set it to take the event out of the operator's reach. */
  password?: string
  icon?: string
  colour?: string
}

/**
 * The icons and colours an event may carry.
 *
 * A closed set, checked here rather than trusted from the client, because these end up in a
 * class name. An open string would be a small injection surface for no benefit — the value of a
 * mark is that a concert is always the same shape, which a free-text field destroys anyway.
 */
export const EVENT_ICONS = [
  'concert',
  'football',
  'theatre',
  'cinema',
  'travel',
  'museum',
  'party',
  'other',
] as const

export const EVENT_COLOURS = [
  'violet',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
] as const

export interface CreatedEvent {
  eventId: string
  eventKey: Uint8Array
  passwordProtected: boolean
}

export async function createEvent(deps: EventDeps, input: CreateEventInput): Promise<CreatedEvent> {
  const eventId = input.eventId ?? newId()
  const eventKey = createDataKey()

  let envelope: KeyEnvelope = addKeySlot(
    emptyEnvelope(),
    SLOT_CREATOR,
    eventKey,
    input.creatorDataKey,
  )
  if (input.password) {
    envelope = await addPasswordSlot(
      envelope,
      SLOT_EVENT_PASSWORD,
      eventKey,
      input.password,
      deps.argon2Params,
    )
  } else {
    envelope = addKeySlot(envelope, SLOT_SERVER, eventKey, serverEventKey(deps, eventId))
  }

  const now = toInstant()
  await deps.db.db
    .insertInto('events')
    .values({
      id: eventId,
      creator_user_id: input.creatorUserId,
      name_cipher: Buffer.from(
        deps.crypto.encryptField(eventKey, input.name, field(eventId, 'name_cipher')),
      ),
      venue_cipher: input.venue
        ? Buffer.from(
            deps.crypto.encryptField(eventKey, input.venue, field(eventId, 'venue_cipher')),
          )
        : null,
      notes_cipher: input.notes
        ? Buffer.from(
            deps.crypto.encryptField(eventKey, input.notes, field(eventId, 'notes_cipher')),
          )
        : null,
      // Plaintext: the wallet sorts and filters by it, and a start time reveals far less than
      // the barcode it belongs to.
      starts_at: input.startsAt ?? null,
      time_zone: input.timeZone ?? null,
      default_assignment_mode: input.defaultAssignmentMode ?? 'OPEN',
      password_protected: input.password ? 1 : 0,
      // In the clear, and only from the closed set: a category and a colour, so a wallet can
      // draw its list before any event key is open.
      icon: allowed(EVENT_ICONS, input.icon),
      colour: allowed(EVENT_COLOURS, input.colour),
      image_blob_id: null,
      sealed_key_envelope: Buffer.from(sealEnvelope(envelope, deps.crypto.masterKey)),
      authority_device_id: null,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    })
    .execute()

  await repo.recordAudit(deps.db, {
    actorUserId: input.creatorUserId,
    action: input.password ? 'event.created.password-protected' : 'event.created',
    subjectKind: 'event',
    subjectId: eventId,
  })

  return { eventId, eventKey, passwordProtected: Boolean(input.password) }
}

/**
 * A key the server holds for events with no password.
 *
 * Derived per event so one leaked event key does not open the rest, and never stored — it is
 * recomputed from the master key whenever it is needed.
 */
function serverEventKey(deps: EventDeps, eventId: string): Uint8Array {
  return deps.crypto.serverKey(`event:${eventId}`, 'email')
}

const field = (eventId: string, column: string) => ({ table: 'events', column, rowId: eventId })

/** Keeps a value only if it is one this version knows, so nothing arbitrary reaches a class name. */
const allowed = (set: readonly string[], value: string | undefined): string | null =>
  value && set.includes(value) ? value : null

export interface EventRow {
  id: string
  creator_user_id: string
  password_protected: number
  status: string
  sealed_key_envelope: Uint8Array
  starts_at: string | null
  time_zone: string | null
  default_assignment_mode: string
  name_cipher: Uint8Array
  venue_cipher: Uint8Array | null
  notes_cipher: Uint8Array | null
  icon: string | null
  colour: string | null
  image_blob_id: string | null
}

export async function findEvent(deps: EventDeps, eventId: string): Promise<EventRow | undefined> {
  const row = await deps.db.db
    .selectFrom('events')
    .selectAll()
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!row) {
    return undefined
  }
  return {
    ...row,
    sealed_key_envelope: new Uint8Array(row.sealed_key_envelope),
    name_cipher: new Uint8Array(row.name_cipher),
    venue_cipher: row.venue_cipher ? new Uint8Array(row.venue_cipher) : null,
    notes_cipher: row.notes_cipher ? new Uint8Array(row.notes_cipher) : null,
  }
}

/** Whether a user may see an event at all, through the group and individual grants. */
/**
 * Every event a user can reach, newest first.
 *
 * Added when the web client turned out to have no way of showing somebody their own events:
 * the API could create one and fetch one by id, and nothing could answer "which ones are
 * mine". The client had been working around it by remembering ids for the length of a
 * session, which is not a list — it is a list of what you happened to do since you signed in.
 *
 * The three sources of access are the same three `hasAccess` checks one at a time: created by
 * you, granted to you, or granted to a group you are an active member of. Combined here in one
 * query rather than by checking every event, which would be a scan of the whole table per
 * request.
 */
export async function listEventsForUser(
  deps: EventDeps,
  userId: string,
): Promise<{ id: string; createdAt: string; creatorUserId: string; passwordProtected: boolean }[]> {
  const created = await deps.db.db
    .selectFrom('events')
    .select(['id', 'created_at', 'creator_user_id', 'password_protected'])
    .where('creator_user_id', '=', userId)
    .execute()

  const granted = await deps.db.db
    .selectFrom('events')
    .innerJoin('event_access', 'event_access.event_id', 'events.id')
    .select([
      'events.id',
      'events.created_at',
      'events.creator_user_id',
      'events.password_protected',
    ])
    .where('event_access.subject_kind', '=', 'USER')
    .where('event_access.subject_id', '=', userId)
    .where('event_access.revoked_at', 'is', null)
    .execute()

  const throughGroup = await deps.db.db
    .selectFrom('events')
    .innerJoin('event_access', 'event_access.event_id', 'events.id')
    .innerJoin('group_members', 'group_members.group_id', 'event_access.subject_id')
    .select([
      'events.id',
      'events.created_at',
      'events.creator_user_id',
      'events.password_protected',
    ])
    .where('event_access.subject_kind', '=', 'GROUP')
    .where('event_access.revoked_at', 'is', null)
    .where('group_members.user_id', '=', userId)
    .where('group_members.status', '=', 'ACTIVE')
    // Offered to the circle is not the same as held by the person. The same rule `hasAccess`
    // applies, applied here too — a listing that showed what opening refuses would be a wallet
    // full of events that answer "not yours" when tapped.
    .innerJoin('event_invitations', (join) =>
      join
        .onRef('event_invitations.event_id', '=', 'events.id')
        .on('event_invitations.user_id', '=', userId)
        .on('event_invitations.state', '=', 'ACCEPTED'),
    )
    .execute()

  const byId = new Map<string, (typeof created)[number]>()
  for (const row of [...created, ...granted, ...throughGroup]) {
    // A user can reach the same event three ways; it appears once.
    byId.set(row.id, row)
  }

  return (
    [...byId.values()]
      // Fixed-width instants, so a string comparison is a chronological one on every engine.
      .sort((left, right) => (left.created_at < right.created_at ? 1 : -1))
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        creatorUserId: row.creator_user_id,
        passwordProtected: row.password_protected === 1,
      }))
  )
}

export async function hasAccess(
  deps: EventDeps,
  eventId: string,
  userId: string,
): Promise<boolean> {
  const event = await findEvent(deps, eventId)
  if (!event) {
    return false
  }
  if (event.creator_user_id === userId) {
    return true
  }
  const direct = await deps.db.db
    .selectFrom('event_access')
    .select('id')
    .where('event_id', '=', eventId)
    .where('subject_kind', '=', 'USER')
    .where('subject_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (direct) {
    return true
  }
  // Group access, joined through active memberships only: a member who was made inactive keeps
  // their row — so history still resolves — but loses access from that moment.
  const throughGroup = await deps.db.db
    .selectFrom('event_access')
    .innerJoin('group_members', 'group_members.group_id', 'event_access.subject_id')
    .select('event_access.id')
    .where('event_access.event_id', '=', eventId)
    .where('event_access.subject_kind', '=', 'GROUP')
    .where('event_access.revoked_at', 'is', null)
    .where('group_members.user_id', '=', userId)
    .where('group_members.status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!throughGroup) {
    return false
  }

  // Sharing with a group offers the event to everybody in it; holding it is still each person's
  // own decision. Without this, adding somebody to a group would put events in their wallet that
  // they never agreed to hold — which is precisely what invitations exist to stop.
  const accepted = await deps.db.db
    .selectFrom('event_invitations')
    .select('id')
    .where('event_id', '=', eventId)
    .where('user_id', '=', userId)
    .where('state', '=', 'ACCEPTED')
    .executeTakeFirst()
  return accepted !== undefined
}

export async function grantAccess(
  deps: EventDeps,
  input: {
    eventId: string
    actorUserId: string
    subjectKind: 'GROUP' | 'USER'
    subjectId: string
    role?: 'ORGANISER' | 'MEMBER'
  },
): Promise<void> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }
  // Granting the same access twice says the same thing, so it leaves one row rather than a pile
  // of them — which is what a list of who can see this would otherwise show.
  const existing = await deps.db.db
    .selectFrom('event_access')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('subject_kind', '=', input.subjectKind)
    .where('subject_id', '=', input.subjectId)
    .executeTakeFirst()
  if (existing) {
    await deps.db.db
      .updateTable('event_access')
      .set({ role: input.role ?? 'MEMBER', revoked_at: null, granted_at: toInstant() })
      .where('id', '=', existing.id)
      .execute()
  } else {
    await deps.db.db
      .insertInto('event_access')
      .values({
        id: newId(),
        event_id: input.eventId,
        subject_kind: input.subjectKind,
        subject_id: input.subjectId,
        role: input.role ?? 'MEMBER',
        granted_by: input.actorUserId,
        granted_at: toInstant(),
        revoked_at: null,
      })
      .execute()
  }
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'event.access.granted',
    subjectKind: 'event',
    subjectId: input.eventId,
  })
}

/**
 * Who an event is shared with.
 *
 * Sharing was write-only: an organiser could grant access and had no way of seeing what they had
 * granted, so "did I remember to share this with the family?" could only be answered by sharing
 * again. Groups come back by name and people by address, because a column of identifiers is not
 * an answer to that question.
 */
export interface EventAccessEntry {
  subjectKind: 'GROUP' | 'USER'
  subjectId: string
  role: 'ORGANISER' | 'MEMBER'
  /** The group's name or the person's address. Empty when the subject no longer exists. */
  label: string
  grantedAt: string
  /** Offered and unanswered. Holding an event is the recipient's decision, so this is a state. */
  pending: boolean
}

export async function listAccess(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string },
): Promise<EventAccessEntry[]> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    // Who else an event was shared with is the creator's business. A member knowing they can see
    // it does not entitle them to the guest list.
    throw forbidden('event.error.notCreator')
  }

  const rows = await deps.db.db
    .selectFrom('event_access')
    .select(['subject_kind', 'subject_id', 'role', 'granted_at'])
    .where('event_id', '=', input.eventId)
    .where('revoked_at', 'is', null)
    .orderBy('granted_at', 'asc')
    .execute()

  const entries: EventAccessEntry[] = []
  for (const row of rows) {
    entries.push({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      role: row.role,
      label:
        row.subject_kind === 'GROUP'
          ? await groupNameFor(deps, row.subject_id)
          : await userEmailFor(deps, row.subject_id),
      grantedAt: row.granted_at,
      pending: false,
    })
  }

  // People who have been offered it and have not answered. Without these the creator's list is
  // a list of everybody who said yes, which reads as "I never shared it with Ana" rather than
  // "Ana has not answered".
  const pending = await deps.db.db
    .selectFrom('event_invitations')
    .select(['user_id', 'created_at'])
    .where('event_id', '=', input.eventId)
    .where('state', '=', 'PENDING')
    .execute()

  for (const row of pending) {
    if (entries.some((entry) => entry.subjectKind === 'USER' && entry.subjectId === row.user_id)) {
      continue
    }
    entries.push({
      subjectKind: 'USER',
      subjectId: row.user_id,
      role: 'MEMBER',
      label: await userEmailFor(deps, row.user_id),
      grantedAt: row.created_at,
      pending: true,
    })
  }

  return entries
}

async function groupNameFor(deps: EventDeps, groupId: string): Promise<string> {
  const row = await deps.db.db
    .selectFrom('groups')
    .select(['id', 'name_cipher'])
    .where('id', '=', groupId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst()
  if (!row) {
    return ''
  }
  try {
    return deps.crypto.decryptField(
      deps.crypto.serverKey(`group:${groupId}`, 'email'),
      new Uint8Array(row.name_cipher),
      { table: 'groups', column: 'name_cipher', rowId: groupId },
    )
  } catch {
    // A group still stored under its owner's key, which the server cannot open. Its name appears
    // the next time its owner lists their groups; an empty label beats a failed request.
    return ''
  }
}

async function userEmailFor(deps: EventDeps, userId: string): Promise<string> {
  const row = await deps.db.db
    .selectFrom('users')
    .select(['id', 'email_cipher'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!row) {
    return ''
  }
  return deps.crypto.decryptField(
    deps.crypto.serverKey(userId, 'email'),
    new Uint8Array(row.email_cipher),
    { table: 'users', column: 'email_cipher', rowId: userId },
  )
}

/**
 * Revokes access.
 *
 * Worth being precise about what this does, because the name promises more than it can deliver:
 * it stops the subject seeing the event from now on. It does not recall a `.tkpak` they already
 * imported or a screenshot they took. See docs/threat-model.md.
 */
export async function revokeAccess(
  deps: EventDeps,
  input: { eventId: string; actorUserId: string; subjectKind: 'GROUP' | 'USER'; subjectId: string },
): Promise<void> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }
  await deps.db.db
    .updateTable('event_access')
    .set({ revoked_at: toInstant() })
    .where('event_id', '=', input.eventId)
    .where('subject_kind', '=', input.subjectKind)
    .where('subject_id', '=', input.subjectId)
    .execute()
}

export interface OpenEventInput {
  eventId: string
  sessionId: string
  userId: string
  /** Required for a password-protected event the caller has not already opened this session. */
  password?: string
}

/**
 * Produces the event's data key for a caller who is entitled to it.
 *
 * The order of attempts matters. A cached key first, so a member types the password once per
 * session; then the creator slot, which needs no password; then the password slot; then the
 * server slot, which exists only for events with no password.
 */
export async function openEventKey(deps: EventDeps, input: OpenEventInput): Promise<Uint8Array> {
  const cached = deps.vaults.getEventKey(input.sessionId, input.eventId)
  if (cached) {
    return cached
  }

  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (!(await hasAccess(deps, input.eventId, input.userId))) {
    throw forbidden()
  }

  const envelope = openSealedEnvelope(event.sealed_key_envelope, deps.crypto.masterKey)

  if (event.creator_user_id === input.userId) {
    const vault = deps.vaults.require(input.sessionId)
    const key = unlockWithKey(envelope, SLOT_CREATOR, vault.dataKey)
    deps.vaults.unlockEvent(input.sessionId, input.eventId, key)
    return key
  }

  if (event.password_protected === 1) {
    if (!input.password) {
      throw unauthorized('event.passwordRequired')
    }
    try {
      const key = await unlockWithPassword(envelope, SLOT_EVENT_PASSWORD, input.password)
      deps.vaults.unlockEvent(input.sessionId, input.eventId, key)
      return key
    } catch (error) {
      if (isKeyMismatch(error)) {
        throw unauthorized('event.error.wrongPassword')
      }
      throw error
    }
  }

  if (!hasSlot(envelope, SLOT_SERVER)) {
    // An event with neither a password slot the caller can use nor a server slot: only the
    // creator can open it. Reported rather than silently returning nothing.
    throw forbidden()
  }
  const key = unlockWithKey(envelope, SLOT_SERVER, serverEventKey(deps, input.eventId))
  deps.vaults.unlockEvent(input.sessionId, input.eventId, key)
  return key
}

export interface EventProjection {
  id: string
  name: string
  venue: string | null
  notes: string | null
  startsAt: string | null
  timeZone: string | null
  defaultAssignmentMode: string
  /** The mark it is recognised by. Plaintext, so a list can be drawn before any key is open. */
  icon: string | null
  colour: string | null
  /** Whether it has a picture, not the picture: twelve events must not mean twelve images. */
  hasImage: boolean
  passwordProtected: boolean
  isCreator: boolean
  /** True when the server can decrypt this event on its own. Shown to the user, not hidden. */
  readableByServer: boolean
}

export function projectEvent(
  deps: EventDeps,
  event: EventRow,
  eventKey: Uint8Array,
  viewerUserId: string,
): EventProjection {
  return {
    id: event.id,
    name: deps.crypto.decryptField(eventKey, event.name_cipher, field(event.id, 'name_cipher')),
    venue: deps.crypto.decryptOptional(
      eventKey,
      event.venue_cipher,
      field(event.id, 'venue_cipher'),
    ),
    notes: deps.crypto.decryptOptional(
      eventKey,
      event.notes_cipher,
      field(event.id, 'notes_cipher'),
    ),
    startsAt: event.starts_at,
    timeZone: event.time_zone,
    defaultAssignmentMode: event.default_assignment_mode,
    icon: event.icon,
    colour: event.colour,
    // Whether there is one, not the picture itself: it is fetched separately, and a list of
    // twelve events must not carry twelve images inside one JSON response.
    hasImage: event.image_blob_id !== null,
    passwordProtected: event.password_protected === 1,
    isCreator: event.creator_user_id === viewerUserId,
    readableByServer: event.password_protected === 0,
  }
}

/**
 * Changes the mark an event is recognised by.
 *
 * Creator only. Not because a colour is dangerous, but because an event shared with a group is
 * one thing everybody sees: a member repainting it changes what it looks like for the twelve
 * people it was shared with, and none of them asked.
 */
export async function setEventAppearance(
  deps: EventDeps,
  input: {
    eventId: string
    actorUserId: string
    icon?: string
    colour?: string
    imageBlobId?: string | null
  },
): Promise<void> {
  const event = await findEvent(deps, input.eventId)
  if (!event) {
    throw notFound()
  }
  if (event.creator_user_id !== input.actorUserId) {
    throw forbidden()
  }

  const changes: Record<string, string | null> = {}
  if (input.icon !== undefined) {
    changes.icon = allowed(EVENT_ICONS, input.icon)
  }
  if (input.colour !== undefined) {
    changes.colour = allowed(EVENT_COLOURS, input.colour)
  }
  if (input.imageBlobId !== undefined) {
    changes.image_blob_id = input.imageBlobId
  }
  if (Object.keys(changes).length === 0) {
    return
  }

  await deps.db.db
    .updateTable('events')
    .set({ ...changes, updated_at: toInstant() })
    .where('id', '=', input.eventId)
    .execute()
}

/**
 * Gives an event a cover from the document that was just imported, if it has none.
 *
 * Only when it has none, and only for the first import. Overwriting a picture the organiser
 * chose because they later imported another PDF would be the software deciding it knows better,
 * and a poster is exactly the sort of thing people choose deliberately.
 *
 * Failure is swallowed on purpose: the cover is a nicety and the import is the point. A PDF that
 * cannot be rendered — an installation without the optional canvas packages, a damaged page —
 * must not turn a successful import into an error.
 */
export async function suggestEventCover(
  deps: EventDeps,
  input: { eventId: string; imageBlobId: string },
): Promise<boolean> {
  const event = await findEvent(deps, input.eventId)
  if (!event || event.image_blob_id !== null) {
    return false
  }
  await deps.db.db
    .updateTable('events')
    .set({ image_blob_id: input.imageBlobId, updated_at: toInstant() })
    .where('id', '=', input.eventId)
    .where('image_blob_id', 'is', null)
    .execute()
  return true
}

export interface EventDocument {
  id: string
  batchId: string
  mediaType: string
  pageCount: number | null
  byteCount: number | null
  createdAt: string
  /** The tickets this import produced, so a document is not a file with no relation to anything. */
  ticketIds: string[]
}

/**
 * The documents this event's tickets were split out of.
 *
 * The file the user was actually sent, kept whole and listed in its own right. It holds the pages
 * ingestion left out — the map, the terms, the instructions — which are exactly the pages the
 * rule that makes the split right is guaranteed to drop. And when a turnstile disagrees with the
 * app, the original is what settles it.
 *
 * The whole file, never the page a ticket was cut from. Both are blobs of this event, and a
 * listing that took every blob would call each ticket's own page an original document — which is
 * why this asks the imports what they were given rather than asking the disk what is on it. A
 * document uploaded whole by a phone is recorded as an import for exactly that reason.
 */
export async function listEventDocuments(
  deps: EventDeps,
  eventId: string,
): Promise<EventDocument[]> {
  const batches = await deps.db.db
    .selectFrom('ingest_batches')
    .innerJoin('blobs', 'blobs.id', 'ingest_batches.source_blob_id')
    .select([
      'ingest_batches.id as batch_id',
      'ingest_batches.source_blob_id as blob_id',
      'ingest_batches.page_count',
      'ingest_batches.created_at',
      'blobs.media_type',
      'blobs.byte_length',
    ])
    .where('ingest_batches.event_id', '=', eventId)
    .where('ingest_batches.state', '=', 'CONFIRMED')
    .orderBy('ingest_batches.created_at', 'asc')
    .execute()

  const tickets = await deps.db.db
    .selectFrom('tickets')
    .select(['id', 'source_batch_id'])
    .where('event_id', '=', eventId)
    .where('status', '=', 'ACTIVE')
    .execute()

  return batches.map((batch) => ({
    id: String(batch.blob_id),
    batchId: batch.batch_id,
    // The media type as the wire spells it. The column says `PDF`; a client reading that and
    // looking for `pdf` concluded every document it was told about was a pass.
    mediaType: mediaTypeOf(batch.media_type) ?? batch.media_type,
    pageCount: batch.page_count,
    byteCount: batch.byte_length,
    createdAt: batch.created_at,
    ticketIds: tickets
      .filter((ticket) => ticket.source_batch_id === batch.batch_id)
      .map((ticket) => ticket.id),
  }))
}

export async function requireEventPasswordSet(deps: EventDeps, eventId: string): Promise<void> {
  const event = await findEvent(deps, eventId)
  if (!event) {
    throw notFound()
  }
  if (event.password_protected === 0) {
    throw badRequest('event.warning.passwordLost')
  }
}
