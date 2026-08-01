/**
 * The Kysely view of the schema in `docs/database.dbml`, which is the canonical
 * contract. `schema-matches-dbml.test.ts` compares the two and fails if they drift.
 *
 * Every instant is a 24-character string and every boolean an integer, per the
 * conventions in `portable.ts`. The types say `string` and `number` rather than `Date`
 * and `boolean` on purpose: what a row holds should be visible from the type, so
 * nobody writes `new Date()` into a column and gets a different format on each engine.
 */

export type Instant = string
export type Flag = 0 | 1
export type Bytes = Uint8Array

export interface UsersTable {
  id: string
  email_cipher: Bytes
  email_key: string
  /**
   * A public name somebody can be found by.
   *
   * Plaintext, alone among the things this table knows about a person, because being findable is
   * what it is for: an address is how you reach somebody and a handle is how you name them to a
   * third party. Null for every account that never chose one.
   */
  handle: string | null
  display_name_cipher: Bytes | null
  password_hash: string | null
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED'
  locale: string
  is_admin: Flag
  created_at: Instant
  updated_at: Instant
}

export interface UserKeysTable {
  user_id: string
  sealed_envelope: Bytes
  has_recovery_slot: Flag
  passphrase_set_at: Instant | null
  updated_at: Instant
}

export interface DevicesTable {
  id: string
  user_id: string | null
  name: string
  signing_public_key: string
  agreement_public_key: string
  status: 'ACTIVE' | 'REVOKED'
  created_at: Instant
  last_seen_at: Instant | null
}

export interface OidcIdentitiesTable {
  id: string
  user_id: string
  provider: string
  subject: string
  created_at: Instant
}

export interface WebauthnCredentialsTable {
  id: string
  user_id: string
  credential_id: string
  public_key: Bytes
  sign_count: number
  transports: string | null
  backed_up: Flag
  name: string | null
  created_at: Instant
  last_used_at: Instant | null
}

export interface TotpSecretsTable {
  user_id: string
  secret_cipher: Bytes
  confirmed_at: Instant | null
  created_at: Instant
}

export interface EmailOtpChallengesTable {
  id: string
  user_id: string
  code_hash: string
  purpose: string
  attempts: number
  expires_at: Instant
  consumed_at: Instant | null
  created_at: Instant
}

export interface SessionsTable {
  id: string
  user_id: string
  token_hash: string
  device_id: string | null
  created_at: Instant
  idle_expires_at: Instant
  hard_expires_at: Instant
  revoked_at: Instant | null
  /** What opened it and from where, so a list of sessions is recognisable rather than a list of ids. */
  user_agent: string | null
  ip_address: string | null
  last_seen_at: Instant | null
  /** What the client called itself, when it said. A phone knows its model; a browser does not. */
  label_cipher: Bytes | null
}

export interface TagsTable {
  id: string
  owner_user_id: string
  name_cipher: Bytes
  colour: string
  created_at: Instant
}

export interface EventTagsTable {
  event_id: string
  tag_id: string
  created_at: Instant
}

export interface EventInvitationsTable {
  id: string
  event_id: string
  user_id: string
  invited_by: string
  via_group_id: string | null
  state: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN'
  created_at: Instant
  answered_at: Instant | null
}

export interface NotificationsTable {
  id: string
  user_id: string
  kind: string
  payload_cipher: Bytes
  created_at: Instant
  read_at: Instant | null
}

export interface RegistrationSettingsTable {
  id: number
  mode: 'OPEN' | 'WHITELIST' | 'INVITATION' | 'CLOSED'
  allow_password_login: Flag
  require_second_factor: Flag
  updated_at: Instant
  updated_by: string | null
}

export interface EmailWhitelistTable {
  id: string
  email_key: string
  email_cipher: Bytes
  added_by: string | null
  created_at: Instant
}

export interface InvitationsTable {
  id: string
  code_hash: string
  email_key: string | null
  created_by: string
  max_uses: number
  uses: number
  expires_at: Instant
  revoked_at: Instant | null
  created_at: Instant
}

export interface PasswordSetupTokensTable {
  id: string
  user_id: string
  token_hash: string
  expires_at: Instant
  consumed_at: Instant | null
  created_at: Instant
}

export interface GroupsTable {
  id: string
  name_cipher: Bytes
  owner_user_id: string
  status: 'ACTIVE' | 'ARCHIVED'
  created_at: Instant
  updated_at: Instant
}

export interface GroupMembersTable {
  id: string
  group_id: string
  user_id: string
  role: 'OWNER' | 'ORGANISER' | 'MEMBER'
  status: 'ACTIVE' | 'INACTIVE'
  created_at: Instant
  updated_at: Instant
}

export interface EventsTable {
  id: string
  creator_user_id: string
  name_cipher: Bytes
  venue_cipher: Bytes | null
  notes_cipher: Bytes | null
  starts_at: Instant | null
  time_zone: string | null
  default_assignment_mode: 'OPEN' | 'ASSIGNED' | 'SELF_CLAIM'
  password_protected: Flag
  sealed_key_envelope: Bytes
  authority_device_id: string | null
  status: 'ACTIVE' | 'ARCHIVED'
  /** A name from a small closed set, in the clear: it is a category, not user data. */
  icon: string | null
  colour: string | null
  /** A picture of the event's own, encrypted under the event key like every other blob. */
  image_blob_id: string | null
  created_at: Instant
  updated_at: Instant
}

