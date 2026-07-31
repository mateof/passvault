import { request, type RequestOptions } from './client'

/**
 * The server's endpoints, named.
 *
 * A thin layer on purpose: it exists so a route is written once and every screen that calls
 * it agrees about the path and the shape, not to add behaviour. Anything clever belongs on
 * one side or the other of it.
 */

/**
 * The two length rules the server enforces, stated here so the forms can state them too.
 *
 * They live beside the calls they constrain rather than in each screen: they are part of the
 * server's contract, and a screen that guesses them shows the user a rule that is wrong.
 */
export const MINIMUM_PASSWORD_LENGTH = 10
export const MINIMUM_PASSPHRASE_LENGTH = 8

export interface Me {
  userId: string
  locale: string
  isAdmin: boolean
  status: string
  /** Almost every other endpoint depends on this, so it travels with the session. */
  vaultUnlocked: boolean
  /**
   * Whether there is a vault at all, which is not the same question as whether it is open.
   *
   * An account an administrator created, or one that arrived through a provider, has no key
   * material until its owner chooses a passphrase. Asking that user to unlock would be asking
   * for a secret that does not exist.
   */
  vaultConfigured: boolean
}

export type RegistrationMode = 'OPEN' | 'WHITELIST' | 'INVITATION' | 'CLOSED'

export interface RegistrationSettings {
  mode: RegistrationMode
  allowPasswordLogin: boolean
  requireSecondFactor: boolean
  /**
   * True until somebody has claimed the server.
   *
   * Independent of `mode`: a server that is CLOSED still has to let its first administrator
   * in, or nobody can ever configure it.
   */
  acceptingFirstAdmin: boolean
  /** Set when the deployment file rewrites these settings on every restart. */
  enforcedByEnvironment?: boolean
}

/**
 * What `/auth/login` and `/auth/second-factor` answer.
 *
 * `status` is the discriminator the server actually sends. An earlier version of this file
 * invented field names of its own, which meant a second factor silently did nothing — the
 * shapes are written out here so the two sides cannot drift again without the compiler
 * noticing.
 */
export interface AuthResult {
  status: 'complete' | 'second-factor'
  token?: string
  /** The handle for the half-finished login, to be sent back with the code. */
  challenge?: string
  methods?: ('totp' | 'email')[]
}

export interface AdminUser {
  userId: string
  email?: string
  isAdmin: boolean
  status: string
  locale: string
  hasPassword: boolean
  hasVault: boolean
  createdAt: string
}

export interface AdminInvitation {
  id: string
  boundToAddress: boolean
  uses: number
  maxUses: number
  expiresAt: string
  revokedAt: string | null
  createdAt: string
  live: boolean
}

export interface AdminWhitelistEntry {
  id: string
  email?: string
  createdAt: string
}

export interface EventSummary {
  id: string
  name: string
  venue?: string | null
  startsAt?: string | null
  ticketCount?: number
  passwordProtected?: boolean
}

export interface TicketSummary {
  id: string
  label?: string | null
  seat?: string | null
  assignmentState: string
  holderLabel?: string | null
  paymentState?: string | null
  amountCents?: number | null
  currency?: string | null
  barcodeFormat?: string | null
  barcodeValue?: string | null
}

/**
 * The event without its tickets.
 *
 * They are a separate request because they are a separate endpoint, and that is not an
 * oversight on the server's part: a ticket's barcode is decrypted per viewer according to what
 * they are allowed to see, so the two answers have different shapes and different costs.
 */
export type EventDetail = EventSummary

const json = (locale: string): RequestOptions => ({ locale })

