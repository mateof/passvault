import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Migration, type MigrationProvider } from 'kysely'
import { columnTypes, treatsNullsAsEqualInUniqueIndex, type Engine } from './engine.js'

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
 *     MySQL, but SQL Server has no boolean type to compare, so the verbose
 *     OR form is used throughout rather than branching per engine.
 *   * No foreign key uses a cascade. SQL Server rejects multiple cascade paths and
 *     `event_id` reaches most tables by more than one route, so a cascade added for
 *     convenience would fail there and nowhere else.
 */
export function migrations(engine: Engine): Record<string, Migration> {
  return {
    '0001_initial_schema': initialSchema(engine),
    '0002_event_appearance': eventAppearance(engine),
    '0003_ticket_source_batch': ticketSourceBatch(engine),
    '0004_handles_tags_and_notices': handlesTagsAndNotices(engine),
    '0005_event_password_keeper': eventPasswordKeeper(engine),
    '0006_download_marks_and_session_length': downloadMarksAndSessionLength(engine),
    '0007_refresh_tokens_and_multi_totp': refreshTokensAndMultiTotp(engine),
  }
}

/**
 * Two security shapes the old schema could not hold: a session that rotates its token, and an
 * account with more than one authenticator.
 *
 * The session gains a refresh token beside the access one. `token_hash` becomes the short-lived
 * access token; the new columns hold the long-lived refresh token, its expiry, and the
 * just-rotated previous hash kept for a brief grace so a dropped refresh response does not strand
 * a client. A session minted before this migration has null refresh columns and simply lives out
 * its old fixed expiry — nobody is signed out by the upgrade.
 *
 * TOTP moves from one secret per user to a table of authenticators, each with its own id and a
 * name, so a phone and a backup can both be enrolled. The single existing secret per user is
 * copied across rather than dropped, because an account with two-factor turned on must still have
 * it turned on after the upgrade — losing it would lock people out of their own accounts.
 */
function refreshTokensAndMultiTotp(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('sessions')
        .addColumn('refresh_hash', sql.raw(t.varchar(64)))
        .execute()
      await db.schema
        .alterTable('sessions')
        .addColumn('refresh_expires_at', sql.raw(t.varchar(32)))
        .execute()
      await db.schema
        .alterTable('sessions')
        .addColumn('refresh_prev_hash', sql.raw(t.varchar(64)))
        .execute()
      await db.schema
        .alterTable('sessions')
        .addColumn('refresh_rotated_at', sql.raw(t.varchar(32)))
        .execute()

      await db.schema
        .createTable('totp_authenticators')
        .addColumn('id', sql.raw(t.varchar(36)), (column) => column.primaryKey())
        .addColumn('user_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('users.id'),
        )
        .addColumn('label', sql.raw(t.varchar(64)))
        .addColumn('secret_cipher', sql.raw(t.binary), (column) => column.notNull())
        .addColumn('confirmed_at', sql.raw(t.varchar(32)))
        .addColumn('created_at', sql.raw(t.varchar(32)), (column) => column.notNull())
        .execute()
      await db.schema
        .createIndex('idx_totp_authenticators_user')
        .on('totp_authenticators')
        .column('user_id')
        .execute()

      // Carry every existing secret over, keeping whether it was confirmed. A generated id per
      // row, because the old table had none — its key was the user, which is exactly the limit
      // this migration removes.
      const existing = await db
        .selectFrom('totp_secrets' as never)
        .selectAll()
        .execute()
      for (const row of existing as Array<Record<string, unknown>>) {
        await db
          .insertInto('totp_authenticators' as never)
          .values({
            id: randomUUID(),
            user_id: row.user_id,
            label: null,
            secret_cipher: row.secret_cipher,
            confirmed_at: row.confirmed_at ?? null,
            created_at: row.created_at,
          } as never)
          .execute()
      }
      await db.schema.dropTable('totp_secrets').execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('totp_authenticators').execute()
      await db.schema.alterTable('sessions').dropColumn('refresh_hash').execute()
      await db.schema.alterTable('sessions').dropColumn('refresh_expires_at').execute()
      await db.schema.alterTable('sessions').dropColumn('refresh_prev_hash').execute()
      await db.schema.alterTable('sessions').dropColumn('refresh_rotated_at').execute()
    },
  }
}

