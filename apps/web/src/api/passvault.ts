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

export interface Group {
  id: string
  name: string
  role: 'OWNER' | 'ORGANISER' | 'MEMBER'
  memberCount: number
  isOwner: boolean
}

export interface GroupMember {
  userId: string
  role: string
  email: string
  isSelf: boolean
}

export interface AccessEntry {
  subjectKind: 'GROUP' | 'USER'
  subjectId: string
  role: 'ORGANISER' | 'MEMBER'
  /** The group's name or the person's address, so a share can be read rather than decoded. */
  label: string
  grantedAt: string
}

export interface EventSummary {
  id: string
  name: string
  venue?: string | null
  notes?: string | null
  startsAt?: string | null
  timeZone?: string | null
  defaultAssignmentMode?: string
  passwordProtected?: boolean
  isCreator?: boolean
  /** The mark it is recognised by, in the clear so a list can be drawn before any key is open. */
  icon?: string | null
  colour?: string | null
  hasImage?: boolean
  /** False once an event password is set, which is the whole point of setting one. */
  readableByServer?: boolean
}

export interface EventDocument {
  id: string
  batchId: string
  mediaType: string
  pageCount?: number | null
  byteCount?: number | null
  createdAt: string
  /** The tickets this import produced. */
  ticketIds: string[]
}

/**
 * What ingestion proposes, before anything is saved.
 *
 * The list is `entries`, which is what the server sends. This file called it `tickets`, so the
 * review list rendered as empty every time and there was nothing to confirm — a proposal is the
 * one screen in the product whose entire purpose is to be looked at before it is accepted.
 */
export interface IngestProposal {
  ingestId: string
  pageCount: number
  requiresReview: boolean
  warnings: { code: string; pageNumber?: number }[]
  entries: {
    index: number
    suggestedLabel: string
    barcode: { format: string; value: string } | null
    pageNumber?: number | null
    include: boolean
    warnings: { code: string; pageNumber?: number }[]
  }[]
}

export type PaymentState = 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED'
export type PaymentVisibility = 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY'

/**
 * A ticket as the server projects it.
 *
 * Written to match `projectTickets` exactly. An earlier version of this file invented flat
 * `barcodeValue` and `paymentState` fields that the server has never sent, so the interface
 * silently showed no barcodes and no payments at all — the fields were simply always undefined.
 *
 * `barcode` is null rather than absent when the viewer is not entitled to it: an assigned ticket
 * belonging to somebody else is a ticket you can see and a code you cannot.
 */
export interface TicketSummary {
  id: string
  label?: string | null
  section?: string | null
  row?: string | null
  seat?: string | null
  barcode?: { format: string; value: string } | null
  assignmentMode: string
  assignmentState: string
  holderUserId?: string | null
  holderLabel?: string | null
  status: string
  payment?: {
    state: PaymentState
    amountCents?: number | null
    currency?: string | null
    visibility: PaymentVisibility
    settledAt?: string | null
  }
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
    request<{ providers: { id: string; name: string }[]; passkeys: boolean }>(
      '/api/v1/auth/providers',
      json(locale),
    ),

  /**
   * Begins a delegated sign-in.
   *
   * `redirectUri` is required by the server and was never sent, so every provider button answered
   * 400 — the buttons have never worked. It is this application's own callback screen, which is
   * also what has to be registered with Google and Microsoft.
   */
  oidcStart: (locale: string, provider: string, redirectUri: string) =>
    request<{ state: string; authorizationUrl: string }>(
      `/api/v1/auth/oidc/${encodeURIComponent(provider)}/start`,
      { ...json(locale), body: { redirectUri } },
    ),

  oidcCallback: (locale: string, state: string, code: string) =>
    request<{ status: string; token: string; needsPassphrase: boolean; createdAccount: boolean }>(
      '/api/v1/auth/oidc/callback',
      { ...json(locale), body: { state, code } },
    ),

  // ── Passkeys ─────────────────────────────────────────────────────────────────

  passkeyRegisterOptions: (locale: string) =>
    request<Record<string, never>>('/api/v1/passkeys/register/options', {
      ...json(locale),
      method: 'POST',
    }),

  passkeyRegister: (locale: string, response: Record<string, unknown>, name?: string) =>
    request<{ credentialId: string }>('/api/v1/passkeys/register', {
      ...json(locale),
      body: { response, ...(name ? { name } : {}) },
    }),

  passkeyLoginOptions: (locale: string) =>
    request<Record<string, never>>('/api/v1/passkeys/login/options', {
      ...json(locale),
      method: 'POST',
    }),

  passkeyLogin: (locale: string, response: Record<string, unknown>) =>
    request<AuthResult>('/api/v1/passkeys/login', { ...json(locale), body: { response } }),

  // ── Second factor ────────────────────────────────────────────────────────────

  /**
   * Starts TOTP enrolment.
   *
   * The secret is returned once and stored unconfirmed: an unconfirmed secret never satisfies a
   * second factor, so an enrolment somebody abandoned halfway cannot lock them out with a code
   * they never successfully scanned.
   */
  totpEnrol: (locale: string) =>
    request<{ secret: string; uri: string }>('/api/v1/totp/enrol', {
      ...json(locale),
      method: 'POST',
    }),

  totpConfirm: (locale: string, code: string) =>
    request<{ confirmed: boolean }>('/api/v1/totp/confirm', { ...json(locale), body: { code } }),

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

  logout: (locale: string) =>
    request<void>('/api/v1/auth/logout', { ...json(locale), method: 'POST' }),

  me: (locale: string) => request<Me>('/api/v1/me', json(locale)),

  unlockVault: (locale: string, passphrase: string) =>
    request<void>('/api/v1/vault/unlock', { ...json(locale), body: { passphrase } }),

