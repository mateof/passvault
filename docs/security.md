# Security

This document states what PassVault protects, how, and — the part that matters more —
what it does not protect and why. The threat model in
[threat-model.md](threat-model.md) argues the case at length; this is the reference for
the mechanisms themselves.

The README linked here from the first release and the file did not exist. That is a
poor advertisement for a project that presents itself on its security posture, and the
fix is this page rather than the removal of the link.

---

## 1. The one thing to understand first

**A ticket is a bearer token.** Its value is a barcode that a turnstile reads without
consulting anybody. Everything below follows from that sentence, and three consequences
are worth stating before any mechanism is described:

1. **There is no revocation.** Once somebody has imported a `.tkpak` or seen a code,
   they hold it. Deleting your copy, marking the ticket withdrawn and synchronising
   that change does not remove the image from their device. Encryption protects a file
   in transit and at rest, not after a legitimate import.
2. **Assignment is a social agreement, not an enforcement mechanism.** Two people can
   arrive with the same barcode. The first one through gets in. The door scanner
   (§7) notices the second one; it cannot prevent them.
3. **The realistic goal is preventing mistakes, keeping an audit trail, and keeping the
   exposure window small** — not making duplication impossible.

Anything in this document that appears to promise more than that is a documentation
bug. Please report it.

---

## 2. Keys

Two tiers, and the split exists so that compromising the database is not enough.

- A **server master key**, generated on first boot and stored in the data directory. It
  wraps everything below it.
- A **data encryption key per user**, wrapped by the master key _and_ by a key derived
  from that user's vault passphrase. The server can hold the wrapped form indefinitely
  and cannot unwrap it without the passphrase.
- An **event data key per event**, sealed under the master key, wrapped for the creator
  and — when the event has a password — for a slot derived from that password.

The consequence: an attacker with the database and the server environment together
still has nothing readable without a passphrase that is never stored.

### The vault passphrase is not the login credential

Deliberately, and it is the design decision most often mistaken for a mistake. Signing
in with Google, Microsoft or a passkey provides no secret to derive a key from, so a
uniform encryption scheme needs a secret of its own. The trade-off is honest and stated
in the interface: **forget the passphrase and the data is gone** unless the recovery
code was kept.

No route lets an administrator set somebody's vault passphrase, including at account
creation. A passphrase the administrator knows is a vault the administrator can read,
which would undo the whole design.

---

## 3. What is encrypted, and what is not

Encryption is **selective**, on purpose. A database where every column is ciphertext is
a database that cannot be queried, and the result is either a slow product or a cache
of plaintext somewhere worse.

Ciphertext:

- barcode payloads,
- ticket documents and event images,
- real names, holder labels, notes,
- payment amounts,
- notification payloads.

Plaintext, because the server has to be able to act on them without a key:

- identifiers and the relations between them,
- timestamps,
- assignment state, payment state, and the visibility flags,
- the event's start time, its icon and its colour — so a wallet can be sorted and drawn
  before any key is open,
- whether a seat has been through the door, and how many times.

Email addresses are neither: they are stored encrypted and looked up through an **HMAC
blind index**, so "is this address registered?" is answerable without the address being
readable in the table.

**What this leaks.** Somebody with the database learns how many events exist, how many
tickets each has, when they start, who holds which one, and who has paid — but not what
any of it is called, and not a single barcode. That is the line, and it is drawn where
it is because the alternative is a product that cannot list your tickets.

---

## 4. Passwords and authentication

- **Passwords** are hashed with Argon2id and never stored or logged in a recoverable
  form.
- **Sessions** use a short-lived access token in memory and a long-lived refresh token
  in an httpOnly cookie scoped to the refresh endpoint. No script on the page can read
  the refresh token; the access token is never written to `localStorage`, which any
  injected script could read and which opens a wallet of bearer tickets.
- **Rotation**: refreshing replaces the token and keeps the previous hash for a brief
  grace, so a dropped response does not strand a client.
- **Second factor**: TOTP (several authenticators per account) and email one-time
  codes.
- **Passkeys**: WebAuthn, including the Android app's `apk-key-hash` origin, read from
  `assetlinks.json` rather than configured twice.
- **Delegated sign-in**: OAuth2/OpenID Connect with Google and Microsoft, offered only
  when the instance has credentials for it.

Administration refuses two things outright, because recovering from either would mean
editing the database by hand: removing the last administrator, and suspending yourself.

---

## 5. The interchange file

A `.tkpak` is a ZIP holding a cleartext manifest, an AES-256-GCM encrypted payload,
encrypted document blobs, and an Ed25519 signature. The manifest stays readable so the
app can say what a file contains and which key it needs _before_ asking for a password,
and so a future version number produces a clear message rather than a decryption
failure.

The format is specified in [spec/tkpak-v1.md](spec/tkpak-v1.md) and both
implementations run the same reference vectors in `spec/vectors`.

Signature verification tells you the file was not altered after it was made. It does
**not** tell you the sender is entitled to what is inside: anybody can sign anything
they hold. An unknown issuer is reported as unknown rather than as invalid.

---

## 6. Withholding a code

The creator can hold a barcode back until a moment, until a number of hours before the
event, or by hand, and an unpaid seat can be kept locked. The server is the authority
for all of it — the device is not trusted to decide when to unlock a code it holds.

The line that cannot be crossed back: **once a holder has downloaded their code, it
cannot be blocked again.** A QR that has been on a screen may already be in a
photograph, so a block after that point would be a promise the interface cannot keep,
and it is refused rather than accepted and quietly ineffective.

Fetching the _pass_ — the page the code is printed on — counts as the same reveal, for
the same reason: it is the code in another shape.

---

## 7. The door

Scanning at a gate marks a seat used and reports a second presentation with the time of
the first and a count. Re-read §1.2 before relying on it: this is **detection, not
prevention**. What it changes is that a duplicated code is noticed while the person
holding it is standing in front of somebody, instead of being discovered by whoever is
refused afterwards.

Only the creator and the organisers they name may work a door. A member cannot: being
given a seat is not being given the guest list.

---

## 8. The web interface

- The service worker caches the application shell and **never caches anything from the
  API**. A cached barcode response would be a bearer token written to disk, outliving
  the tab, the sign-out and the locked vault.
- Barcodes are drawn in the browser from the value the download returned. The server
  never renders a code, and nothing is fetched from a CDN — which also means a ticket
  displays in a venue with no signal.
- The camera used at the door decodes frames locally. No image leaves the device.

---

## 9. Reporting a vulnerability

Privately, please: see [SECURITY.md](../SECURITY.md). If what you have found is that
this document overstates a protection, that is a vulnerability report too.
