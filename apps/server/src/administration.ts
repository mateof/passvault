import { newId, toInstant } from '@passvault/db'
import { isLocale } from '@passvault/i18n'
import { readEmail, sendPasswordSetupLink, setupUrl, type AccountsDeps } from './accounts.js'
import { badRequest, conflict, forbidden, notFound } from './errors.js'
import * as repo from './repository.js'

/**
 * What an administrator can see and change about the installation.
 *
 * Separate from `app.ts` because these are decisions rather than plumbing — who may still sign
 * in, who may become an administrator, which invitation is still worth anything — and each one
 * has a rule attached that a route handler would otherwise carry inline. The rules are here so
 * the boot-time bootstrap and the HTTP endpoints cannot disagree about them.
 */

const WHITELIST_FIELD = (rowId: string) => ({
  table: 'email_whitelist',
  column: 'email_cipher',
  rowId,
})

export interface AdminUserView {
  userId: string
  email?: string
  isAdmin: boolean
  status: string
  locale: string
  /** False for an account that signs in only through a provider or a passkey. */
  hasPassword: boolean
  /** False until the user has chosen a vault passphrase; such an account can hold nothing. */
  hasVault: boolean
  createdAt: string
}

export interface AdminInvitationView {
  id: string
  /** The address it is bound to is not recoverable — only its blind index is stored. */
  boundToAddress: boolean
  uses: number
  maxUses: number
  expiresAt: string
  revokedAt: string | null
  createdAt: string
  /** True when it can still be redeemed, which is the only thing most readers want to know. */
  live: boolean
}

export interface AdminWhitelistView {
  id: string
  email?: string
  createdAt: string
}

export async function listUsers(deps: AccountsDeps): Promise<AdminUserView[]> {
  const rows = await repo.listUsers(deps.db)
  return rows.map((row) => ({
    userId: row.id,
    ...(row.email_cipher.length > 0
      ? { email: readEmail(deps, row.id, new Uint8Array(row.email_cipher)) }
      : {}),
    isAdmin: row.is_admin === 1,
    status: row.status,
    locale: row.locale,
    hasPassword: row.password_hash !== null,
    hasVault: row.passphrase_set_at !== null && row.passphrase_set_at !== undefined,
    createdAt: row.created_at,
  }))
}

/**
 * Promotes, demotes, suspends or reinstates an account.
 *
 * Two refusals, both of which exist because the alternative is an installation nobody can
 * administer: an administrator cannot suspend themselves, and the last one standing cannot be
 * demoted or suspended by anybody, themselves included. Recovering from either would mean
 * editing the database by hand.
 */
export async function changeUser(
  deps: AccountsDeps,
  input: {
    actorUserId: string
    userId: string
    isAdmin?: boolean
    status?: 'ACTIVE' | 'SUSPENDED'
  },
): Promise<AdminUserView> {
  const user = await repo.findUserById(deps.db, input.userId)
  if (!user) {
    throw notFound()
  }

  const losesAdmin = input.isAdmin === false && user.is_admin === 1
  const losesAccess = input.status === 'SUSPENDED' && user.status !== 'SUSPENDED'

  if (losesAccess && input.userId === input.actorUserId) {
    throw forbidden('admin.error.selfSuspend')
  }
  if (
    (losesAdmin || (losesAccess && user.is_admin === 1)) &&
    (await repo.countAdmins(deps.db)) <= 1
  ) {
    throw forbidden('admin.error.lastAdmin')
  }
  if (input.status === 'ACTIVE' && user.status === 'INVITED') {
    // INVITED is not a punishment to be lifted; it means the account has no key material yet,
    // and only the user setting a passphrase can change that.
    throw badRequest('admin.error.stillInvited')
  }

  if (input.isAdmin !== undefined && input.isAdmin !== (user.is_admin === 1)) {
    await repo.setUserAdmin(deps.db, input.userId, input.isAdmin)
    await repo.recordAudit(deps.db, {
      actorUserId: input.actorUserId,
      action: input.isAdmin ? 'user.promoted' : 'user.demoted',
      subjectKind: 'user',
      subjectId: input.userId,
    })
  }

  if (input.status !== undefined && input.status !== user.status) {
    await repo.setUserStatus(deps.db, input.userId, input.status)
    if (input.status === 'SUSPENDED') {
      // Suspension that leaves a live session is not suspension. The vault key held for that
      // session becomes unreachable with it, since every request has to find the session first.
      await repo.revokeSessionsOfUser(deps.db, input.userId)
    }
    await repo.recordAudit(deps.db, {
      actorUserId: input.actorUserId,
      action: input.status === 'SUSPENDED' ? 'user.suspended' : 'user.reinstated',
      subjectKind: 'user',
      subjectId: input.userId,
    })
  }

  const updated = (await listUsers(deps)).find((one) => one.userId === input.userId)
  if (!updated) {
    throw notFound()
  }
  return updated
}