export const api = {
  health: () => request<{ status: string }>('/api/v1/health'),

  registrationSettings: (locale: string) =>
    request<RegistrationSettings>('/api/v1/registration/settings', json(locale)),

  providers: (locale: string) =>
    request<{ providers: { id: string; name: string }[] }>('/api/v1/auth/providers', json(locale)),

  login: (locale: string, email: string, password: string) =>
    request<AuthResult>('/api/v1/auth/login', { ...json(locale), body: { email, password } }),

  secondFactor: (locale: string, challenge: string, code: string, method: 'totp' | 'email') =>
    request<AuthResult>('/api/v1/auth/second-factor', {
      ...json(locale),
      body: { challenge, code, method },
    }),

  /**
   * Creates the account. Returns no session: the caller signs in afterwards.
   *
   * `recoveryCode` is handed over exactly once and is not recoverable later, which is why the
   * server sends its own warning alongside it — the client has to show both.
   */
  register: (locale: string, body: Record<string, unknown>) =>
    request<{ userId: string; recoveryCode?: string; recoveryCodeWarning?: string }>(
      '/api/v1/registration',
      { ...json(locale), body },
    ),

  logout: (locale: string) => request<void>('/api/v1/auth/logout', { ...json(locale), method: 'POST' }),

  me: (locale: string) => request<Me>('/api/v1/me', json(locale)),

  unlockVault: (locale: string, passphrase: string) =>
    request<void>('/api/v1/vault/unlock', { ...json(locale), body: { passphrase } }),

  lockVault: (locale: string) =>
    request<void>('/api/v1/vault/lock', { ...json(locale), method: 'POST' }),

  setPassphrase: (locale: string, passphrase: string, currentPassphrase?: string) =>
    request<{ created: boolean; recoveryCode?: string; recoveryCodeWarning?: string }>(
      '/api/v1/vault/passphrase',
      { ...json(locale), body: { passphrase, ...(currentPassphrase ? { currentPassphrase } : {}) } },
    ),

  /**
   * The events this user can reach.
   *
   * Names only what is readable without an event key. An event's name is ciphertext under that
   * key, so the list carries ids and the client fetches each one — which is the same shape the
   * encryption forces on every other screen.
   */
  events: (locale: string) =>
    request<{ events: { id: string; createdAt: string; passwordProtected: boolean }[] }>(
      '/api/v1/events',
      json(locale),
    ),

  createEvent: (locale: string, body: Record<string, unknown>) =>
    request<{ eventId: string; passwordProtected: boolean; readableByServer: boolean }>(
      '/api/v1/events',
      { ...json(locale), body },
    ),

  event: (locale: string, id: string) =>
    request<EventDetail>(`/api/v1/events/${encodeURIComponent(id)}`, json(locale)),

  tickets: (locale: string, eventId: string) =>
    request<{ tickets: TicketSummary[] }>(
      `/api/v1/events/${encodeURIComponent(eventId)}/tickets`,
      json(locale),
    ),

  openEvent: (locale: string, id: string, password: string) =>
    request<void>(`/api/v1/events/${encodeURIComponent(id)}/open`, {
      ...json(locale),
      body: { password },
    }),

  /**
   * Adds tickets in a batch, which is the shape the server takes.
   *
   * A batch rather than one at a time because that is what importing a sheet of forty produces,
   * and one request per ticket would be forty round trips and forty chances to half-finish.
   */
  addTickets: (locale: string, eventId: string, tickets: Record<string, unknown>[], password?: string) =>
    request<{ tickets: TicketSummary[] }>(`/api/v1/events/${encodeURIComponent(eventId)}/tickets`, {
      ...json(locale),
      body: { tickets, ...(password ? { password } : {}) },
    }),

  assign: (locale: string, ticketId: string, body: Record<string, unknown>) =>
    request<TicketSummary>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/assign`, {
      ...json(locale),
      body,
    }),

  claim: (locale: string, ticketId: string, body: Record<string, unknown>) =>
    request<TicketSummary>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/claim`, {
      ...json(locale),
      body,
    }),

  setPayment: (locale: string, ticketId: string, body: Record<string, unknown>) =>
    request<TicketSummary>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/payment`, {
      ...json(locale),
      body,
    }),

  withdraw: (locale: string, ticketId: string) =>
    request<void>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/withdraw`, {
      ...json(locale),
      method: 'POST',
    }),

  reconcile: (locale: string, ticketId: string) =>
    request<unknown>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/reconcile`, {
      ...json(locale),
      method: 'POST',
    }),

  exportEvent: (locale: string, eventId: string, body: Record<string, unknown>) =>
    request<Blob>(`/api/v1/events/${encodeURIComponent(eventId)}/export`, {
      ...json(locale),
      body,
      blob: true,
    }),

  inspectImport: (locale: string, file: File) =>
    request<{ preview?: { eventName?: string; ticketCount?: number } }>('/api/v1/import/inspect', {
      ...json(locale),
      file: { field: 'file', value: file, filename: file.name },
    }),

  importFile: (locale: string, file: File, password: string) =>
    request<{ eventId: string; ticketCount: number }>('/api/v1/import', {
      ...json(locale),
      file: { field: 'file', value: file, filename: file.name, extra: { password } },
    }),

  ingest: (locale: string, eventId: string, file: File) =>
    request<{ ingestId: string; tickets: unknown[] }>(
      `/api/v1/events/${encodeURIComponent(eventId)}/ingest`,
      { ...json(locale), file: { field: 'file', value: file, filename: file.name } },
    ),

  confirmIngest: (locale: string, eventId: string, ingestId: string, include: number[]) =>
    request<{ ticketCount: number }>(
      `/api/v1/events/${encodeURIComponent(eventId)}/ingest/${encodeURIComponent(ingestId)}/confirm`,
      { ...json(locale), body: { include } },
    ),

  quarantine: (locale: string, eventId: string) =>
    request<{ operations: { operationId: string; type: string; reason: string }[] }>(
      `/api/v1/sync/${encodeURIComponent(eventId)}/quarantine`,
      json(locale),
    ),

  passkeys: (locale: string) =>
    request<{ passkeys: { id: string; name?: string; createdAt: string }[] }>(
      '/api/v1/passkeys',
      json(locale),
    ),

  deletePasskey: (locale: string, id: string) =>
    request<void>(`/api/v1/passkeys/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'DELETE',
    }),

  /** Completes an account an administrator created, from the link in the invitation mail. */
  completeSetup: (locale: string, body: Record<string, unknown>) =>
    request<{ userId: string; recoveryCode?: string; recoveryCodeWarning?: string }>(
      '/api/v1/registration/complete-setup',
      { ...json(locale), body },
    ),

  // ── Administration ───────────────────────────────────────────────────────────

  registrationSettingsUpdate: (locale: string, body: Record<string, unknown>) =>
    request<RegistrationSettings>('/api/v1/admin/registration', {
      ...json(locale),
      method: 'PUT',
      body,
    }),

  adminUsers: (locale: string) =>
    request<{ users: AdminUser[] }>('/api/v1/admin/users', json(locale)),

  adminChangeUser: (
    locale: string,
    userId: string,
    body: { isAdmin?: boolean; status?: 'ACTIVE' | 'SUSPENDED' },
  ) =>
    request<AdminUser>(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
      ...json(locale),
      method: 'PATCH',
      body,
    }),

  adminCreateUser: (
    locale: string,
    body: { email: string; locale?: string; initialPassword?: string; isAdmin?: boolean },
  ) => request<{ userId: string; setupUrl?: string }>('/api/v1/admin/users', { ...json(locale), body }),

  adminSetupLink: (locale: string, userId: string) =>
    request<{ setupUrl: string }>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/setup-link`,
      { ...json(locale), method: 'POST' },
    ),

  /**
   * Creates an invitation and returns the code.
   *
   * The code comes back exactly once: only its Argon2id hash is stored, so a screen that
   * forgets it cannot ask for it again.
   */
  invite: (locale: string, body: { email?: string; maxUses?: number; ttlHours?: number }) =>
    request<{ invitationId: string; code: string; url: string }>('/api/v1/admin/invitations', {
      ...json(locale),
      body,
    }),

  adminInvitations: (locale: string) =>
    request<{ invitations: AdminInvitation[] }>('/api/v1/admin/invitations', json(locale)),

  revokeInvitation: (locale: string, id: string) =>
    request<void>(`/api/v1/admin/invitations/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'DELETE',
    }),

  adminWhitelist: (locale: string) =>
    request<{ entries: AdminWhitelistEntry[] }>('/api/v1/admin/whitelist', json(locale)),

  whitelist: (locale: string, email: string) =>
    request<AdminWhitelistEntry>('/api/v1/admin/whitelist', { ...json(locale), body: { email } }),

  removeFromWhitelist: (locale: string, id: string) =>
    request<void>(`/api/v1/admin/whitelist/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'DELETE',
    }),
}
