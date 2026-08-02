import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { toInstant } from '@passvault/db'
import { verifyPassword } from '@passvault/crypto'
import { badRequest, forbidden, notFound } from './errors.js'
import type { EventDeps } from './events.js'
import * as repo from './repository.js'

/**
 * Deleting an account, and everything that was only ever theirs.
 *
 * Two principles decide what goes and what stays, and they pull in opposite directions:
 *
 *   * **Theirs goes.** The vault keys, the events they created with every ticket, payment and
 *     encrypted file inside, their groups, labels, sessions, credentials and notices. Deleting
 *     an account that leaves the owner's data on disk is not deletion.
 *
 *   * **The shared record stays.** Other people's events hold operations this person's devices
 *     signed — claims, transfers — and that log is the *other* participants' history as much as
 *     it was theirs. Deleting it would corrupt wallets that are none of this account's to
 *     corrupt. So those rows survive with their authorship pointed at nothing: the columns are
 *     nullable precisely so history can outlive its actors.
 *
 * The schema has no cascades, deliberately, so the order below is the dependency graph written
 * out by hand. Every step is idempotent; a crash halfway leaves a partially deleted account that
 * a second call finishes.
 */
export interface DeletionDeps extends EventDeps {
  blobDir: string
}

export async function deleteAccount(deps: DeletionDeps, userId: string): Promise<void> {
  const user = await deps.db.db
    .selectFrom('users')
    .select(['id', 'is_admin'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!user) {
    throw notFound()
  }

  // The last administrator cannot go. Not even by their own hand: an installation nobody can
  // administer is recoverable only by editing the database, and "I deleted my account" is the
  // most ordinary way to arrive there.
  if (user.is_admin === 1) {
    const admins = await deps.db.db
      .selectFrom('users')
      .select('id')
      .where('is_admin', '=', 1)
      .where('status', '=', 'ACTIVE')
      .execute()
    if (admins.length <= 1) {
      throw badRequest('admin.error.lastAdmin')
    }
  }

  // ── Their events, whole ─────────────────────────────────────────────────────
  const events = await deps.db.db
    .selectFrom('events')
    .select('id')
    .where('creator_user_id', '=', userId)
    .execute()

  for (const event of events) {
    await deleteEvent(deps, event.id)
  }

  // ── Their groups, and the doors those groups were opening ──────────────────
  const groups = await deps.db.db
    .selectFrom('groups')
    .select('id')
    .where('owner_user_id', '=', userId)
    .execute()
  for (const group of groups) {
    // Including access to *other* people's events that was granted through this group: the
    // group is gone, so what it opened closes — the same rule deleting a group already follows.
    await deps.db.db
      .deleteFrom('event_access')
      .where('subject_kind', '=', 'GROUP')
      .where('subject_id', '=', group.id)
      .execute()
    await deps.db.db.deleteFrom('group_members').where('group_id', '=', group.id).execute()
    await deps.db.db.deleteFrom('groups').where('id', '=', group.id).execute()
  }

  // ── Their presence in other people's events ─────────────────────────────────
  // Seats they held go back to the pool. Keeping a claimed seat pointed at a deleted account
  // would leave the organiser with a ticket nobody can show and nobody else can take.
  await deps.db.db
    .updateTable('tickets')
    .set({ holder_user_id: null, assignment_state: 'FREE', updated_at: toInstant() })
    .where('holder_user_id', '=', userId)
    .execute()

  await deps.db.db
    .deleteFrom('event_access')
    .where('subject_kind', '=', 'USER')
    .where('subject_id', '=', userId)
    .execute()
  await deps.db.db
    .deleteFrom('event_invitations')
    .where((eb) => eb.or([eb('user_id', '=', userId), eb('invited_by', '=', userId)]))
    .execute()
  await deps.db.db.deleteFrom('claim_requests').where('user_id', '=', userId).execute()

  // The shared log survives with its authorship pointed at nothing. It is the other
  // participants' history as much as it was this account's.
  await deps.db.db
    .updateTable('operations')
    .set({ actor_user_id: null })
    .where('actor_user_id', '=', userId)
    .execute()
  await deps.db.db
    .updateTable('audit_events')
    .set({ actor_user_id: null })
    .where('actor_user_id', '=', userId)
    .execute()

  // Their devices stop being anybody's and stop being trusted, but the rows stay: operations
  // in surviving events reference them, and a signature without its device row is unverifiable.
  await deps.db.db
    .updateTable('devices')
    .set({ user_id: null, status: 'REVOKED' })
    .where('user_id', '=', userId)
    .execute()

  // ── Their vocabulary, groups membership, notices ────────────────────────────
  const tags = await deps.db.db
    .selectFrom('tags')
    .select('id')
    .where('owner_user_id', '=', userId)
    .execute()
  if (tags.length > 0) {
    await deps.db.db
      .deleteFrom('event_tags')
      .where(
        'tag_id',
        'in',
        tags.map((tag) => tag.id),
      )
      .execute()
    await deps.db.db.deleteFrom('tags').where('owner_user_id', '=', userId).execute()
  }
  await deps.db.db.deleteFrom('group_members').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('notifications').where('user_id', '=', userId).execute()

  // ── Their ways in ───────────────────────────────────────────────────────────
  const sessions = await deps.db.db
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', userId)
    .execute()
  for (const session of sessions) {
    // The unwrapped keys go with the rows: a deleted account that can still decrypt for as
    // long as the process lives has not been deleted.
    deps.vaults.evict(session.id)
  }
  await deps.db.db.deleteFrom('sessions').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('webauthn_credentials').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('totp_authenticators').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('oidc_identities').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('email_otp_challenges').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('password_setup_tokens').where('user_id', '=', userId).execute()

  // ── Loose administrative threads ────────────────────────────────────────────
  await deps.db.db.deleteFrom('invitations').where('created_by', '=', userId).execute()
  await deps.db.db
    .updateTable('email_whitelist')
    .set({ added_by: null })
    .where('added_by', '=', userId)
    .execute()
  await deps.db.db
    .updateTable('registration_settings')
    .set({ updated_by: null })
    .where('updated_by', '=', userId)
    .execute()

  // ── The keys, then the account ──────────────────────────────────────────────
  await deps.db.db.deleteFrom('user_keys').where('user_id', '=', userId).execute()
  await deps.db.db.deleteFrom('users').where('id', '=', userId).execute()

  await repo.recordAudit(deps.db, {
    actorUserId: null,
    action: 'account.deleted',
    subjectKind: 'user',
    subjectId: userId,
  })
}

/**
 * One event and everything inside it, including the encrypted files on disk.
 *
 * A blob row without its file is a broken listing; a file without its row is a ciphertext
 * nobody can ever decrypt again but that still occupies somebody's disk. Rows first would risk
 * the second; files are removed as their rows go, and a file already missing is not an error —
 * this function has to be re-runnable over a half-deleted event.
 */
export async function deleteEvent(deps: DeletionDeps, eventId: string): Promise<void> {
  const tickets = await deps.db.db
    .selectFrom('tickets')
    .select('id')
    .where('event_id', '=', eventId)
    .execute()
  if (tickets.length > 0) {
    await deps.db.db
      .deleteFrom('payments')
      .where(
        'ticket_id',
        'in',
        tickets.map((ticket) => ticket.id),
      )
      .execute()
  }
  if (tickets.length > 0) {
    // Claim requests hang off tickets, not off the event directly.
    await deps.db.db
      .deleteFrom('claim_requests')
      .where(
        'ticket_id',
        'in',
        tickets.map((ticket) => ticket.id),
      )
      .execute()
  }
  await deps.db.db.deleteFrom('claim_coupons').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('event_invitations').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('event_tags').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('event_access').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('operations').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('tickets').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('ingest_batches').where('event_id', '=', eventId).execute()

  // The event points at its cover blob, so the pointer has to open before the blobs can go —
  // the one place in this graph where the parent references the child.
  await deps.db.db
    .updateTable('events')
    .set({ image_blob_id: null })
    .where('id', '=', eventId)
    .execute()

  const blobs = await deps.db.db
    .selectFrom('blobs')
    .select(['id', 'storage_path'])
    .where('event_id', '=', eventId)
    .execute()
  for (const blob of blobs) {
    await unlink(resolve(deps.blobDir, blob.storage_path)).catch(() => undefined)
  }
  await deps.db.db.deleteFrom('blobs').where('event_id', '=', eventId).execute()
  await deps.db.db.deleteFrom('events').where('id', '=', eventId).execute()
}

/**
 * The self-service path: your own account, gone.
 *
 * Confirmed with the password when the account has one. Not as cryptography — the session
 * already proves possession — but because this is the one button whose misclick cannot be
 * repaired, and a password prompt is the strongest "are you sure" an interface can ask. An
 * account with no password (provider or passkey sign-in) confirms with its typed email instead.
 */
export async function deleteOwnAccount(
  deps: DeletionDeps,
  input: { userId: string; password?: string; emailConfirmation?: string },
): Promise<void> {
  const user = await deps.db.db
    .selectFrom('users')
    .select(['id', 'password_hash', 'email_cipher'])
    .where('id', '=', input.userId)
    .executeTakeFirst()
  if (!user) {
    throw notFound()
  }

  if (user.password_hash) {
    if (!input.password || !(await verifyPassword(user.password_hash, input.password))) {
      throw forbidden('auth.error.invalidCredentials')
    }
  } else {
    const email = deps.crypto.decryptField(
      deps.crypto.serverKey(user.id, 'email'),
      new Uint8Array(user.email_cipher),
      { table: 'users', column: 'email_cipher', rowId: user.id },
    )
    if (deps.crypto.normaliseEmail(input.emailConfirmation ?? '') !== email) {
      throw forbidden('auth.error.invalidCredentials')
    }
  }

  await deleteAccount(deps, input.userId)
}