/**
 * Sends the user a fresh link to set their own password.
 *
 * Useful past account creation: the first link expires, mail gets lost, and the alternative an
 * administrator reaches for otherwise is setting a password themselves and reading it out over
 * the phone.
 */
export async function resendSetupLink(
  deps: AccountsDeps,
  input: { actorUserId: string; userId: string; ttlHours?: number },
): Promise<{ setupUrl: string }> {
  const user = await repo.findUserById(deps.db, input.userId)
  if (!user) {
    throw notFound()
  }
  if (user.email_cipher.length === 0) {
    throw badRequest('registration.error.setupTokenInvalid')
  }
  const token = await sendPasswordSetupLink(deps, {
    userId: user.id,
    email: readEmail(deps, user.id, new Uint8Array(user.email_cipher)),
    locale: isLocale(user.locale) ? user.locale : deps.config.defaultLocale,
    ...(input.ttlHours ? { ttlHours: input.ttlHours } : {}),
  })
  await repo.recordAudit(deps.db, {
    actorUserId: input.actorUserId,
    action: 'account.setup.link-resent',
    subjectKind: 'user',
    subjectId: user.id,
  })
  return { setupUrl: setupUrl(deps, token) }
}

/**
 * Adds an address to the allow list.
 *
 * The ciphertext is keyed to the row itself rather than to whoever added it. There is no user
 * row to key it to — the whole point of the allow list is that the account does not exist yet —
 * and keying it to the administrator meant an entry became unreadable if that administrator was
 * ever removed. `whitelistEmail` still reads the older form, so existing rows keep working.
 */
export async function addWhitelistEntry(
  deps: AccountsDeps,
  input: { email: string; addedBy: string | null },
): Promise<AdminWhitelistView> {
  const emailKey = deps.crypto.emailIndex(input.email)
  if (await repo.isWhitelisted(deps.db, emailKey)) {
    throw conflict('admin.error.alreadyWhitelisted')
  }
  const id = newId()
  const normalised = deps.crypto.normaliseEmail(input.email)
  await repo.addToWhitelist(deps.db, {
    id,
    emailKey,
    emailCipher: deps.crypto.encryptField(
      deps.crypto.serverKey(id, 'email'),
      normalised,
      WHITELIST_FIELD(id),
    ),
    addedBy: input.addedBy,
  })
  if (input.addedBy) {
    await repo.recordAudit(deps.db, {
      actorUserId: input.addedBy,
      action: 'whitelist.added',
      subjectKind: 'whitelist',
      subjectId: id,
    })
  }
  return { id, email: normalised, createdAt: toInstant() }
}

export async function listWhitelist(deps: AccountsDeps): Promise<AdminWhitelistView[]> {
  const rows = await repo.listWhitelist(deps.db)
  return rows.map((row) => {
    const email = whitelistEmail(deps, row)
    return {
      id: row.id,
      ...(email ? { email } : {}),
      createdAt: row.created_at,
    }
  })
}

/**
 * Reads an allow-list address, under whichever key sealed it.
 *
 * Two attempts rather than one: rows written before the key was tied to the row itself are
 * sealed under the administrator who added them. Showing the identifier instead of the address
 * would be technically honest and useless to somebody deciding whether to remove the entry.
 */
function whitelistEmail(
  deps: AccountsDeps,
  row: { id: string; added_by: string | null; email_cipher: Uint8Array },
): string | undefined {
  for (const keyId of [row.id, row.added_by]) {
    if (!keyId) {
      continue
    }
    try {
      return deps.crypto.decryptField(
        deps.crypto.serverKey(keyId, 'email'),
        new Uint8Array(row.email_cipher),
        WHITELIST_FIELD(keyId),
      )
    } catch {
      // The other key, or none. A row nobody can read is reported without an address rather
      // than failing the whole listing.
    }
  }
  return undefined
}

export async function listInvitations(deps: AccountsDeps): Promise<AdminInvitationView[]> {
  const now = toInstant()
  const rows = await repo.listInvitations(deps.db)
  return rows.map((row) => ({
    id: row.id,
    boundToAddress: row.email_key !== null,
    uses: row.uses,
    maxUses: row.max_uses,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    live: row.revoked_at === null && row.uses < row.max_uses && row.expires_at > now,
  }))
}
