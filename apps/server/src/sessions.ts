import { toInstant } from '@passvault/db'
import { forbidden, notFound } from './errors.js'
import type { EventDeps } from './events.js'

/**
 * The sessions open on an account, as something their owner can look at and end.
 *
 * Until now a session was invisible: it existed, it expired eventually, and the only way to end
 * one was to stop using it. That is the wrong shape for the thing that opens a wallet — a phone
 * left in a taxi is exactly the case this has to answer, and "wait for it to expire" is not an
 * answer.
 *
 * What it shows is what the request carried: a user agent, an address, when it was last used.
 * None of it is proof of anything — a user agent is a string a client chooses and an address
 * behind a tunnel is the tunnel's — so it is presented as what it is, a way to recognise which
 * row is the phone in your pocket, and never as a security claim.
 */
export interface SessionSummary {
  id: string
  /** Whether this is the session asking, which must never be presented as just another row. */
  current: boolean
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
}

export async function listSessions(
  deps: EventDeps,
  input: { userId: string; currentSessionId: string },
): Promise<SessionSummary[]> {
  const now = toInstant()
  const rows = await deps.db.db
    .selectFrom('sessions')
    .select([
      'id',
      'user_agent',
      'ip_address',
      'created_at',
      'last_seen_at',
      'hard_expires_at',
      'idle_expires_at',
    ])
    .where('user_id', '=', input.userId)
    .where('revoked_at', 'is', null)
    .where('hard_expires_at', '>', now)
    .orderBy('created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    current: row.id === input.currentSessionId,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    // When the session actually ends, not when the access token next rotates. The access token
    // is short by design and refreshes itself; showing its thirty minutes here would tell every
    // signed-in person their session dies within the hour, which is exactly wrong.
    expiresAt: row.hard_expires_at,
  }))
}

/**
 * Ends one.
 *
 * Ending the current one is allowed and is simply signing out, which is worth permitting rather
 * than special-casing: somebody looking at a list of their sessions and pressing the button next
 * to the one they are using has said something perfectly clear.
 */
export async function revokeSession(
  deps: EventDeps,
  input: { userId: string; sessionId: string },
): Promise<void> {
  const row = await deps.db.db
    .selectFrom('sessions')
    .select(['id', 'user_id'])
    .where('id', '=', input.sessionId)
    .executeTakeFirst()
  if (!row) {
    throw notFound()
  }
  if (row.user_id !== input.userId) {
    throw forbidden()
  }
  await deps.db.db
    .updateTable('sessions')
    .set({ revoked_at: toInstant() })
    .where('id', '=', input.sessionId)
    .execute()
  // The unwrapped data key goes with it. A revoked session that could still decrypt for as long
  // as the process lived would be a revocation in name only.
  deps.vaults.evict(input.sessionId)
}

/** Ends every other one, which is what somebody does after losing a device. */
export async function revokeOtherSessions(
  deps: EventDeps,
  input: { userId: string; keepSessionId: string },
): Promise<number> {
  const rows = await deps.db.db
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', input.userId)
    .where('revoked_at', 'is', null)
    .where('id', '!=', input.keepSessionId)
    .execute()

  if (rows.length === 0) {
    return 0
  }

  await deps.db.db
    .updateTable('sessions')
    .set({ revoked_at: toInstant() })
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .execute()
  for (const row of rows) {
    deps.vaults.evict(row.id)
  }
  return rows.length
}
