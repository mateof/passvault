# Threat model

This document states what PassVault protects, what it does not, and why. It is
deliberately placed before the architecture documentation, because several designs
that look weaker on paper were chosen precisely because the stronger-looking
alternative protects nothing real.

## The asset is a bearer token

A ticket's value is a barcode. A turnstile scans it, checks it against the
promoter's system, and admits whoever is holding the phone. Nothing about that
transaction involves PassVault, the person the ticket was assigned to, or whether
they paid.

Three consequences follow, and they bound everything else in this document.

### 1. There is no revocation

Once a recipient legitimately imports a `.tkpak` file or receives a ticket over a
local transfer, the barcode is on their device. They can screenshot it, export it
again, or print it. PassVault can mark the ticket withdrawn, propagate that state
to every synchronised device, and refuse to display it in its own interface — and
none of that removes the copy the recipient already has.

Any feature described as "revoking" a shared ticket would be a lie. The app
therefore speaks of *withdrawing* a ticket, which is an accounting operation, and
says so in the interface.

**What can be done instead:** record that the export happened, to whom and when;
mark the local copy as transferred so the sender does not also present it; and
keep the number of copies in circulation visible.

### 2. Assignment is a social agreement

Two people holding the same barcode is a situation the venue resolves, not the
app. Assignment prevents the *mistake* of two friends believing the same seat is
theirs. It does not prevent a determined duplicate.

### 3. The goal is error prevention, traceability and a small exposure window

Stated positively, PassVault aims to:

- make it hard to send the wrong ticket to the wrong person;
- make it hard for a ticket to be readable by someone it was not sent to;
- record who claimed, received or paid for what;
- keep plaintext barcodes out of databases, backups and logs.

Those are achievable. "Nobody can ever use a ticket twice" is not.

## Actors

| Actor | Capabilities assumed |
| --- | --- |
| Ticket holder | Legitimate user. Holds their own tickets and can copy them. Not trusted to be careful. |
| Event organiser | Creates events, ingests documents, assigns tickets, records payments. Trusted with the event's contents by definition. |
| Group member | Has access to an event but not necessarily to every ticket in it. |
| Passive network attacker | Reads traffic on the local Wi-Fi or the internet path. |
| Active network attacker | Also injects, modifies and replays; can announce a service on the local network under any name. |
| Server operator | Can read the database, the environment and process memory. Distinct from the users. |
| Database thief | Has the database file or a dump, and nothing else. |
| Device thief | Has an unlocked or locked phone. |

The server operator is explicitly *not* fully trusted, which is the point of the
vault passphrase.

## Surfaces and what protects them

### Data at rest on the server

**Threats:** stolen database dump; a leaked backup; an operator reading tickets
they were not given.

**Design:** application-layer encryption, applied selectively. Barcode payloads,
ticket documents, real names, notes and amounts are AES-256-GCM ciphertext.
Identifiers, relations, states and timestamps are plaintext, because they are what
indexes and queries need — encrypting them would make the system unusable while
adding little, since knowing that user 7 holds ticket 12 is far less damaging than
holding the barcode.

Keys are wrapped in two tiers. A server master key (`MASTER_KEY`, from the
environment) wraps each user's data encryption key. The same key is independently
wrapped by a key derived from the user's vault passphrase with Argon2id, and
optionally by a recovery code.

| Attacker has | Result |
| --- | --- |
| Database only | Nothing readable. Both wrapping keys are missing. |
| Database + `MASTER_KEY` | Nothing readable. The passphrase is missing. |
| Database + `MASTER_KEY` + passphrase | Full access. This is the intended path for the legitimate user. |
| Live process memory, user session active | That user's DEK. See the accepted risk below. |

**Accepted risk:** an unwrapped DEK lives in process memory while its owner has an
active session, with a 30-minute idle and 24-hour hard expiry. An attacker with
code execution on a running server reaches the data of currently-active users.
The alternative — asking for the passphrase on every request — was rejected as
unusable.

**Not protected:** anything the plaintext columns reveal. Someone with the
database learns that an event exists, when, how many tickets it has, and who is
connected to whom. If that metadata is itself sensitive, PassVault is not the
right tool.

### Emails and lookup

**Threat:** a database thief enumerating users, or confirming whether a given
address has an account.

**Design:** addresses are encrypted, with a mirror column holding an HMAC-SHA256
blind index keyed by a server secret, which is what lookups and the unique
constraint use. Without the HMAC key the index is not reversible by scanning a
list of candidate addresses.

This also solves an unrelated portability problem: SQL Server treats two NULLs as
equal in a unique index, so a nullable email column would permit only one user
without an address. The non-null mirror column sidesteps it.

### Passwords

**Threat:** credential reuse across sites after a breach.

**Design:** Argon2id with OWASP 2024 parameters, transparently rehashed on login
when the parameters are raised. Passwords are never logged, never returned by the
API, and never stored reversibly. Login responses are constant-time with respect
to whether the account exists.

### The vault passphrase

**Threat:** the requirement for encrypted server data conflicts with federated
login. A user who signs in with Google or a passkey presents no secret from which
a key can be derived, so there is nothing to wrap their DEK with except the
server's own master key — which means the server operator can read their data.

**Design:** a vault passphrase separate from the login credential. Access and
decryption are different jobs, so they use different secrets. Every login method
then gets the same protection.