/**
 * Two facts the server had no place to keep: whether a shared person has pulled an event, and
 * how long a session should last.
 *
 * `event_access.downloaded_at` is stamped the first time a member pulls the event's log. It is
 * the difference between the two honest sentences an interface can say when access is revoked:
 * before it is set, revoking cleanly stops them ever seeing the event; after, the tickets are
 * already on their device and revoking only stops what comes next. Nullable, because it is the
 * absence that carries the meaning.
 *
 * `registration_settings.session_days` moves the session lifetime out of the environment and
 * into a row an administrator can change. Null keeps the deploy-time default; a number is a
 * hard lifetime in days, which is what makes "stay signed in for a year" a setting rather than
 * a redeploy.
 */
function downloadMarksAndSessionLength(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('event_access')
        .addColumn('downloaded_at', sql.raw(t.varchar(32)))
        .execute()
      await db.schema
        .alterTable('registration_settings')
        .addColumn('session_days', 'integer')
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('event_access').dropColumn('downloaded_at').execute()
      await db.schema.alterTable('registration_settings').dropColumn('session_days').execute()
    },
  }
}

/**
 * The event password, kept where its creator can read it back.
 *
 * The password's cryptographic job is done by the envelope: it derives the key that unwraps the
 * event, and no plaintext is needed for that. But the person who set it also has to *tell* it to
 * their friends, usually weeks later over a messaging app, and "I set it in March" is not a
 * password. So the creator's copy is stored encrypted under their own data key — readable by
 * exactly one person, and only while their vault is open. The operator cannot read it, which is
 * the whole point of a password-protected event.
 */
function eventPasswordKeeper(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('events')
        .addColumn('password_keeper_cipher', sql.raw(t.binary))
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('events').dropColumn('password_keeper_cipher').execute()
    },
  }
}

/**
 * Handles, labels, invitations, notices, and where a session was opened from.
 *
 * Five things in one migration because they are one change: sharing an event with somebody is
 * the moment all of them meet. You find the person by handle rather than by remembering which
 * address they signed up with, they are told rather than silently given something, they decide,
 * and the event they accept is one you can find again among forty by its label and its date.
 *
 * A handle is plaintext and every other thing about a person here is not. That is deliberate and
 * it is the point of a handle: an address is a way to reach somebody and a handle is a way to be
 * found, so it is a public name in a way an address never is. Nobody is given one — the column is
 * nullable — and an account with none is exactly as usable as before, minus the finding.
 */
