# Synchronisation protocol, version 1

PassVault synchronises a **log of signed operations**, not a snapshot of state. Each
device appends operations, exchanges them with whatever peer it can reach, and
derives its view by replaying them. The same log travels three ways — to the server
over HTTPS, to another phone over a local network, or inside a `.tkpak` file — so
there is one mechanism and three transports rather than three mechanisms.

This document specifies the log, how conflicts resolve, and the one place where
resolution needs an authority: claiming a free ticket.

## Why a log

The alternative, sending the current state and merging fields, loses the
information needed to decide who was first. Two devices that both moved a ticket
from `FREE` to `CLAIMED` produce identical state; only their histories differ. Since
the product's hardest case is exactly that race, the history is the thing worth
keeping.

Replaying a log also makes the offline case ordinary rather than special. A device
with no connectivity is simply one whose log has not been shared yet.

## Operation

```json
{
  "operationId": "0192f5d0-1111-7000-8000-aaaabbbbcccc",
  "deviceId": "0192f5c0-2222-7000-8000-ddddeeeeffff",
  "actorUserId": "0192f5b0-3333-7000-8000-111122223333",
  "lamport": 42,
  "wallClock": "2026-07-30T10:15:00.000Z",
  "scope": { "kind": "event", "id": "0192f5b1-4444-7000-8000-444455556666" },
  "type": "ticket.assign",
  "body": { "ticketId": "…", "holderUserId": "…" },
  "signature": "…64 bytes, base64url…"
}
```

| Field | Purpose |
| --- | --- |
| `operationId` | UUIDv7. The idempotency key: applying the same operation twice is a no-op. |
| `deviceId` | Which device produced it. Its Ed25519 key verifies the signature. |
| `actorUserId` | Who was acting. Null for a device with no account. |
| `lamport` | Logical clock, described below. |
| `wallClock` | Informational only. Never used to order anything. |
| `scope` | The event the operation belongs to. Sync is per event, so a device can share one event without exposing the rest of its wallet. |
| `type` | See the table of types. |
| `body` | Type-specific payload. Sensitive fields are already ciphertext. |
| `signature` | Ed25519 over the canonical form below. |

### Signing

```
signingInput = UTF-8("passvault/v1/operation") || 0x00 || SHA-256(canonicalBytes)
```

where `canonicalBytes` is the UTF-8 JSON of the operation **without** the
`signature` field, with object keys sorted lexicographically and no insignificant
whitespace.

This is the one place the project accepts a canonicalisation rule, and it is worth
saying why, since `.tkpak` deliberately avoids one. A manifest is a stored file, so
"sign the exact bytes" works: the bytes exist. An operation is re-serialised by every
hop that relays it — a phone reads it from a `.tkpak`, holds it in a database, and
later posts it to the server — so there are no original bytes to preserve. Sorted
keys and no whitespace is the least ambiguous rule two implementations can both
follow.

Verification uses the device's registered public key. An operation from an unknown
device is retained but not applied: it goes into a quarantine the user can inspect,
because the honest cause is usually a peer whose key has not been exchanged yet.

### Logical clock

Each device keeps a counter per event. On producing an operation it sets
`lamport = 1 + max(everything it has seen for that event)`. On receiving one it
raises its counter to at least the value received.

Ordering between two operations is `(lamport, sha256(deviceId))`, ascending. The
device hash breaks ties deterministically, so every participant computes the same
order without trusting any clock. Wall clocks are not used: a phone whose date is
wrong by a week must not win or lose a race because of it.

## Operation types

| Type | Body | Notes |
| --- | --- | --- |
| `event.create` | event fields, wrapped event key | Only the creator's device may issue it. |
| `event.update` | changed fields | Field-level last-writer-wins. |
| `access.grant` | group or user, role | |
| `access.revoke` | group or user | Removes future access. Does not recall anything already delivered. |
| `ticket.add` | ticket fields, barcode ciphertext, blob reference | |
| `ticket.remove` | ticket id | Marks withdrawn. Never deletes history. |
| `ticket.assign` | ticket id, holder | Creator only. |
| `ticket.unassign` | ticket id | Creator only. |
| `claim.coupon.issue` | ticket id, coupon, allowance | Creator only. See below. |
| `claim.request` | ticket id, coupon | Any member. Provisional until confirmed. |
| `claim.confirm` | ticket id, winning operation id | Authority only. |
| `claim.reject` | ticket id, losing operation id, reason | Authority only. |
| `ticket.transfer` | ticket id, recipient, export reference | Records that a copy left the device. |
| `payment.set` | ticket id, state, amount, visibility | Creator only. |
| `device.register` | device id, public keys | Establishes the key that verifies everything else. |