  lockVault: (locale: string) =>
    request<void>('/api/v1/vault/lock', { ...json(locale), method: 'POST' }),

  setPassphrase: (locale: string, passphrase: string, currentPassphrase?: string) =>
    request<{ created: boolean; recoveryCode?: string; recoveryCodeWarning?: string }>(
      '/api/v1/vault/passphrase',
      {
        ...json(locale),
        body: { passphrase, ...(currentPassphrase ? { currentPassphrase } : {}) },
      },
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
  addTickets: (
    locale: string,
    eventId: string,
    tickets: Record<string, unknown>[],
    password?: string,
  ) =>
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
      binary: { file },
    }),

  /** The password travels in a header, which is where the server has always read it from. */
  importFile: (locale: string, file: File, password: string) =>
    request<{ eventId: string; ticketCount: number }>('/api/v1/import', {
      ...json(locale),
      binary: { file, headers: { 'x-passvault-password': password } },
    }),

  ingest: (locale: string, eventId: string, file: File) =>
    request<IngestProposal>(`/api/v1/events/${encodeURIComponent(eventId)}/ingest`, {
      ...json(locale),
      binary: { file },
    }),

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

  // ── How an event looks, and what it was imported from ────────────────────────

  updateEvent: (locale: string, id: string, body: { icon?: string; colour?: string }) =>
    request<EventDetail>(`/api/v1/events/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'PATCH',
      body,
    }),

  uploadEventImage: (locale: string, id: string, file: File) =>
    request<{ imageId: string }>(`/api/v1/events/${encodeURIComponent(id)}/image`, {
      ...json(locale),
      binary: { file },
    }),

  deleteEventImage: (locale: string, id: string) =>
    request<void>(`/api/v1/events/${encodeURIComponent(id)}/image`, {
      ...json(locale),
      method: 'DELETE',
    }),

  /**
   * The picture, as bytes.
   *
   * Fetched rather than pointed at with an `<img src>`: it is decrypted per session behind a
   * bearer token this application keeps in memory, so a plain URL in a tag would arrive
   * unauthenticated and render as a broken image.
   */
  eventImage: (locale: string, id: string) =>
    request<Blob>(`/api/v1/events/${encodeURIComponent(id)}/image`, {
      ...json(locale),
      blob: true,
    }),

  documents: (locale: string, eventId: string) =>
    request<{ documents: EventDocument[] }>(
      `/api/v1/events/${encodeURIComponent(eventId)}/documents`,
      json(locale),
    ),

  document: (locale: string, eventId: string, documentId: string) =>
    request<Blob>(
      `/api/v1/events/${encodeURIComponent(eventId)}/documents/${encodeURIComponent(documentId)}`,
      { ...json(locale), blob: true },
    ),

  // ── Groups and sharing ───────────────────────────────────────────────────────

  groups: (locale: string) => request<{ groups: Group[] }>('/api/v1/groups', json(locale)),

  createGroup: (locale: string, name: string) =>
    request<{ groupId: string }>('/api/v1/groups', { ...json(locale), body: { name } }),

  renameGroup: (locale: string, id: string, name: string) =>
    request<{ renamed: boolean }>(`/api/v1/groups/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'PATCH',
      body: { name },
    }),

  deleteGroup: (locale: string, id: string) =>
    request<{ deleted: boolean }>(`/api/v1/groups/${encodeURIComponent(id)}`, {
      ...json(locale),
      method: 'DELETE',
    }),

  groupMembers: (locale: string, id: string) =>
    request<{ members: GroupMember[] }>(`/api/v1/groups/${encodeURIComponent(id)}/members`, json(locale)),

  addGroupMember: (locale: string, id: string, email: string) =>
    request<{ userId: string }>(`/api/v1/groups/${encodeURIComponent(id)}/members`, {
      ...json(locale),
      body: { email },
    }),

  removeGroupMember: (locale: string, id: string, userId: string) =>
    request<{ removed: boolean }>(
      `/api/v1/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { ...json(locale), method: 'DELETE' },
    ),

  /** Whether an address belongs to an account here, so a typo is caught before it is submitted. */
  lookup: (locale: string, email: string) =>
    request<{ email: string; exists: boolean; userId?: string }>(
      `/api/v1/directory/lookup?email=${encodeURIComponent(email)}`,
      json(locale),
    ),

  /** Takes a free ticket in a self-claim event, with no coupon to be handed out first. */
  claimFree: (locale: string, eventId: string) =>
    request<{ ticketId: string }>(`/api/v1/events/${encodeURIComponent(eventId)}/claim`, {
      ...json(locale),
      method: 'POST',
    }),

  eventAccess: (locale: string, eventId: string) =>
    request<{ access: AccessEntry[] }>(
      `/api/v1/events/${encodeURIComponent(eventId)}/access`,
      json(locale),
    ),

  shareEvent: (locale: string, eventId: string, body: Record<string, unknown>) =>
    request<{ granted: boolean }>(`/api/v1/events/${encodeURIComponent(eventId)}/access`, {
      ...json(locale),
      body,
    }),

  revokeEventAccess: (locale: string, eventId: string, body: Record<string, unknown>) =>
    request<{ revoked: boolean }>(`/api/v1/events/${encodeURIComponent(eventId)}/access`, {
      ...json(locale),
      method: 'DELETE',
      body,
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
  ) =>
    request<{ userId: string; setupUrl?: string }>('/api/v1/admin/users', {
      ...json(locale),
      body,
    }),

  adminSetupLink: (locale: string, userId: string) =>
    request<{ setupUrl: string }>(`/api/v1/admin/users/${encodeURIComponent(userId)}/setup-link`, {
      ...json(locale),
      method: 'POST',
    }),

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