function handlesTagsAndNotices(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      // Stored casefolded: two people cannot be `ana` and `Ana`, because the whole value of a
      // handle is that saying it aloud identifies one person.
      //
      // The uniqueness is an index rather than a column constraint, and not for tidiness —
      // SQLite refuses outright to add a UNIQUE column to a table that already exists. On the
      // engines that allow it, a unique index also lets every account that never chose a handle
      // keep a NULL there; SQL Server counts NULLs as equal, so there it is filtered to the rows
      // that have one, which is the same rule written the way that engine understands.
      await db.schema
        .alterTable('users')
        .addColumn('handle', sql.raw(t.varchar(32)))
        .execute()
      if (treatsNullsAsEqualInUniqueIndex(engine)) {
        await sql
          .raw('create unique index idx_users_handle on users (handle) where handle is not null')
          .execute(db)
      } else {
        await db.schema
          .createIndex('idx_users_handle')
          .on('users')
          .column('handle')
          .unique()
          .execute()
      }

      // Where a session was opened from, so somebody looking at a list of their own sessions can
      // recognise which is the phone in their pocket and which is the one to end. Both nullable:
      // a request behind a proxy that strips them still has to be able to sign in.
      await db.schema
        .alterTable('sessions')
        .addColumn('user_agent', sql.raw(t.varchar(200)))
        .execute()
      await db.schema
        .alterTable('sessions')
        .addColumn('ip_address', sql.raw(t.varchar(64)))
        .execute()
      await db.schema
        .alterTable('sessions')
        .addColumn('last_seen_at', sql.raw(t.varchar(32)))
        .execute()
      // What the person called it, when they were asked. A phone says "Pixel 8"; a browser is
      // whatever its user agent claims, which is why the two are separate columns.
      await db.schema
        .alterTable('sessions')
        .addColumn('label_cipher', sql.raw(t.binary))
        .execute()

      /**
       * Labels, which are the user's own vocabulary for their wallet.
       *
       * The name is ciphertext under the owner's data key: "Vigo trips", "work", "Ana's
       * birthday" are as much about a person as the events they group. The colour is not — it
       * is one of a closed set and it ends up in a class name.
       */
      await db.schema
        .createTable('tags')
        .addColumn('id', sql.raw(t.varchar(36)), (column) => column.primaryKey())
        .addColumn('owner_user_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('users.id'),
        )
        .addColumn('name_cipher', sql.raw(t.binary), (column) => column.notNull())
        .addColumn('colour', sql.raw(t.varchar(16)), (column) => column.notNull())
        .addColumn('created_at', sql.raw(t.varchar(32)), (column) => column.notNull())
        .execute()
      await db.schema.createIndex('idx_tags_owner').on('tags').column('owner_user_id').execute()

      // Which events carry which label. A row per pair rather than a list in a column, because
      // "show me everything tagged Vigo" is a query and a comma-separated column is not.
      await db.schema
        .createTable('event_tags')
        .addColumn('event_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('events.id'),
        )
        .addColumn('tag_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('tags.id'),
        )
        .addColumn('created_at', sql.raw(t.varchar(32)), (column) => column.notNull())
        .addPrimaryKeyConstraint('pk_event_tags', ['event_id', 'tag_id'])
        .execute()

      /**
       * An invitation to an event, and the answer to it.
       *
       * Sharing used to grant access outright: an event appeared in somebody's wallet without
       * their having agreed to hold it, which is the wrong default for a thing that carries
       * somebody else's name and seat. Now a share creates an invitation, and access begins when
       * it is accepted.
       *
       * The subject is a person even when the invitation came through a group, because a group
       * cannot answer a question. One row per person is also what makes "who has not answered"
       * a query rather than a guess.
       */
      await db.schema
        .createTable('event_invitations')
        .addColumn('id', sql.raw(t.varchar(36)), (column) => column.primaryKey())
        .addColumn('event_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('events.id'),
        )
        .addColumn('user_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('users.id'),
        )
        .addColumn('invited_by', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('users.id'),
        )
        // Which group carried it, when one did, so revoking the group can withdraw what it
        // brought without touching an invitation somebody sent by hand.
        .addColumn('via_group_id', sql.raw(t.varchar(36)), (column) => column.references('groups.id'))
        .addColumn('state', sql.raw(t.varchar(16)), (column) => column.notNull())
        .addColumn('created_at', sql.raw(t.varchar(32)), (column) => column.notNull())
        .addColumn('answered_at', sql.raw(t.varchar(32)))
        .execute()
      await db.schema
        .createIndex('idx_event_invitations_user')
        .on('event_invitations')
        .columns(['user_id', 'state'])
        .execute()
      await db.schema
        .createIndex('idx_event_invitations_event')
        .on('event_invitations')
        .column('event_id')
        .execute()

      /**
       * Notices: what happened that somebody should know about.
       *
       * A table rather than an email, because the app and the web are where this belongs and
       * neither can be reached by mail on a NAS behind a tunnel. The body is a message key and
       * a JSON payload, not a sentence: the wording lives in the catalogue, in the reader's
       * language, and a notice written today still renders in a language added tomorrow.
       */
      await db.schema
        .createTable('notifications')
        .addColumn('id', sql.raw(t.varchar(36)), (column) => column.primaryKey())
        .addColumn('user_id', sql.raw(t.varchar(36)), (column) =>
          column.notNull().references('users.id'),
        )
        .addColumn('kind', sql.raw(t.varchar(40)), (column) => column.notNull())
        // Whatever the kind needs to render and to act on: an event id, an inviter's handle.
        // Ciphertext, because it names events and people.
        .addColumn('payload_cipher', sql.raw(t.binary), (column) => column.notNull())
        .addColumn('created_at', sql.raw(t.varchar(32)), (column) => column.notNull())
        .addColumn('read_at', sql.raw(t.varchar(32)))
        .execute()
      await db.schema
        .createIndex('idx_notifications_user')
        .on('notifications')
        .columns(['user_id', 'read_at'])
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('notifications').execute()
      await db.schema.dropTable('event_invitations').execute()
      await db.schema.dropTable('event_tags').execute()
      await db.schema.dropTable('tags').execute()
      for (const column of ['label_cipher', 'last_seen_at', 'ip_address', 'user_agent']) {
        await db.schema.alterTable('sessions').dropColumn(column).execute()
      }
      await db.schema.dropIndex('idx_users_handle').execute()
      await db.schema.alterTable('users').dropColumn('handle').execute()
    },
  }
}