export interface EventAccessTable {
  id: string
  event_id: string
  subject_kind: 'GROUP' | 'USER'
  subject_id: string
  role: 'ORGANISER' | 'MEMBER'
  granted_by: string
  granted_at: Instant
  revoked_at: Instant | null
}

export interface BlobsTable {
  id: string
  event_id: string
  media_type: 'PDF' | 'PNG' | 'JPEG' | 'PKPASS'
  byte_length: number
  sha256: string
  nonce: string
  storage_path: string
  created_at: Instant
}

export interface TicketsTable {
  id: string
  event_id: string
  label_cipher: Bytes | null
  section_cipher: Bytes | null
  row_cipher: Bytes | null
  seat_cipher: Bytes | null
  barcode_format: string | null
  barcode_cipher: Bytes | null
  document_blob_id: string | null
  document_page: number | null
  /** The import this ticket was split out of, when it came from one. */
  source_batch_id: string | null
  assignment_mode: 'OPEN' | 'ASSIGNED' | 'SELF_CLAIM'
  assignment_state: 'FREE' | 'PROVISIONAL' | 'CLAIMED' | 'ASSIGNED' | 'TRANSFERRED'
  holder_user_id: string | null
  holder_label_cipher: Bytes | null
  assigned_at: Instant | null
  exported_at: Instant | null
  status: 'ACTIVE' | 'WITHDRAWN'
  created_at: Instant
  updated_at: Instant
}

export interface PaymentsTable {
  id: string
  ticket_id: string
  state: 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED'
  amount_cents: number | null
  currency: string | null
  visibility: 'ALL' | 'HOLDER_ONLY' | 'CREATOR_ONLY'
  settled_at: Instant | null
  recorded_by: string
  updated_at: Instant
}

export interface ClaimCouponsTable {
  id: string
  event_id: string
  ticket_id: string
  coupon_hash: string
  allowance: number
  issued_by: string
  issued_at: Instant
  consumed_at: Instant | null
}

export interface ClaimRequestsTable {
  id: string
  operation_id: string
  ticket_id: string
  device_id: string
  user_id: string | null
  lamport: number
  device_id_hash: string
  state: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'DISCARDED'
  reason: string | null
  created_at: Instant
  resolved_at: Instant | null
}

export interface OperationsTable {
  operation_id: string
  event_id: string
  device_id: string
  actor_user_id: string | null
  lamport: number
  device_id_hash: string
  wall_clock: Instant
  type: string
  body_cipher: Bytes
  signature: string
  state: 'APPLIED' | 'QUARANTINED' | 'REJECTED'
  quarantine_reason: string | null
  received_at: Instant
  applied_at: Instant | null
}

export interface IngestBatchesTable {
  id: string
  event_id: string | null
  created_by: string
  source_media_type: 'PDF' | 'PNG' | 'JPEG' | 'PKPASS'
  source_blob_id: string | null
  page_count: number | null
  detected_count: number | null
  state: 'PENDING' | 'PROPOSED' | 'CONFIRMED' | 'FAILED'
  failure_reason: string | null
  created_at: Instant
  updated_at: Instant
}

export interface AuditEventsTable {
  id: string
  actor_user_id: string | null
  actor_device_id: string | null
  action: string
  subject_kind: string | null
  subject_id: string | null
  detail_cipher: Bytes | null
  created_at: Instant
}

export interface Database {
  users: UsersTable
  user_keys: UserKeysTable
  devices: DevicesTable
  oidc_identities: OidcIdentitiesTable
  webauthn_credentials: WebauthnCredentialsTable
  totp_secrets: TotpSecretsTable
  email_otp_challenges: EmailOtpChallengesTable
  sessions: SessionsTable
  registration_settings: RegistrationSettingsTable
  email_whitelist: EmailWhitelistTable
  invitations: InvitationsTable
  password_setup_tokens: PasswordSetupTokensTable
  groups: GroupsTable
  group_members: GroupMembersTable
  events: EventsTable
  event_access: EventAccessTable
  blobs: BlobsTable
  tickets: TicketsTable
  payments: PaymentsTable
  claim_coupons: ClaimCouponsTable
  claim_requests: ClaimRequestsTable
  operations: OperationsTable
  ingest_batches: IngestBatchesTable
  audit_events: AuditEventsTable
  tags: TagsTable
  event_tags: EventTagsTable
  event_invitations: EventInvitationsTable
  notifications: NotificationsTable
}

/** Every table name, in an order that satisfies foreign keys when inserting. */
export const TABLES_IN_DEPENDENCY_ORDER = [
  'users',
  'user_keys',
  'devices',
  'oidc_identities',
  'webauthn_credentials',
  'totp_secrets',
  'email_otp_challenges',
  'sessions',
  'registration_settings',
  'email_whitelist',
  'invitations',
  'password_setup_tokens',
  'groups',
  'group_members',
  'events',
  'event_access',
  'blobs',
  'tickets',
  'payments',
  'claim_coupons',
  'claim_requests',
  'operations',
  'ingest_batches',
  'tags',
  'event_tags',
  'event_invitations',
  'notifications',
  'audit_events',
] as const satisfies readonly (keyof Database)[]