### Authorisation

Every type names who may issue it, and a replaying device enforces that rather than
trusting the sender. An operation from a member claiming to be `payment.set` is
dropped and reported, not applied. The rule is checked at replay time on every
device, so a compromised server cannot inject an assignment either.

## Conflict resolution

For everything except claims, the rule is **field-level last-writer-wins under the
logical order**. Two organisers renaming an event converge on the later rename; two
organisers editing different fields keep both edits. This is enough because those
operations are not contended in practice: the creator is a single person, usually on
a single device.

`ticket.remove` is a tombstone and wins over any concurrent edit to the same
ticket. Reviving a removed ticket is a new `ticket.add`, not an undelete, so the
history stays honest about what happened.

## Claims: the one case needing an authority

Two members without connectivity both claim the last free ticket. Both devices
believe they succeeded. No merge rule fixes this, because the correct outcome is
that one of them loses and **must be told**.

### Authority

Each event has exactly one authority:

- the **server**, for an event that has been synchronised to one;
- the **creator's device**, for a purely local event.

The authority is the only issuer of `claim.confirm` and `claim.reject`.

### Coupons

The creator issues one `claim.coupon.issue` per claimable ticket, carrying a random
coupon value and the per-member allowance. A `claim.request` must present a coupon.
This bounds what a dishonest client can attempt: it cannot claim a ticket that was
never offered, and it cannot exceed its allowance, whatever `lamport` value it
invents.

### States

```
FREE ──claim.request──> PROVISIONAL ──claim.confirm──> CLAIMED
                             │
                             └────────claim.reject───> FREE
```

`PROVISIONAL` is visible in the interface as pending confirmation, and the app never
renders it as a settled outcome. This is the single most important user-facing
consequence of the whole design: the difference between "the app was wrong" and "the
app told you it was not final yet".

### Resolution

On receiving a set of `claim.request` operations for a ticket, the authority:

1. discards requests with an invalid signature, an unknown coupon, a coupon for a
   different ticket, or from a member over their allowance;
2. sorts the remainder by `(lamport, sha256(deviceId))`;
3. issues `claim.confirm` for the first, and `claim.reject` for each of the rest,
   with a reason the interface can translate;
4. leaves the ticket `FREE` if every request was discarded.

The result is deterministic: any participant replaying the same inputs computes the
same winner, so the authority's decision is verifiable rather than arbitrary.

### What a dishonest client gains

It can inflate `lamport` and win races for free tickets. That is the whole of it: the
coupon bounds it to tickets actually offered and to its allowance, and the signature
binds each request to a device. The mitigation is proportionate — this is a
disagreement between friends over who gets the spare seat, not a financial ledger —
and the audit trail names the device that did it.

## Transport

### To the server

`POST /api/v1/sync/{eventId}` with operations the device holds and the last cursor it
saw; the response carries operations it lacks and a new cursor. Idempotent by
`operationId`, so retrying an interrupted push is safe and duplicates are counted,
not applied.

### Between two devices on a local network

Over the session established by the pairing described in
[../threat-model.md](../threat-model.md): mDNS discovery, X25519 agreement, and a
six-digit short authentication string the two users compare before anything moves.
The exchange is the same request and response as the server's.

### Inside a `.tkpak`

The `operations` array of the payload bundle. This makes a file sent over a messaging
app a complete sync transport: import applies the operations it does not have, and
importing the same file twice changes nothing.

A file cannot carry `claim.confirm` from an authority it does not speak for. A
recipient importing a file with foreign confirmations retains them for the event they
belong to and applies them only if the issuing device is that event's authority.

## Replay is deterministic and total

A device may receive operations in any order, including a `claim.confirm` before the
`claim.request` it confirms. Replay therefore:

- stores every operation it accepts, ordered by `(lamport, deviceId hash)`;
- recomputes derived state from scratch when new operations arrive out of order,
  rather than patching state forward;
- keeps operations it cannot yet apply (unknown device, missing antecedent) in
  quarantine and retries them when the missing piece arrives.

Recomputing rather than patching is deliberate. Incremental application is faster and
is where merge bugs live; an event has tens or hundreds of operations, not millions,
so the simple approach is affordable and stays correct.

## Retention

Operations are never deleted, which is what makes the audit trail meaningful and
replay total. Compaction — replacing a long prefix with a signed snapshot — is a
possible future addition and is not specified here; nothing in version 1 depends on
it existing.