/**
 * Which import a ticket came out of.
 *
 * A ten-page PDF becomes ten tickets and the file itself is not one of them, so without this
 * there is no way back from a ticket to the document it was split from — and no way to show
 * a wallet with two imports as two groups rather than twenty anonymous passes.
 *
 * Nullable, because tickets created by hand, by a transfer or by a phone's log have no import
 * to point at, and inventing one for them would be a lie in a column.
 */
function ticketSourceBatch(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('tickets')
        .addColumn('source_batch_id', sql.raw(t.varchar(36)), (column) =>
          column.references('ingest_batches.id'),
        )
        .execute()
      await db.schema
        .createIndex('idx_tickets_source_batch')
        .on('tickets')
        .column('source_batch_id')
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('idx_tickets_source_batch').ifExists().execute()
      await db.schema.alterTable('tickets').dropColumn('source_batch_id').execute()
    },
  }
}

/**
 * How an event looks: an icon and a colour, or a picture of its own.
 *
 * Plaintext, and that is a decision rather than an oversight. "Concert, in violet" is a category
 * and a colour; the ciphertext beside it is the name, the venue and the barcodes. Encrypting the
 * icon would put a key in front of the one thing a wallet needs before it can draw anything —
 * every event in the list would be a grey rectangle until its key was open, which is the state
 * this exists to fix.
 *
 * The picture is different, and is stored as a blob: encrypted under the event key like every
 * other document, because a poster can carry a name, a seat and a date.
 */
function eventAppearance(engine: Engine): Migration {
  const t = columnTypes(engine)
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('events')
        .addColumn('icon', sql.raw(t.varchar(32)))
        .execute()
      await db.schema
        .alterTable('events')
        .addColumn('colour', sql.raw(t.varchar(16)))
        .execute()
      await db.schema
        .alterTable('events')
        .addColumn('image_blob_id', sql.raw(t.varchar(36)), (column) =>
          column.references('blobs.id'),
        )
        .execute()
    },

    async down(db: Kysely<unknown>): Promise<void> {
      for (const column of ['image_blob_id', 'colour', 'icon']) {
        await db.schema.alterTable('events').dropColumn(column).execute()
      }
    },
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
        // form because SQL Server cannot compare two IS NULL results.
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
        // Deliberately not a foreign key. An append-only log has to be able to retain an
        // operation from a device it has never seen — that is exactly what quarantine is for,
        // and it is usually a peer whose key has not been exchanged yet. A reference here would
        // forbid the one case the synchronisation protocol requires.
        .addColumn('device_id', id(), (column) => column.notNull())
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
