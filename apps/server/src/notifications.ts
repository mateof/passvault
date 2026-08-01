import { newId, toInstant } from '@passvault/db'
import type { EventDeps } from './events.js'

/**
 * What happened that somebody should be told about.
 *
 * A table rather than an email. This installation may have no mail server at all — a NAS behind a
 * tunnel usually does not — and the two places a user actually looks are the app and the web, so a
 * notice that only exists as an email is a notice most people never see.
 *
 * The stored form is a kind and a payload, never a sentence. The wording lives in the message
 * catalogue and is rendered in the reader's language at the moment they read it, which is also why
 * a notice written today still reads correctly in a language added next year.
 *
 * The payload is ciphertext under the recipient's own data key. It names an event and the person
 * who sent it, and those are exactly the things the rest of this schema takes trouble to encrypt.
 * The consequence is deliberate and worth stating: notices can only be read while the vault is
 * open, the same as everything else of value here.
 */
export type NoticeKind = 'event.invited' | 'event.accepted' | 'event.declined' | 'ticket.assigned'

const noticeAad = (id: string) => ({
  table: 'notifications',
  column: 'payload_cipher',
  rowId: id,
})

export interface Notice {
  id: string
  kind: NoticeKind
  payload: Record<string, unknown>
  createdAt: string
  read: boolean
}

/**
 * Writes one.
 *
 * Takes the recipient's data key, which means the caller has to have it — and the caller is
 * usually somebody else's request. That is why an invitation is written while the *inviter* is
 * present using the server's own key for the event, and the recipient's copy is encrypted with a
 * key derived for them: see `recipientKey`.
 */
export async function notify(
  deps: EventDeps,
  input: {
    userId: string
    kind: NoticeKind
    payload: Record<string, unknown>
  },
): Promise<void> {
  const id = newId()
  await deps.db.db
    .insertInto('notifications')
    .values({
      id,
      user_id: input.userId,
      kind: input.kind,
      payload_cipher: Buffer.from(
        deps.crypto.encryptField(
          recipientKey(deps, input.userId),
          JSON.stringify(input.payload),
          noticeAad(id),
        ),
      ),
      created_at: toInstant(),
      read_at: null,
    })
    .execute()
}

/**
 * The key a notice is sealed with.
 *
 * Derived per recipient from the master key rather than taken from their vault, because the
 * person who causes a notice is almost never the person who receives it: an invitation is written
 * while the inviter is signed in, and the recipient's vault is not open — may never have been
 * opened on this server. A notice they could not be given until they happened to be present would
 * not be a notification system.
 *
 * The trade is the same one a password-less event already makes and docs/security.md already
 * states: the operator can read a notice. What a notice holds is an event name and who sent it,
 * not a barcode.
 */
const recipientKey = (deps: EventDeps, userId: string): Uint8Array =>
  deps.crypto.serverKey(`notice:${userId}`, 'email')

export async function listNotices(
  deps: EventDeps,
  input: { userId: string; unreadOnly?: boolean },
): Promise<Notice[]> {
  let query = deps.db.db
    .selectFrom('notifications')
    .select(['id', 'kind', 'payload_cipher', 'created_at', 'read_at'])
    .where('user_id', '=', input.userId)
  if (input.unreadOnly) {
    query = query.where('read_at', 'is', null)
  }
  const rows = await query.orderBy('created_at', 'desc').limit(100).execute()

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as NoticeKind,
    payload: parse(deps, input.userId, row.id, new Uint8Array(row.payload_cipher)),
    createdAt: row.created_at,
    read: row.read_at !== null,
  }))
}

/** A notice that cannot be decrypted is shown as an empty one rather than failing the whole list. */
function parse(
  deps: EventDeps,
  userId: string,
  id: string,
  stored: Uint8Array,
): Record<string, unknown> {
  try {
    return JSON.parse(deps.crypto.decryptField(recipientKey(deps, userId), stored, noticeAad(id)))
  } catch {
    return {}
  }
}

export async function markRead(
  deps: EventDeps,
  input: { userId: string; noticeId?: string },
): Promise<void> {
  let query = deps.db.db
    .updateTable('notifications')
    .set({ read_at: toInstant() })
    .where('user_id', '=', input.userId)
    .where('read_at', 'is', null)
  if (input.noticeId) {
    query = query.where('id', '=', input.noticeId)
  }
  await query.execute()
}

export async function countUnread(deps: EventDeps, userId: string): Promise<number> {
  const rows = await deps.db.db
    .selectFrom('notifications')
    .select('id')
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .execute()
  return rows.length
}
