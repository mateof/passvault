# Database

PassVault runs on SQLite by default and on PostgreSQL, MySQL, MariaDB, SQL Server or
SQL Server without a code change. This document explains what that costs and how the cost
is paid, because "engine-agnostic" is usually a claim rather than a property.

The schema itself is [database.dbml](database.dbml), which is the canonical contract.
The migrations in `packages/db/src/migrations.ts` implement it.

## Why SQLite is the default

Most installations are one group of friends, one household, or one small promoter. For
them a single file in `./data` is a backup they can actually perform, and there is no
second service to keep running. Nothing in the code assumes SQLite; it is a default,
not an architecture.

Point `DATABASE_URL` elsewhere and the same schema is created there:

| Engine | `DATABASE_URL` |
| --- | --- |
| SQLite | `sqlite:./data/passvault.db` |
| PostgreSQL | `postgres://user:pass@host:5432/passvault` |
| MySQL | `mysql://user:pass@host:3306/passvault` |
| MariaDB | `mariadb://user:pass@host:3306/passvault` |
| SQL Server | `mssql://user:pass@host:1433/passvault` |

Drivers load dynamically, so a SQLite installation never loads the PostgreSQL, MySQL,
SQL Server clients.

**Oracle was supported and is not any more.** It was the one engine Kysely has no dialect
for in core, so it came from a community package, and `oracledb` needs native Oracle client
libraries that do not build everywhere. Both were optional dependencies loaded through a
variable module specifier, which was tidy and hid the real problem: nothing had ever run
against Oracle. The first CI run that did got `Error: Not implemented` out of the community
dialect during the very first migration.

So the support was a claim, not a capability. It has been removed rather than left in the
list of engines with a footnote, because an engine named in a table is a promise, and this
one could not be kept. The five conventions below still hold — they were chosen for the
whole set and the four that remain need every one of them.

## Why not an ORM

Prisma fixes the database provider when it generates its client, and the requirement
here is to change engine by environment variable. Kysely builds SQL at runtime from
typed query builders, which keeps the choice a deployment decision.

Kysely abstracts queries. It does **not** abstract DDL, which is where portability
actually breaks, so everything engine-specific is concentrated in
`packages/db/src/engine.ts` and the migrations.

## The value conventions

Each of these exists because a native type behaves differently somewhere. Reaching for
the native type is the tempting mistake: it works until the day someone repoints
`DATABASE_URL` and the sort order silently changes.

**Identifiers are application-generated UUIDv7 in `varchar(36)`.** Time-ordered, so
they sort by creation without a sequence, an identity column or an engine default —
each of which is spelled differently on all six engines.

**Instants are `varchar(24)`**, ISO-8601 UTC with millisecond precision
(`2026-08-14T19:00:00.000Z`). Fixed width is the point: lexicographic order equals
chronological order everywhere, so `ORDER BY` and range scans work without a date type,
and a value read back is the value written — no driver timezone conversion, no
truncation to seconds, no local-time surprise. A truncated form such as
`2026-08-14T19:00:00Z` is rejected, because mixing widths would break the ordering
guarantee.

**Booleans are `int`, 0 or 1.** SQLite and SQL Server have no boolean type and MySQL's is
an alias for `TINYINT`, so drivers return `1`, `true` or `'1'` depending on the engine.
Reads go through `toBoolean` rather than relying on truthiness: `'0'` is truthy in
JavaScript, which would invert every flag on one engine and nowhere else.

**Money is integer cents.** Never a float. A shared bill that does not add up is a bug
users notice immediately.

**Binary values are `Uint8Array`** on the way in and out, normalised on read because
every driver returns `Buffer` in its own way. The normalisation is a view over the same
memory, not a copy, and it respects `byteOffset` — a `Buffer` usually points into a
pooled `ArrayBuffer`, and ignoring the offset would hand back the whole pool.

**Encrypted columns are suffixed `_cipher`.** Anything without the suffix is plaintext
and therefore queryable. The split is deliberate and documented in
[threat-model.md](threat-model.md): barcodes, documents, names, notes and amounts are
ciphertext, while identifiers, relations, states and timestamps stay indexable.

## No cascades

No foreign key anywhere uses `ON DELETE CASCADE`. SQL Server rejects multiple cascade
paths, and `event_id` reaches most tables by more than one route, so a cascade added
for convenience would fail there and nowhere else — the worst kind of portability bug,
because it appears only in the deployment you test last.

Deletion is therefore a status transition. Rows carry a `status` enum and move to
`WITHDRAWN`, `ARCHIVED` or `INACTIVE` rather than disappearing. Where a hard delete is
genuinely needed, application code performs it in dependency order.

This also keeps history honest: a ticket assigned to someone who later left the group
still resolves to a real row, so the audit trail does not develop holes.

## Nullable unique columns

SQL Server treats two NULLs as equal in a unique index, so a nullable column with a
unique constraint would permit exactly one row without a value. Every such key in the
schema therefore has a non-null mirror column — `users.email_key`, for instance, holds
the HMAC blind index and carries the uniqueness, while `email_cipher` holds the
encrypted address.

That solves two problems with one column, since the blind index is what makes an
encrypted address searchable in the first place.

## Check constraints

Enumerations are `varchar` with a check constraint rather than a native enum type: only
PostgreSQL and MySQL have one, and altering it later differs on each.

Coupling checks avoid boolean-valued expressions. `(a IS NULL) = (b IS NULL)` is the
compact way to say "both or neither" and works on PostgreSQL, SQLite and MySQL, but SQL
Server has no boolean type to compare, so the verbose OR form is used
throughout:

```sql
(amount_cents is null and currency is null) or
(amount_cents is not null and currency is not null)
```

One check is deliberately one-directional. `ingest_batches.failure_reason` may only be
set when `state = 'FAILED'`, but a `FAILED` batch is allowed to have no reason: a
timeout or an old row may not have human-readable text to put there.

## Backups and moving between engines

```bash
npm run db:backup            # writes backups/<timestamp>.ndjson.gz
npm run db:restore <file>
```

The format is gzipped NDJSON: a header line, then one line per row. Logical rather than
native, because there are six native dump formats with six restore procedures and one
neutral format restores onto any of them. That is also how an installation changes
engine — back up, repoint `DATABASE_URL`, restore.

Binary columns are encoded as `{"$bytes": "..."}`, a tagged object rather than a bare
base64 string: a text column can legally contain base64, and the stored Argon2id hashes
are full of it. Guessing at encoding by shape would corrupt exactly those columns.

Rows are written and flushed in dependency order, so foreign keys hold at every point
during a restore rather than only at the end.

## What is verified, and where

`packages/db/test` runs the migrations against SQLite in memory and checks the things
that are easy to get wrong: encrypted columns returning the exact bytes written, the
blind index rejecting a duplicate account, the payment coupling constraint, an
unknown enum value being refused, foreign keys actually being enforced — SQLite leaves
them off unless `PRAGMA foreign_keys = ON`, which is the setting whose absence silently
lets orphans accumulate — and the claim ordering that must not depend on a wall clock.

The other four are exercised in CI, which runs the same suite against service containers
for PostgreSQL, MySQL, MariaDB and SQL Server: each migrates twice — because a server
that migrates on boot runs it again on every rolling restart — and then runs the whole
suite against that engine.