**Cost, accepted:** users must understand two secrets, and a forgotten passphrase
means unrecoverable data unless the recovery code was kept. This is stated at
signup, not in small print.

**Rejected alternative:** wrapping DEKs with the master key alone for federated
users. It creates two silently different security levels — the user has no way to
know that signing in with Google gave them less protection.

### Event passwords

**Threat:** sharing an event with the wrong group or the wrong person.

**Design:** the password derives, through Argon2id, a key that wraps the event's
DEK. The server stores the wrapped DEK and an Argon2id verifier — the verifier
only so that a wrong password produces a clear error instead of a decryption
failure.

**Why not a check:** if the password merely gated the interface, the barcodes would
already be decrypted on the recipient's device, and anyone with access to the app's
storage or the API response would read them. There would be nothing to bypass
because there would be no protection. Deriving a key means a recipient without the
password holds ciphertext.

**Limits:** the password is shared out of band, by the organiser, over whatever
messaging app they use. Its strength is whatever they chose, which is why Argon2id
and not PBKDF2. It protects against the wrong recipient, not against a recipient
who was told the password and should not have been.

### `.tkpak` files in transit

**Threats:** interception in a messaging app or mail server; a forged file
purporting to come from a friend; tampering with a file to alter which ticket is
which.

**Design:** AES-256-GCM for confidentiality and integrity, with a 96-bit random
nonce never reused, plus an Ed25519 signature over the manifest and a digest of
every part. Encryption alone would leave forgery open: anyone can produce a
well-formed encrypted file. The signature identifies the issuing device.

Where the recipient's public key is known — after a local pairing, or from a
synchronised group — the file is additionally sealed to that key, so no shared
password is needed and no one else can open it.

**Not protected:** the recipient. See consequence 1.

### Local network sharing

**Threat, and it is the sharp one:** being on the same Wi-Fi authenticates
nobody. On a café or hotel network, any device can advertise itself as
`_passvault._tcp` under the display name "Ana's PassVault". Discovery is not
identity.

**Design:** discovery over mDNS/DNS-SD, then an X25519 key agreement whose
transcript both devices hash into a **six-digit short authentication string**
displayed on each screen. The two users confirm the digits match before any ticket
moves. An active attacker interposing themselves cannot make both sides display
the same digits, so a mismatch is a detected attack rather than a glitch.

The user-facing instruction is therefore "check that both phones show the same six
digits", not "select the nearby device", and the transfer is blocked until
confirmed.

**Rejected alternative:** Google Nearby Connections. It would handle discovery and
transport, but requires Google Play Services, and an application whose main claim
is working without a server should not require Google's to hand a file to the
person next to you.

**Also considered:** SPAKE2, which authenticates a key agreement from a weak
shared PIN. It is a good fit and would allow the sender to dictate a PIN rather
than both parties comparing one. It was set aside because the short
authentication string reaches equivalent resistance to interception using only
primitives already present on both platforms, and a hand-rolled SPAKE2 in two
languages is precisely the kind of cryptographic code this project should not be
writing twice.

### Devices

**Threat:** a lost or stolen phone.

**Design:** key material lives in the Android KeyStore, hardware-backed where
available, and the app can require biometric or device-credential authentication
to open the wallet. The local database is encrypted with a KeyStore-held key.

**Important distinction:** two-factor authentication protects the *server account*.
It does nothing for a phone in someone else's hands. The app lock is a separate
control and is presented as such.

### Ingested documents

**Threat:** a malicious PDF or `.pkpass` exploiting a parser; a `.pkpass` altered
to display a different event.

**Design:** parsing happens without executing embedded JavaScript, with page count
and file size limits, and rejects structurally invalid input rather than guessing.
`.pkpass` signatures are verified against Apple's certificate chain, and a pass
whose signature does not validate is imported only after an explicit warning.

**Accepted risk:** PDF and image parsers are large attack surfaces. On the server,
ingestion runs in a worker with restricted filesystem access; the mitigation is
containment rather than a claim that the parsers are safe.

### Claim reconciliation

**Threat:** not an attacker but a correctness failure — two users claiming the
same ticket while offline, both being told it is theirs.

**Design:** claims made without connectivity are `PROVISIONAL` and shown as such.
The authority for an event (the server, or the organiser's device for a purely
local event) confirms exactly one, ordering by logical timestamp then by device
identifier hash so the outcome does not depend on clock accuracy and is the same
whoever computes it. Losers are notified explicitly and returned to the queue.

A malicious client can forge a favourable logical timestamp. The consequence is
winning a race for a free ticket, which is bounded by the pre-issued claim
coupons the organiser signed — a client cannot claim a ticket that was never
offered, nor more than its allowance.

## Out of scope

- **Denial of service.** Rate limits exist on authentication and ingestion, but
  a self-hosted instance behind a home connection is not defended against a
  determined flood.
- **Validating tickets against the promoter.** PassVault does not know whether a
  barcode is genuine or already used. It is a wallet, not a gate.
- **Preventing resale or fraud between users.** Out of the product's remit.
- **Multi-tenant isolation at the level a commercial SaaS would need.** The
  master key lives in an environment variable, not an HSM. That is right for
  self-hosting and wrong for hosting other people's data commercially.

## Reporting

Security issues should be reported privately. See [SECURITY.md](../SECURITY.md).
