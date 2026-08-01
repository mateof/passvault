import { toInstant } from '@passvault/db'
import { badRequest, notFound } from './errors.js'
import type { EventDeps } from './events.js'

/**
 * Handles: a public name a person can be found by.
 *
 * Every other thing this installation knows about somebody is encrypted, and a handle is
 * deliberately not. That is what it is for. An address is how you reach a person and is theirs to
 * give out; a handle is how a third party names them — "share it with ana" — and a name nobody can
 * look up is not a name, it is a secret with extra steps.
 *
 * Nobody is given one. An account without a handle works exactly as before and is shared with by
 * address, which is what every account had to do until now.
 *
 * The rules are narrow on purpose. Lower case, digits, dot, dash and underscore, between three and
 * thirty-two characters: enough for a name, too little for a sentence, and nothing that could be
 * mistaken for an address — because a field that accepts both would let somebody claim the handle
 * `ana@example.org` and be handed shares meant for the person at that address.
 */
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/

export const normaliseHandle = (value: string): string => value.trim().toLowerCase()

export function assertHandle(value: string): string {
  const handle = normaliseHandle(value)
  if (!HANDLE.test(handle)) {
    throw badRequest('handle.error.invalid')
  }
  return handle
}

/**
 * Claims a handle for an account.
 *
 * Checked and then written, which is a race this deliberately does not try to win in software:
 * the unique index is what actually decides, and the check exists so the ordinary case produces a
 * sentence rather than a constraint violation. A lost race arrives as the same sentence.
 */
export async function setHandle(
  deps: EventDeps,
  input: { userId: string; handle: string },
): Promise<{ handle: string }> {
  const handle = assertHandle(input.handle)

  const taken = await deps.db.db
    .selectFrom('users')
    .select('id')
    .where('handle', '=', handle)
    .executeTakeFirst()
  if (taken && taken.id !== input.userId) {
    throw badRequest('handle.error.taken')
  }

  try {
    await deps.db.db
      .updateTable('users')
      .set({ handle, updated_at: toInstant() })
      .where('id', '=', input.userId)
      .execute()
  } catch {
    // The index refused it, which means somebody claimed it between the check and the write.
    throw badRequest('handle.error.taken')
  }

  return { handle }
}

export interface DirectoryEntry {
  userId: string
  handle: string | null
  /** Only ever the address that was searched for. Never returned for a search by handle. */
  email?: string
}

/**
 * Finds one person, by handle or by address.
 *
 * Exact matches only, and one at a time. A prefix search over an installation's accounts would be
 * a way to enumerate everybody who has one, and knowing who else is here is not something a
 * member is owed — the point of this endpoint is to confirm that a name somebody was *given*
 * belongs to an account, not to browse.
 *
 * An address search never returns a handle and a handle search never returns an address. Either
 * would turn "confirm this person" into "map these two identities onto each other".
 */
export async function findPerson(
  deps: EventDeps & { emailIndex: (email: string) => string },
  input: { handle?: string; email?: string },
): Promise<DirectoryEntry | undefined> {
  if (input.handle) {
    const row = await deps.db.db
      .selectFrom('users')
      .select(['id', 'handle', 'status'])
      .where('handle', '=', normaliseHandle(input.handle))
      .executeTakeFirst()
    return row && row.status === 'ACTIVE' ? { userId: row.id, handle: row.handle } : undefined
  }

  if (input.email) {
    const row = await deps.db.db
      .selectFrom('users')
      .select(['id', 'status'])
      .where('email_key', '=', deps.emailIndex(input.email))
      .executeTakeFirst()
    return row && row.status === 'ACTIVE'
      ? { userId: row.id, handle: null, email: input.email }
      : undefined
  }

  return undefined
}

/**
 * Resolves whichever handle a caller used into the identifier the tables store.
 *
 * Refused rather than ignored when nobody matches. A share that goes nowhere is discovered when a
 * friend never receives their ticket, which is far too late to be worth the tidiness of accepting
 * every input.
 */
export async function requirePerson(
  deps: EventDeps & { emailIndex: (email: string) => string },
  input: { userId?: string; handle?: string; email?: string },
): Promise<string> {
  if (input.userId) {
    const row = await deps.db.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', input.userId)
      .executeTakeFirst()
    if (!row) {
      throw notFound()
    }
    return row.id
  }

  const found = await findPerson(deps, input)
  if (!found) {
    throw badRequest('groups.error.unknownUser')
  }
  return found.userId
}
