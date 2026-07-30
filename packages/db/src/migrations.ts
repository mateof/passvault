import { sql, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import { columnTypes, type Engine } from './engine.js'

/**
 * Schema migrations, parameterised by engine.
 *
 * Kysely abstracts queries across engines but not DDL, which is exactly where
 * portability breaks. Everything engine-specific is concentrated here:
 *
 *   * Column types come from `columnTypes`, since binary and text are spelled
 *     differently on all six.
 *   * Check constraints avoid boolean-valued expressions. `(a IS NULL) = (b IS NULL)`
 *     is the compact way to write a coupling check and works on PostgreSQL, SQLite and
 *     MySQL, but SQL Server and Oracle have no boolean type to compare, so the verbose
 *     OR form is used throughout rather than branching per engine.
 *   * No foreign key uses a cascade. SQL Server rejects multiple cascade paths and
 *     `event_id` reaches most tables by more than one route, so a cascade added for
 *     convenience would fail there and nowhere else.
 */
export function migrations(engine: Engine): Record<string, Migration> {
  return {
    '0001_initial_schema': initialSchema(engine),
  }
}

export function migrationProvider(engine: Engine): MigrationProvider {
  const all = migrations(engine)
  return { getMigrations: async () => all }
}

function initialSchema(engine: Engine): Migration {
  const t = columnTypes(engine)
  const id = () => sql.raw(t.varchar(36))
  const instant = () => sql.raw(t.varchar(24))
  const binary = () => sql.raw(t.binary)
  const chars = (length: number) => sql.raw(t.varchar(length))
  /** base64url of 32 bytes is 43 characters; of 64 bytes, 86. */
  const digest = () => sql.raw(t.varchar(43))
  const hash = () => sql.raw(t.varchar(255))

  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('users')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('email_cipher', binary(), (column) => column.notNull())
        .addColumn('email_key', digest(), (column) => column.notNull().unique())
        .addColumn('display_name_cipher', binary())
        .addColumn('password_hash', hash())
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('locale', chars(8), (column) => column.notNull().defaultTo('gl'))
        .addColumn('is_admin', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint('chk_users_status', sql`status in ('ACTIVE', 'INVITED', 'SUSPENDED')`)
        .execute()
      await db.schema.createIndex('idx_users_status').on('users').column('status').execute()

      await db.schema
        .createTable('user_keys')
        .addColumn('user_id', id(), (column) => column.primaryKey().references('users.id'))
        .addColumn('sealed_envelope', binary(), (column) => column.notNull())
        .addColumn('has_recovery_slot', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('passphrase_set_at', instant())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .execute()

      await db.schema
        .createTable('devices')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.references('users.id'))
        .addColumn('name', chars(120), (column) => column.notNull())
        .addColumn('signing_public_key', digest(), (column) => column.notNull().unique())
        .addColumn('agreement_public_key', digest(), (column) => column.notNull())
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('last_seen_at', instant())
        .addCheckConstraint('chk_devices_status', sql`status in ('ACTIVE', 'REVOKED')`)
        .execute()
      await db.schema
        .createIndex('idx_devices_user_status')
        .on('devices')
        .columns(['user_id', 'status'])
        .execute()

      await db.schema
        .createTable('oidc_identities')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('provider', chars(32), (column) => column.notNull())
        .addColumn('subject', chars(255), (column) => column.notNull())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()
      await db.schema
        .createIndex('idx_oidc_provider_subject')
        .on('oidc_identities')
        .columns(['provider', 'subject'])
        .unique()
        .execute()
      await db.schema.createIndex('idx_oidc_user').on('oidc_identities').column('user_id').execute()

      await db.schema
        .createTable('webauthn_credentials')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('credential_id', chars(255), (column) => column.notNull().unique())
        .addColumn('public_key', binary(), (column) => column.notNull())
        .addColumn('sign_count', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('transports', chars(64))
        .addColumn('backed_up', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('name', chars(120))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('last_used_at', instant())
        .execute()
      await db.schema
        .createIndex('idx_webauthn_user')
        .on('webauthn_credentials')
        .column('user_id')
        .execute()

      await db.schema
        .createTable('totp_secrets')
        .addColumn('user_id', id(), (column) => column.primaryKey().references('users.id'))
        .addColumn('secret_cipher', binary(), (column) => column.notNull())
        .addColumn('confirmed_at', instant())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()

      await db.schema
        .createTable('email_otp_challenges')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('code_hash', hash(), (column) => column.notNull())
        .addColumn('purpose', chars(32), (column) => column.notNull())
        .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('expires_at', instant(), (column) => column.notNull())
        .addColumn('consumed_at', instant())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()
      await db.schema
        .createIndex('idx_otp_user_purpose')
        .on('email_otp_challenges')
        .columns(['user_id', 'purpose'])
        .execute()
      await db.schema
        .createIndex('idx_otp_expires')
        .on('email_otp_challenges')
        .column('expires_at')
        .execute()

      await db.schema
        .createTable('sessions')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('token_hash', hash(), (column) => column.notNull().unique())
        .addColumn('device_id', id(), (column) => column.references('devices.id'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('idle_expires_at', instant(), (column) => column.notNull())
        .addColumn('hard_expires_at', instant(), (column) => column.notNull())
        .addColumn('revoked_at', instant())
        .execute()
      await db.schema
        .createIndex('idx_sessions_user')
        .on('sessions')
        .columns(['user_id', 'revoked_at'])
        .execute()
      await db.schema
        .createIndex('idx_sessions_idle')
        .on('sessions')
        .column('idle_expires_at')
        .execute()

      await db.schema
        .createTable('registration_settings')
        .addColumn('id', 'integer', (column) => column.primaryKey())
        .addColumn('mode', chars(16), (column) => column.notNull().defaultTo('CLOSED'))
        .addColumn('allow_password_login', 'integer', (column) => column.notNull().defaultTo(1))
        .addColumn('require_second_factor', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addColumn('updated_by', id(), (column) => column.references('users.id'))
        .addCheckConstraint(
          'chk_registration_mode',
          sql`mode in ('OPEN', 'WHITELIST', 'INVITATION', 'CLOSED')`,
        )
        .execute()

      await db.schema
        .createTable('email_whitelist')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('email_key', digest(), (column) => column.notNull().unique())
        .addColumn('email_cipher', binary(), (column) => column.notNull())
        .addColumn('added_by', id(), (column) => column.references('users.id'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()

      await db.schema
        .createTable('invitations')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('code_hash', hash(), (column) => column.notNull().unique())
        .addColumn('email_key', digest())
        .addColumn('created_by', id(), (column) => column.notNull().references('users.id'))
        .addColumn('max_uses', 'integer', (column) => column.notNull().defaultTo(1))
        .addColumn('uses', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('expires_at', instant(), (column) => column.notNull())
        .addColumn('revoked_at', instant())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addCheckConstraint('chk_invitations_uses', sql`uses <= max_uses`)
        .execute()
      await db.schema
        .createIndex('idx_invitations_creator')
        .on('invitations')
        .column('created_by')
        .execute()

      await db.schema
        .createTable('password_setup_tokens')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('token_hash', hash(), (column) => column.notNull().unique())
        .addColumn('expires_at', instant(), (column) => column.notNull())
        .addColumn('consumed_at', instant())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()
      await db.schema
        .createIndex('idx_setup_tokens_user')
        .on('password_setup_tokens')
        .column('user_id')
        .execute()

      await db.schema
        .createTable('groups')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('name_cipher', binary(), (column) => column.notNull())
        .addColumn('owner_user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .execute()
      await db.schema.createIndex('idx_groups_owner').on('groups').column('owner_user_id').execute()

      await db.schema
        .createTable('group_members')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('group_id', id(), (column) => column.notNull().references('groups.id'))
        .addColumn('user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('role', chars(16), (column) => column.notNull().defaultTo('MEMBER'))
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint('chk_group_member_role', sql`role in ('OWNER', 'ORGANISER', 'MEMBER')`)
        .addCheckConstraint('chk_group_member_status', sql`status in ('ACTIVE', 'INACTIVE')`)
        .execute()
      await db.schema
        .createIndex('idx_group_members_unique')
        .on('group_members')
        .columns(['group_id', 'user_id'])
        .unique()
        .execute()
      await db.schema
        .createIndex('idx_group_members_user')
        .on('group_members')
        .columns(['user_id', 'status'])
        .execute()

      await db.schema
        .createTable('events')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('creator_user_id', id(), (column) => column.notNull().references('users.id'))
        .addColumn('name_cipher', binary(), (column) => column.notNull())
        .addColumn('venue_cipher', binary())
        .addColumn('notes_cipher', binary())
        .addColumn('starts_at', instant())
        .addColumn('time_zone', chars(64))
        .addColumn('default_assignment_mode', chars(16), (column) =>
          column.notNull().defaultTo('OPEN'),
        )
        .addColumn('password_protected', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('sealed_key_envelope', binary(), (column) => column.notNull())
        .addColumn('authority_device_id', id(), (column) => column.references('devices.id'))
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint(
          'chk_events_assignment_mode',
          sql`default_assignment_mode in ('OPEN', 'ASSIGNED', 'SELF_CLAIM')`,
        )
        .execute()
      await db.schema
        .createIndex('idx_events_creator')
        .on('events')
        .columns(['creator_user_id', 'status'])
        .execute()
      await db.schema.createIndex('idx_events_starts').on('events').column('starts_at').execute()

      await db.schema
        .createTable('event_access')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.notNull().references('events.id'))
        .addColumn('subject_kind', chars(8), (column) => column.notNull())
        .addColumn('subject_id', id(), (column) => column.notNull())
        .addColumn('role', chars(16), (column) => column.notNull().defaultTo('MEMBER'))
        .addColumn('granted_by', id(), (column) => column.notNull().references('users.id'))
        .addColumn('granted_at', instant(), (column) => column.notNull())
        .addColumn('revoked_at', instant())
        .addCheckConstraint('chk_access_subject_kind', sql`subject_kind in ('GROUP', 'USER')`)
        .execute()
      await db.schema
        .createIndex('idx_event_access_unique')
        .on('event_access')
        .columns(['event_id', 'subject_kind', 'subject_id'])
        .unique()
        .execute()
      await db.schema
        .createIndex('idx_event_access_subject')
        .on('event_access')
        .columns(['subject_kind', 'subject_id'])
        .execute()

      await db.schema
        .createTable('blobs')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.notNull().references('events.id'))
        .addColumn('media_type', chars(16), (column) => column.notNull())
        .addColumn('byte_length', 'integer', (column) => column.notNull())
        .addColumn('sha256', digest(), (column) => column.notNull())
        .addColumn('nonce', chars(16), (column) => column.notNull())
        .addColumn('storage_path', chars(512), (column) => column.notNull())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addCheckConstraint(
          'chk_blobs_media_type',
          sql`media_type in ('PDF', 'PNG', 'JPEG', 'PKPASS')`,
        )
        .execute()
      await db.schema.createIndex('idx_blobs_event').on('blobs').column('event_id').execute()

      await db.schema
        .createTable('tickets')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.notNull().references('events.id'))
        .addColumn('label_cipher', binary())
        .addColumn('section_cipher', binary())
        .addColumn('row_cipher', binary())
        .addColumn('seat_cipher', binary())
        .addColumn('barcode_format', chars(16))
        .addColumn('barcode_cipher', binary())
        .addColumn('document_blob_id', id(), (column) => column.references('blobs.id'))
        .addColumn('document_page', 'integer')
        .addColumn('assignment_mode', chars(16), (column) => column.notNull())
        .addColumn('assignment_state', chars(16), (column) => column.notNull().defaultTo('FREE'))
        .addColumn('holder_user_id', id(), (column) => column.references('users.id'))
        .addColumn('holder_label_cipher', binary())
        .addColumn('assigned_at', instant())
        .addColumn('exported_at', instant())
        .addColumn('status', chars(16), (column) => column.notNull().defaultTo('ACTIVE'))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint(
          'chk_tickets_assignment_state',
          sql`assignment_state in ('FREE', 'PROVISIONAL', 'CLAIMED', 'ASSIGNED', 'TRANSFERRED')`,
        )
        .addCheckConstraint(
          'chk_tickets_assignment_mode',
          sql`assignment_mode in ('OPEN', 'ASSIGNED', 'SELF_CLAIM')`,
        )
        .execute()
      await db.schema
        .createIndex('idx_tickets_event_state')
        .on('tickets')
        .columns(['event_id', 'assignment_state'])
        .execute()
      await db.schema
        .createIndex('idx_tickets_holder')
        .on('tickets')
        .columns(['holder_user_id', 'status'])
        .execute()
      await db.schema
        .createIndex('idx_tickets_document')
        .on('tickets')
        .column('document_blob_id')
        .execute()

      await db.schema
        .createTable('payments')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('ticket_id', id(), (column) =>
          column.notNull().unique().references('tickets.id'),
        )
        .addColumn('state', chars(16), (column) => column.notNull().defaultTo('UNPAID'))
        .addColumn('amount_cents', 'integer')
        .addColumn('currency', chars(3))
        .addColumn('visibility', chars(16), (column) => column.notNull().defaultTo('CREATOR_ONLY'))
        .addColumn('settled_at', instant())
        .addColumn('recorded_by', id(), (column) => column.notNull().references('users.id'))
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint(
          'chk_payments_state',
          sql`state in ('UNPAID', 'PARTIAL', 'PAID', 'WAIVED')`,
        )
        .addCheckConstraint(
          'chk_payments_visibility',
          sql`visibility in ('ALL', 'HOLDER_ONLY', 'CREATOR_ONLY')`,
        )
        // An amount without a currency is not a sum of money. Written in the verbose
        // form because SQL Server and Oracle cannot compare two IS NULL results.
        .addCheckConstraint(
          'chk_payments_amount_currency_coupled',
          sql`(amount_cents is null and currency is null) or (amount_cents is not null and currency is not null)`,
        )
        .execute()

      await db.schema
        .createTable('claim_coupons')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.notNull().references('events.id'))
        .addColumn('ticket_id', id(), (column) => column.notNull().references('tickets.id'))
        .addColumn('coupon_hash', hash(), (column) => column.notNull().unique())
        .addColumn('allowance', 'integer', (column) => column.notNull().defaultTo(1))
        .addColumn('issued_by', id(), (column) => column.notNull().references('users.id'))
        .addColumn('issued_at', instant(), (column) => column.notNull())
        .addColumn('consumed_at', instant())
        .execute()
      await db.schema
        .createIndex('idx_coupons_event_ticket')
        .on('claim_coupons')
        .columns(['event_id', 'ticket_id'])
        .execute()

      await db.schema
        .createTable('claim_requests')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('operation_id', id(), (column) => column.notNull().unique())
        .addColumn('ticket_id', id(), (column) => column.notNull().references('tickets.id'))
        .addColumn('device_id', id(), (column) => column.notNull().references('devices.id'))
        .addColumn('user_id', id(), (column) => column.references('users.id'))
        .addColumn('lamport', 'integer', (column) => column.notNull())
        .addColumn('device_id_hash', digest(), (column) => column.notNull())
        .addColumn('state', chars(16), (column) => column.notNull().defaultTo('PENDING'))
        .addColumn('reason', chars(64))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('resolved_at', instant())
        .addCheckConstraint(
          'chk_claim_state',
          sql`state in ('PENDING', 'CONFIRMED', 'REJECTED', 'DISCARDED')`,
        )
        .execute()
      await db.schema
        .createIndex('idx_claims_ticket_state')
        .on('claim_requests')
        .columns(['ticket_id', 'state'])
        .execute()
      // The reconciliation order, indexed so resolving a contended ticket is one scan.
      await db.schema
        .createIndex('idx_claims_order')
        .on('claim_requests')
        .columns(['ticket_id', 'lamport', 'device_id_hash'])
        .execute()

      await db.schema
        .createTable('operations')
        .addColumn('operation_id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.notNull().references('events.id'))
        .addColumn('device_id', id(), (column) => column.notNull().references('devices.id'))
        .addColumn('actor_user_id', id(), (column) => column.references('users.id'))
        .addColumn('lamport', 'integer', (column) => column.notNull())
        .addColumn('device_id_hash', digest(), (column) => column.notNull())
        .addColumn('wall_clock', instant(), (column) => column.notNull())
        .addColumn('type', chars(48), (column) => column.notNull())
        .addColumn('body_cipher', binary(), (column) => column.notNull())
        .addColumn('signature', chars(86), (column) => column.notNull())
        .addColumn('state', chars(16), (column) => column.notNull().defaultTo('APPLIED'))
        .addColumn('quarantine_reason', chars(64))
        .addColumn('received_at', instant(), (column) => column.notNull())
        .addColumn('applied_at', instant())
        .addCheckConstraint(
          'chk_operations_state',
          sql`state in ('APPLIED', 'QUARANTINED', 'REJECTED')`,
        )
        .execute()
      await db.schema
        .createIndex('idx_operations_order')
        .on('operations')
        .columns(['event_id', 'lamport', 'device_id_hash'])
        .execute()
      await db.schema
        .createIndex('idx_operations_state')
        .on('operations')
        .columns(['event_id', 'state'])
        .execute()
      await db.schema
        .createIndex('idx_operations_device')
        .on('operations')
        .column('device_id')
        .execute()

      await db.schema
        .createTable('ingest_batches')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('event_id', id(), (column) => column.references('events.id'))
        .addColumn('created_by', id(), (column) => column.notNull().references('users.id'))
        .addColumn('source_media_type', chars(16), (column) => column.notNull())
        .addColumn('source_blob_id', id(), (column) => column.references('blobs.id'))
        .addColumn('page_count', 'integer')
        .addColumn('detected_count', 'integer')
        .addColumn('state', chars(16), (column) => column.notNull().defaultTo('PENDING'))
        .addColumn('failure_reason', chars(255))
        .addColumn('created_at', instant(), (column) => column.notNull())
        .addColumn('updated_at', instant(), (column) => column.notNull())
        .addCheckConstraint(
          'chk_ingest_state',
          sql`state in ('PENDING', 'PROPOSED', 'CONFIRMED', 'FAILED')`,
        )
        // A batch may fail without a human-readable reason — a timeout, an old row — so
        // the coupling is deliberately one-directional: a reason implies FAILED, but
        // FAILED does not require a reason.
        .addCheckConstraint(
          'chk_ingest_failure_reason',
          sql`failure_reason is null or state = 'FAILED'`,
        )
        .execute()
      await db.schema
        .createIndex('idx_ingest_creator')
        .on('ingest_batches')
        .columns(['created_by', 'state'])
        .execute()

      await db.schema
        .createTable('audit_events')
        .addColumn('id', id(), (column) => column.primaryKey())
        .addColumn('actor_user_id', id(), (column) => column.references('users.id'))
        .addColumn('actor_device_id', id(), (column) => column.references('devices.id'))
        .addColumn('action', chars(64), (column) => column.notNull())
        .addColumn('subject_kind', chars(32))
        .addColumn('subject_id', id())
        .addColumn('detail_cipher', binary())
        .addColumn('created_at', instant(), (column) => column.notNull())
        .execute()
      await db.schema
        .createIndex('idx_audit_subject')
        .on('audit_events')
        .columns(['subject_kind', 'subject_id'])
        .execute()
      await db.schema
        .createIndex('idx_audit_created')
        .on('audit_events')
        .column('created_at')
        .execute()
      await db.schema
        .createIndex('idx_audit_actor')
        .on('audit_events')
        .column('actor_user_id')
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      // Reverse dependency order, since nothing cascades.
      for (const table of [
        'audit_events',
        'ingest_batches',
        'operations',
        'claim_requests',
        'claim_coupons',
        'payments',
        'tickets',
        'blobs',
        'event_access',
        'events',
        'group_members',
        'groups',
        'password_setup_tokens',
        'invitations',
        'email_whitelist',
        'registration_settings',
        'sessions',
        'email_otp_challenges',
        'totp_secrets',
        'webauthn_credentials',
        'oidc_identities',
        'devices',
        'user_keys',
        'users',
      ]) {
        await db.schema.dropTable(table).ifExists().execute()
      }
    },
  }
}
