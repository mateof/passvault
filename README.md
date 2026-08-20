# PassVault

<p align="center">
  <a href="https://github.com/mateof/passvault/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/mateof/passvault/ci.yml?branch=main&amp;label=CI&amp;logo=github"></a>
  <a href="https://github.com/mateof/passvault/pkgs/container/passvault"><img alt="GHCR image" src="https://img.shields.io/badge/ghcr.io-image-2496ED?logo=docker&amp;logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-TypeScript-339933?logo=nodedotjs&amp;logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/mateof/passvault"></a>
  <a href="https://github.com/mateof/passvault/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/mateof/passvault"></a>
</p>

Event tickets rarely arrive one per person. You buy ten seats for a concert, get a
single ten-page PDF, and then spend a week working out who gets which seat, who
has paid you back, and how to hand each person their barcode without losing track
of which copies are in circulation.

PassVault is built for that job. It splits multi-page tickets into individual
passes, assigns them to people, tracks who has paid, and hands each pass to its
holder — over the network when there is one, and over a local Wi-Fi network or a
file sent through any messaging app when there is not.

The Android app works with no server at all. This repository holds the optional
server, the web frontend, and the specification of the interchange format the two
implementations share.

| Component | Repository |
| --- | --- |
| Server, web frontend, format specification | this repository |
| Android app | [mateof/passvault-android](https://github.com/mateof/passvault-android) |

## What it does

**Ingestion.** Feed it a multi-page PDF, a `.pkpass` file, or a photo of a ticket.
It splits pages into separate passes, decodes QR, Aztec, PDF417 and Code 128
symbols, and reads Apple Wallet passes including their signature. Splitting is
proposed, never applied blindly: real-world tickets sometimes put two passes on a
page or lead with a page of instructions, so you confirm the result before it is
saved.

**Distribution.** Four assignment models, per ticket rather than per event, so one
event can mix them:

- *Open* — everyone with access to the event can see every ticket.
- *Assigned* — the organiser allocates each ticket to one person, who sees only
  their own.
- *Self-claim* — members claim a free ticket for themselves, one each.
- *Individual grants* — access given to named people rather than a group.

**Showing a ticket.** The holder is given the barcode as the symbol a scanner reads,
drawn in the browser from the value they downloaded — the server never renders a code it
went to such lengths not to hand around, and nothing is fetched from a CDN, so a ticket
displays in a basement venue with no signal. Beside it is the pass itself: the page the
ticket was split from, or the region cut out of a sheet it shared with others.

**The door.** A camera in the browser reads a ticket and says whether it has already
been through, when, and how many times it has been presented. This is not access
control — see the threat model — and it does not claim to be: it is the difference
between noticing a duplicated code while its holder is in front of you and hearing
about it from whoever was refused. Only the creator and the organisers they name may
work it, and every scan leaves an audit line whether it admitted anybody or not.

**Handing out, in one go.** Free seats to a whole group, one each, in order — and the
answer says who got nothing when the seats ran out, rather than leaving an organiser to
count. The date exports as an `.ics`, so a ticket ends up in the calendar where people
keep their nights.

**The record.** Every consequential act writes an audit line, and now something reads
them: an administrator sees the installation's trail, and a creator sees what happened
to their own event's seats and nothing else.

**Being told before it happens.** Until now nothing on the server ever spoke first:
every notice was a side effect of somebody's request, which left everything that
matters because of *time* unsaid — a countdown on a withheld code is only a countdown
if you are looking at it. A sweep now says four things: the event is tomorrow, your
code is about to open, your seat is still unpaid, and — to the organiser — seats are
still unclaimed and the night is close. Each is said once, and that is enforced by
asking the notices themselves rather than by a marker that can drift from them.

**Payment tracking.** The organiser records who has settled up, and chooses
whether that is visible to everybody, only to the person concerned, or only to
themselves. An unpaid seat can be kept locked until it is marked paid.

**Withholding a barcode until its moment.** The organiser can hold a code back —
until an exact time, until the day before the event, or by hand — so a bearer token
is not in circulation any earlier than it needs to be. Blocking is refused once the
holder has already seen the code, since from there a photograph may exist. While a
code is withheld the holder still sees that they hold the ticket, with a live
countdown when it is waiting for a time. How to reach every one of these controls is
in the [user manual](docs/user-manual.md).

**The original file, kept.** Splitting a PDF into passes drops every page with no
barcode on it — which is exactly where the map, the terms and the instructions
live. So the document is stored whole and listed beside the tickets it produced,
and its first page becomes the event's cover unless you choose a picture yourself.

**Offline operation.** Creating events, importing tickets and managing your
collection never touch the network. Two devices on the same Wi-Fi can find each
other and transfer passes directly. Failing that, tickets export to a single
encrypted `.tkpak` file that travels over WhatsApp, Telegram, Bluetooth or email
and imports on any device running the app — no account, no server, no signup.

**Event passwords.** An event can carry a password that anyone receiving it must
enter. It is not a checkbox: the password derives the key that unwraps the event's
data. Get the group wrong and the recipient still holds nothing usable.

## Threat model, stated up front

A ticket is a bearer token. Its value is a barcode that a turnstile reads without
consulting anybody, so there are three things PassVault cannot do, and does not
claim to:

1. **There is no revocation.** Once somebody imports a `.tkpak`, they hold the
   barcode. Deleting your copy, marking the ticket withdrawn and syncing that
   change does not remove the image from their device. Encryption protects a file
   in transit and at rest, not after a legitimate import.
2. **Assignment is a social agreement, not an enforcement mechanism.** Two people
   can arrive with the same barcode. The first one through gets in.
3. **The realistic goal is preventing mistakes, keeping an audit trail, and
   keeping the exposure window small** — not making duplication impossible.

Everything else in the design follows from those three sentences. The full
analysis, including what each attack surface does and does not protect against,
is in [docs/threat-model.md](docs/threat-model.md).

## Getting started

Requires Node 22 or newer.

```bash
npm install
npm run db:migrate
npm run dev
```

That is the whole setup. The server starts on an embedded SQLite database in
`./data`, generates the keys it needs on first boot, and prints what it created.
No external database, no message broker, no cache.

With Docker:

```bash
cp .env.example .env    # optional; an empty .env works
docker compose up
```

[.env.example](.env.example) documents every environment variable and what
happens when it is left empty.

Or without the source, from the published image:

| Tag | What it is |
| --- | --- |
| `ghcr.io/mateof/passvault:latest` | every merge to main |
| `ghcr.io/mateof/passvault:0.2.1` | one build, pinned; the number rises with every merge |
| `ghcr.io/mateof/passvault:alldatabases` | the same build, keeping every database driver |
| `ghcr.io/mateof/passvault:0.2.1-alldatabases` | both of the above |

The default image carries SQLite alone, because a single box uses one engine and
the Postgres, MySQL and SQL Server drivers are tens of megabytes each. Pointing
the server at one of those needs the `-alldatabases` variant; building from this
checkout keeps all four either way.

## Administering an installation

A fresh instance is closed and has no accounts. The first account to register
becomes the administrator anyway — otherwise nobody could ever configure it — but
that only works if somebody is watching, which on a server behind a tunnel is
exactly the wrong assumption. So the deployment file can say it instead:

```bash
ADMIN_EMAIL=admin@example.org       # created at boot, or promoted if it exists
REGISTRATION_MODE=INVITATION        # OPEN, WHITELIST, INVITATION or CLOSED
REGISTRATION_WHITELIST=ana@example.org, brais@example.org
```

With no `ADMIN_PASSWORD`, the account is created without one and a single-use link
to choose it is emailed, written to the startup log, and left in
`<DATA_DIR>/ADMIN-SETUP-LINK.txt`. That is the recommended form: the password then
exists in neither a file nor a log. The file is there because a container log is
not always reachable — on a NAS it is a panel in another application, while the
data directory is a folder the operator already has open. It is deleted the moment
the link is redeemed, and **a restart issues a fresh one** for as long as the
account has not been set up, so an expired link is not a locked-out installation.

`ADMIN_EMAIL` is idempotent and never destructive — it creates or promotes, and
never demotes, suspends or resets anything.

These values **seed** the database on first boot; from then on the administration
screens own them, so closing registration from the browser is not undone by a
restart. `REGISTRATION_ENFORCE=true` inverts that for an operator who would rather
the file be the single source of truth.

The administration screens themselves cover the registration mode, the accounts
(promote, demote, suspend, reinstate, send a setup link), the invitations and the
allow list. Two things they refuse: removing the last administrator, and
suspending yourself. Recovering from either would mean editing the database by
hand.

No route lets an administrator choose somebody's vault passphrase, including their
own account's at creation time. A passphrase the administrator knows is a vault
the administrator can read, which would undo the entire key design.

## Choosing a database

SQLite is the default because most installations are one household, one group of
friends, or one small promoter, and a single file is a backup you can actually
perform. Nothing in the code assumes it. Point `DATABASE_URL` at another engine
and the same schema is created there:

| Engine | `DATABASE_URL` |
| --- | --- |
| SQLite (default) | `sqlite:./data/passvault.db` |
| PostgreSQL | `postgres://user:pass@host:5432/passvault` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/passvault` |
| SQL Server | `mssql://user:pass@host:1433/passvault` |

Portability is a design constraint rather than an afterthought, which is why the
schema stores booleans as integers, timestamps as fixed-format ISO-8601 text,
money as integer cents, and identifiers as application-generated UUIDv7 — and why
no foreign key cascades, since SQL Server rejects multiple cascade paths. The
reasoning is in [docs/database.md](docs/database.md), and the schema itself is
[docs/database.dbml](docs/database.dbml), which is the canonical contract.

Migrating between engines does not need vendor tooling: `npm run db:backup`
writes gzipped NDJSON that `npm run db:restore` reads back on any supported
engine.

## Security

- **Passwords** are hashed with Argon2id and never stored or logged in a
  recoverable form.
- **Data at rest** is encrypted at the application layer, selectively: barcode
  payloads, ticket documents, real names, notes and amounts are ciphertext, while
  identifiers, relations and timestamps stay queryable. Emails are looked up
  through an HMAC blind index rather than stored in the clear.
- **Keys** use two tiers. A server master key wraps per-user data encryption
  keys, which are themselves wrapped by a key derived from the user's vault
  passphrase. Compromising the database and the server environment together still
  yields nothing without the passphrase.
- **The vault passphrase is separate from the login credential**, deliberately.
  Signing in with Google, Microsoft or a passkey provides no secret to derive a
  key from, so a single uniform encryption scheme needs a secret of its own. The
  trade-off is honest and documented: forget the passphrase and the data is gone
  unless you kept the recovery code.
- **Authentication** covers local passwords, OAuth2/OpenID Connect with Google and
  Microsoft, TOTP and email one-time codes for second factor, and WebAuthn
  passkeys. Delegated sign-in appears only when the instance has credentials for
  it: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or the Microsoft pair, and
  register `<PUBLIC_URL>/auth/callback` with the provider.
- **Registration** has four modes — open, email whitelist, invitation link or QR,
  and administrator-only — configurable at runtime.

[docs/security.md](docs/security.md) documents the choices and their limits.
Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## The `.tkpak` format

A `.tkpak` file is a ZIP container holding a cleartext manifest, an AES-256-GCM
encrypted payload, encrypted document blobs, and an Ed25519 signature. The
manifest stays readable so the app can tell you what a file contains and which
key it needs before asking for a password, and so a future version number
produces a clear message rather than a decryption failure.

The format is specified in [docs/spec/tkpak-v1.md](docs/spec/tkpak-v1.md) and is
the contract between this repository and the Android app, which implements it
independently in Kotlin. Both implementations run the same reference vectors in
[spec/vectors](spec/vectors); if either drifts, its test suite fails.

## Repository layout

```
packages/crypto    AES-GCM, Argon2id, key wrapping, Ed25519, blind index
packages/tkpak     .tkpak reader and writer, reference vector generator
packages/ingest    PDF splitting, barcode decoding, .pkpass, images
packages/db        Kysely layer, migrations, logical backup, six engines
packages/i18n      ICU message catalogues for Galician, Spanish and English
apps/server        Fastify API
apps/web           React frontend
docs               Architecture, security, threat model, format specification
spec/vectors       Cross-implementation test vectors
```

## Languages

The interface ships in Galician, Spanish and English. Galician is the source of
truth for message keys and the fallback locale; a test fails if any catalogue is
missing a key, which is how translations stay complete rather than
half-translated. Documentation and code comments are English.

## Contributing

Tests are organised by scenario rather than by class, because they double as the
explanation of how the system behaves — the reconciliation of two conflicting
offline claims is easier to understand from
`apps/server/test/claim-reconciliation.test.ts` than from any prose. Run them
with `npm test`.

One behaviour per test, and assert the return value of setup helpers that promise
one; a setup that fails silently makes every later assertion meaningless.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
