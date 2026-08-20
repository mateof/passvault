# Deployment

How to run PassVault somewhere real: a NAS, a small VPS, a box under a desk. Every
setting has a default that works, so this document is mostly about the handful worth
changing and the two or three that will bite if left alone.

`mailer.ts` has linked here since it was written and the file did not exist. This is
that file.

---

## 1. The smallest thing that works

```bash
docker compose up
```

SQLite in `./data`, keys generated on first boot, the web interface served by the
server itself. Nothing external — no database server, no message broker, no cache.

From source instead:

```bash
npm install
npm run db:migrate
npm run dev
```

Node 22 or newer.

---

## 2. The three settings that matter

### `PUBLIC_URL`

The address people actually reach. It is not cosmetic: it is the WebAuthn relying-party
origin and the base of every link in an email. Get it wrong and passkeys fail _after_
the system sheet has created one, which reads to a user as the app breaking.

```bash
PUBLIC_URL=https://passvault.example.org
```

### `SMTP_URL`

With no mail server configured, PassVault writes messages to the log instead of sending
them, warns once, and carries on. That is deliberate — a NAS behind a tunnel usually has
no mail server and the product has to work anyway, because the two places anybody
actually looks are the app and the web interface.

But three things arrive by email and only by email: the administrator setup link,
invitations to register, and one-time sign-in codes. Configure SMTP for anything beyond
a single household.

```bash
SMTP_URL=smtps://user:password@smtp.example.org:465
MAIL_FROM=passvault@example.org
```

### The data directory

`DATA_DIR` (default `./data`) holds the SQLite database, the encrypted blobs, and — the
part that matters — **the generated key file**. Back it up, and understand what that
means: a backup of the data directory contains both the ciphertext and the key that
wraps it. Treat it as you would the tickets themselves.

If the server had to generate its keys it says so in the log and tells you to move them
into the environment. Doing that separates the two, so a stolen data directory is not
also a stolen key:

```bash
PASSVAULT_MASTER_KEY=...      # printed on first boot
PASSVAULT_BLIND_INDEX_KEY=...
```

---

## 3. Claiming a fresh installation

A new instance is closed and has no accounts. The first account to register becomes the
administrator — but that only works if somebody is watching, which on a server behind a
tunnel is exactly the wrong assumption. So the deployment file can say it instead:

```bash
ADMIN_EMAIL=admin@example.org
REGISTRATION_MODE=INVITATION       # OPEN, WHITELIST, INVITATION or CLOSED
REGISTRATION_WHITELIST=ana@example.org, brais@example.org
```

With no `ADMIN_PASSWORD`, the account is created without one and a single-use link to
choose it is emailed, written to the startup log, **and** left in
`<DATA_DIR>/ADMIN-SETUP-LINK.txt`. That third place exists because a container log is
not always reachable — on a NAS it is a panel in another application, while the data
directory is a folder the operator already has open. The file is deleted the moment the
link is redeemed, and a restart issues a fresh one for as long as the account has not
been set up, so an expired link is never a locked-out installation.

`ADMIN_EMAIL` is idempotent and never destructive: it creates or promotes, and never
demotes, suspends or resets.

These values **seed** the database on first boot; from then on the administration
screens own them, so closing registration from the browser is not undone by a restart.
`REGISTRATION_ENFORCE=true` inverts that for an operator who would rather the file be
the single source of truth.

---

## 4. Choosing a database

SQLite is the default because most installations are one household, one group of
friends, or one small promoter — and a single file is a backup you can actually
perform. Nothing in the code assumes it:

| Engine           | `DATABASE_URL`                             |
| ---------------- | ------------------------------------------ |
| SQLite (default) | `sqlite:./data/passvault.db`               |
| PostgreSQL       | `postgres://user:pass@host:5432/passvault` |
| MySQL / MariaDB  | `mysql://user:pass@host:3306/passvault`    |
| SQL Server       | `mssql://user:pass@host:1433/passvault`    |

The published image carries the SQLite driver alone, because a single box uses one
engine and the others are tens of megabytes each. Pointing `DATABASE_URL` at one of
them needs the `-alldatabases` variant:

```
ghcr.io/mateof/passvault:latest
ghcr.io/mateof/passvault:alldatabases
```

Building from a checkout keeps all four either way.

Migrating between engines needs no vendor tooling: `npm run db:backup` writes gzipped
NDJSON that `npm run db:restore` reads back on any supported engine.

The server migrates on boot, and migrating twice is a no-op — which is the property
that makes a rolling restart safe.

---

## 5. Behind a reverse proxy

Terminate TLS at the proxy and pass the original host through. Two requirements, both
of which fail in ways that are hard to read if missed:

- **HTTPS is not optional in practice.** The camera at the door and the service worker
  both need a secure context; on plain HTTP the scanner will not start and the app is
  not installable.
- **`PUBLIC_URL` must match what the browser sees**, scheme and all, or WebAuthn
  refuses every passkey.

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Uploads go to the API as raw bytes, so raise `client_max_body_size` past whatever
ingestion limit you intend to allow.

---

## 6. Optional integrations

Each is off unless configured, and each is off on most installations.

**Delegated sign-in.** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or the
Microsoft pair, and register `<PUBLIC_URL>/auth/callback` with the provider. The buttons
appear only when the instance has credentials.

**Phone wallets.** Apple and Google both require a named developer account — a pass has
to be signed, which is the point of those systems rather than an obstacle. See the
wallet section of [.env.example](../.env.example) for every variable. Apple's signature
shells out to `openssl`, which the runtime image carries. Prefer the `*_FILE` forms over
the inline ones: a certificate in an environment variable is a certificate in
`docker inspect`.

**PDF ingestion** needs `pdfjs-dist` and `@napi-rs/canvas`, which are optional
dependencies. An installation that only handles `.pkpass` files and photographs can do
without them; one that is given a PDF without them answers with a clear error rather
than failing obscurely.

---

## 7. What runs on a timer

Two things, both unreferenced so an idle process still exits:

- **Vault key sweep**, every minute. Expired session keys leave memory whether or not
  anybody touches the server.
- **Reminder sweep**, every five minutes: the event is tomorrow, a code is about to
  open, a seat is still unpaid, seats are still unclaimed. Each is sent once, enforced
  by asking the notifications themselves, so the sweep is safe to run at any moment —
  including from two servers pointed at one database. An administrator can also run it
  by hand at `POST /api/v1/admin/reminders/sweep`.

---

## 8. Backups

Back up the data directory and, if you moved them out, the keys. `npm run db:backup`
writes a logical dump; for SQLite the file itself is also a perfectly good backup when
the server is stopped.

Test a restore before you need one. A backup nobody has restored is a hypothesis.
