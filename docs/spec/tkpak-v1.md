# `.tkpak` interchange format, version 1

A `.tkpak` file carries one or more event tickets — metadata, barcodes and the
original documents — between PassVault installations without a server. It travels
over any channel that moves files: a messaging app, Bluetooth, email, a memory
card, or a direct transfer over a local network.

This document is the contract between implementations. The server and web
frontend implement it in TypeScript (`packages/tkpak`); the Android app implements
it independently in Kotlin. Both run the reference vectors in
[`spec/vectors`](../../spec/vectors); a divergence fails the test suite of
whichever side drifted.

**Status:** stable. Version 1 will not change incompatibly. Additions go into
version 2 with its own vectors.

## Design constraints

1. **No server, no account, no network.** Everything a recipient needs is in the
   file.
2. **Confidential and authenticated.** Interception yields nothing; tampering is
   detected; the issuing device is identifiable.
3. **Inspectable before decryption.** The reader must be able to say "this is a
   pass for four tickets and needs a password" without the key. A wrong password
   must produce a clear message, and a future version must produce "unsupported
   version" rather than a decryption failure.
4. **Several ways to open the same file.** A file may be openable by a password,
   by a specific recipient's key, or both, without encrypting the contents twice.
5. **Reimplementable.** No exotic primitives. AES-256-GCM, Argon2id, X25519,
   HKDF-SHA256, Ed25519 and SHA-256 are available on both platforms.

## Container

A ZIP archive. Recommended file extension `.tkpak`, media type
`application/vnd.passvault.tkpak`.

| Entry | Compression | Contents |
| --- | --- | --- |
| `manifest.json` | Deflate | Cleartext UTF-8 JSON. Describes everything else. |
| `payload.bin` | Stored | AES-256-GCM ciphertext of the ticket bundle. |
| `blobs/<blobId>.bin` | Stored | AES-256-GCM ciphertext of one document. Zero or more. |
| `signature.bin` | Stored | 64-byte raw Ed25519 signature. |

Writers must emit entries in that order. Readers must locate entries by name and
must not depend on order. Unknown entries must be ignored, so that a future
version can add parts without breaking version 1 readers that only verify what
they understand.

Ciphertext is incompressible, hence `Stored`; compressing it wastes time and,
for `manifest.json`, deflate is worth the few hundred bytes.

### Binary encoding in JSON

Every binary value inside `manifest.json` is **base64url without padding**
(RFC 4648 §5, `-` and `_`, no `=`). Readers must reject standard base64 and
padded input rather than accepting both, so that the exact-bytes signature rule
below stays meaningful.

### Limits

Readers must enforce these and fail with `LIMIT_EXCEEDED`:

| Limit | Value |
| --- | --- |
| `manifest.json` uncompressed size | 1 MiB |
| `payload.bin` size | 8 MiB |
| Single blob size | 32 MiB |
| Blob count | 512 |
| Total uncompressed size | 512 MiB |

These exist to bound a hostile archive, not because real files approach them; a
ten-ticket PDF export is typically two to six MiB.

## `manifest.json`

```json
{
  "format": "tkpak",
  "version": 1,
  "fileId": "0192f5c1-8a3e-7c44-9b21-6d5e4f3a2b10",
  "createdAt": "2026-07-30T10:15:00.000Z",
  "issuer": {
    "deviceId": "0192f5c0-1111-7000-8000-aaaabbbbcccc",
    "publicKey": "3nQvVHTGZ8kZ0m9y4qKQ1xY7pR2sT5uW8xA1bC3dE4g",
    "displayName": "Mateo"
  },
  "keySlots": [
    {
      "kind": "argon2id",
      "salt": "kZ8vQ2mT5xR7pY1a",
      "memoryKiB": 65536,
      "iterations": 3,
      "parallelism": 1,
      "wrapNonce": "aB3dE5gH7jK9",
      "wrappedFileKey": "…48 bytes…"
    },
    {
      "kind": "x25519-sealed",
      "recipientPublicKey": "…32 bytes…",
      "ephemeralPublicKey": "…32 bytes…",
      "wrapNonce": "…12 bytes…",
      "wrappedFileKey": "…48 bytes…"
    }
  ],
  "payload": {
    "nonce": "…12 bytes…",
    "sha256": "…32 bytes…",
    "byteLength": 4096
  },
  "blobs": [
    {
      "id": "0192f5c2-2222-7000-8000-ddddeeeeffff",
      "nonce": "…12 bytes…",
      "sha256": "…32 bytes…",
      "byteLength": 182344,
      "mediaType": "application/pdf"
    }
  ],
  "preview": {
    "ticketCount": 4,
    "eventName": "Festival do Norte 2026",
    "eventStartsAt": "2026-08-14T19:00:00.000Z",
    "venue": "Recinto Ferial, Vilagarcía"
  }
}
```

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `format` | yes | Always `"tkpak"`. A reader that sees anything else fails with `NOT_A_TKPAK`. |
| `version` | yes | `1`. A higher number fails with `UNSUPPORTED_VERSION` before any other processing. |
| `fileId` | yes | UUIDv7. Bound into every AAD, so parts cannot be spliced between files. |
| `createdAt` | yes | ISO-8601 UTC, millisecond precision, `Z` suffix. Informational; not trusted. |
| `issuer.deviceId` | yes | UUIDv7 of the exporting device. |
| `issuer.publicKey` | yes | Ed25519 public key, 32 bytes, which verifies `signature.bin`. |
| `issuer.displayName` | no | Free text, cleartext, untrusted. Never shown as an identity claim without saying it is unverified. |
| `keySlots` | yes | One or more. Order is significant only for presentation. |
| `payload.nonce` | yes | 12 bytes, unique per file. |
| `payload.sha256` | yes | SHA-256 of the `payload.bin` **ciphertext**, tag included. |
| `payload.byteLength` | yes | Length of `payload.bin`, tag included. |
| `blobs[].id` | yes | UUIDv7. Names the entry `blobs/<id>.bin` and is referenced from the payload. |
| `blobs[].sha256` | yes | SHA-256 of the blob ciphertext, tag included. |
| `blobs[].mediaType` | yes | One of `application/pdf`, `image/png`, `image/jpeg`, `application/vnd.apple.pkpass`. |
| `preview` | no | See the warning below. |

### `preview` is cleartext, and that is a choice

`preview` exists so a recipient learns what a file is before typing a password,
and so the app can show something better than "encrypted file". Whatever it
contains is readable by anyone who obtains the file, including a messaging
provider.

Writers must therefore treat it as opt-out. The Android app includes the event
name, start time and venue by default, because a recipient who cannot tell which
of three forwarded files is the right one is a real usability failure, and offers
a "minimal metadata" switch that emits only `ticketCount`. Readers must render
`preview` as unverified until the signature is checked — a hostile file can claim
anything.

Never place a barcode, a holder's name, a payment amount or a note in `preview`.

## Keys

### File key

A single 32-byte **file key** (FK), from a cryptographically secure RNG, encrypts
`payload.bin` and every blob. Each key slot holds FK wrapped under a different
key-encryption key, which is what lets one file be opened by a password *and* by
a named recipient without duplicating the ciphertext.

Wrapping is AES-256-GCM:

```
wrappedFileKey = AES-256-GCM(key = KEK, nonce = wrapNonce, plaintext = FK,
                             aad = "tkpak/v1/filekey:" || fileId)
```

The result is 48 bytes: 32 of ciphertext followed by the 16-byte tag. A slot whose
tag does not verify is simply the wrong key — for the `argon2id` slot, that is a
wrong password, reported as `WRONG_PASSWORD`.

### Slot kind `argon2id`

```
KEK = Argon2id(password  = UTF-8 NFC(password),
               salt      = salt,
               m         = memoryKiB,
               t         = iterations,
               p         = parallelism,
               outputLen = 32)
```

Version 1 writers use `m = 65536` KiB, `t = 3`, `p = 1`, and a 16-byte random
salt. Parameters live in the file so they can be raised without breaking existing
files; readers must use the values they read, and must reject `memoryKiB > 1048576`,
`iterations > 16` or `parallelism > 16` with `LIMIT_EXCEEDED` so a hostile file
cannot exhaust a phone's memory.

Passwords are normalised to Unicode **NFC** before encoding to UTF-8. Without a
fixed normalisation, a password typed with accents on Android and on a desktop
keyboard can produce different bytes for what the user sees as the same word.

### Slot kind `x25519-sealed`

Used when the recipient's public key is known, after a local pairing or from a
synchronised group. No password is needed and only that recipient can open the
file.

```
shared = X25519(ephemeralPrivateKey, recipientPublicKey)
KEK    = HKDF-SHA256(ikm  = shared,
                     salt = ephemeralPublicKey || recipientPublicKey,
                     info = "tkpak/v1/seal",
                     len  = 32)
```

The writer generates a fresh ephemeral pair per file and discards the private
key. A recipient identifies their slot by matching `recipientPublicKey`.

## Encryption of the parts

```
payload.bin        = AES-256-GCM(FK, payload.nonce,  bundleJson,
                                 aad = "tkpak/v1/payload:" || fileId)
blobs/<id>.bin     = AES-256-GCM(FK, blobs[i].nonce, documentBytes,
                                 aad = "tkpak/v1/blob:"    || fileId || ":" || id)
```

Each ciphertext ends with its 16-byte tag. Nonces are 12 bytes and every nonce in
a file must be distinct; reusing one under the same key would be a critical
failure, so writers draw them from the RNG and never from a counter shared across
files.

The associated data binds each part to its role and its file. Renaming a blob,
swapping two blobs, or moving a payload from one file into another all fail
authentication even if the signature is never checked.

## `signature.bin`

```
signingInput = UTF-8("tkpak/v1/manifest") || 0x00 || SHA-256(manifest.json bytes)
signature    = Ed25519-Sign(issuerPrivateKey, signingInput)
```

64 raw bytes, no encoding.

Because the manifest holds the SHA-256 of the payload and of every blob, one
signature over the manifest transitively covers the whole file. Readers must
verify, in this order:

1. `format` and `version`.
2. Limits.
3. `signature.bin` against `issuer.publicKey`.
4. The SHA-256 of `payload.bin` and of each blob against the manifest.
5. Only then unwrap a key slot and decrypt.

**The manifest is signed as the exact bytes stored in the archive.** Readers must
hash the bytes they read, never a re-serialisation of the parsed object. There is
no canonical JSON form in this specification, deliberately: requiring one is a
recurring source of interoperability bugs, and the exact-bytes rule removes the
question. Writers may format the JSON however they like; readers must keep the
original bytes alongside the parsed object.

A valid signature proves the file was produced by the holder of that Ed25519 key.
It does **not** prove the holder is who `displayName` says. Trust in the key comes
from elsewhere: a local pairing, or a group membership synchronised with a server.
An unknown issuer key is not an error — the file is `UNKNOWN_ISSUER`, and the app
imports it while telling the user the sender could not be verified.

## Payload bundle

The decrypted `payload.bin` is UTF-8 JSON:

```json
{
  "fileId": "0192f5c1-8a3e-7c44-9b21-6d5e4f3a2b10",
  "exportedAt": "2026-07-30T10:15:00.000Z",
  "exportedFor": "ana@example.org",
  "event": {
    "id": "0192f5b0-3333-7000-8000-111122223333",
    "name": "Festival do Norte 2026",
    "venue": "Recinto Ferial, Vilagarcía",
    "startsAt": "2026-08-14T19:00:00.000Z",
    "timeZone": "Europe/Madrid",
    "notes": "Doors at 18:30",
    "defaultAssignmentMode": "ASSIGNED",
    "passwordProtected": true
  },
  "tickets": [
    {
      "id": "0192f5b1-4444-7000-8000-444455556666",
      "label": "Seat 14-B",
      "section": "Grada A",
      "row": "14",
      "seat": "B",
      "barcode": { "format": "QR_CODE", "value": "8412-XXXX-1234" },
      "documentBlobId": "0192f5c2-2222-7000-8000-ddddeeeeffff",
      "documentPage": 3,
      "assignmentMode": "ASSIGNED",
      "assignment": {
        "state": "ASSIGNED",
        "holderLabel": "Ana",
        "holderUserId": null,
        "assignedAt": "2026-07-29T18:02:11.000Z"
      },
      "payment": {
        "state": "PAID",
        "amountCents": 4500,
        "currency": "EUR",
        "visibility": "HOLDER_ONLY",
        "settledAt": "2026-07-29T19:30:00.000Z"
      }
    }
  ],
  "operations": []
}
```

`fileId` is repeated inside the payload and readers must check it matches the
manifest. It is already bound by the AAD; the explicit check turns a confusing
authentication failure into a clear `FILE_ID_MISMATCH`.

`barcode.format` is one of `QR_CODE`, `AZTEC`, `PDF_417`, `CODE_128`, `CODE_39`,
`EAN_13`, `DATA_MATRIX`. `assignment.state` is one of `FREE`, `PROVISIONAL`,
`CLAIMED`, `ASSIGNED`, `TRANSFERRED`. `payment.state` is one of `UNPAID`,
`PARTIAL`, `PAID`, `WAIVED`. `payment.visibility` is one of `ALL`, `HOLDER_ONLY`,
`CREATOR_ONLY`.

### Visibility is applied before export, not after import

A writer must **omit** payment records the recipient is not entitled to see,
rather than exporting them and relying on the reader to hide them. Sending data
and asking the other side not to look is not a control. A recipient's own
`HOLDER_ONLY` record is included; other people's are not; `CREATOR_ONLY` records
appear only in an export the organiser makes for themselves, such as a backup.

### `operations`

An optional list of signed operation-log entries, letting a `.tkpak` act as a
sync transport between two devices that have no server. Entries are idempotent by
`operationId`, so importing the same file twice changes nothing. The log format is
specified in [`sync-protocol.md`](sync-protocol.md).

## Error codes

Readers report these, and the interface maps them to messages in each supported
language.

| Code | Meaning |
| --- | --- |
| `NOT_A_TKPAK` | Not a ZIP, or no `manifest.json`, or `format` is not `"tkpak"`. |
| `UNSUPPORTED_VERSION` | `version` is higher than the reader supports. |
| `MALFORMED_MANIFEST` | Invalid JSON, missing required field, or bad base64url. |
| `LIMIT_EXCEEDED` | A size, count or Argon2 parameter limit was exceeded. |
| `BAD_SIGNATURE` | `signature.bin` does not verify against `issuer.publicKey`. |
| `UNKNOWN_ISSUER` | Signature is valid but the key is not known. Not fatal. |
| `DIGEST_MISMATCH` | A part's SHA-256 does not match the manifest. |
| `WRONG_PASSWORD` | No `argon2id` slot unwrapped with the given password. |
| `NO_USABLE_KEY_SLOT` | No slot this reader can attempt. |
| `DECRYPTION_FAILED` | A GCM tag failed after a slot unwrapped successfully. Indicates tampering. |
| `FILE_ID_MISMATCH` | Payload `fileId` differs from the manifest. |

`WRONG_PASSWORD` and `DECRYPTION_FAILED` are deliberately distinct. The first is
routine and the user retypes. The second means the file was modified after being
sealed, and the app says so rather than blaming the password.

## Reference vectors

[`spec/vectors`](../../spec/vectors) holds files generated by
`npm run vectors:generate`. `index.json` lists every vector with the archive it
uses, the password or private key that opens it, and what a reader must conclude:

| Vector | Exercises | Expected |
| --- | --- | --- |
| `01-single-ticket-password` | Minimal file: one `argon2id` slot, no blobs. | opens |
| `02-multi-ticket-pdf-blobs` | Four tickets, three PDF page blobs. | opens |
| `03-sealed-to-recipient` | Only an `x25519-sealed` slot. | opens |
| `04-dual-slot-password` | Password and sealed slot over one file key. | opens |
| `04-dual-slot-recipient` | The same archive, opened by the recipient key. | opens |
| `05-pkpass-blob` | An Apple Wallet pass as a blob. | opens |
| `06-tampered-payload` | One payload byte flipped. | `DIGEST_MISMATCH` |
| `07-tampered-manifest` | Preview edited after signing. | `BAD_SIGNATURE` |
| `08-future-version` | `version: 2`, correctly signed. | `UNSUPPORTED_VERSION` |
| `09-unicode-password` | Sealed with NFC, opened with NFD. | opens |
| `10-minimal-preview` | `preview` with `ticketCount` only. | opens |
| `11-resigned-tampered-payload` | Payload altered, digest updated, re-signed. | `DECRYPTION_FAILED` |

The last two rows are worth reading together, because they show where each control
actually bites. Flipping a byte of `payload.bin` does **not** reach decryption: the
manifest carries that ciphertext's digest and the manifest is signed, so the reader
rejects the file at step 4 with `DIGEST_MISMATCH`. An attacker who wants to reach
the AES-GCM tag has to update the digest and re-sign, which needs the issuer's
private key. Vector 11 constructs exactly that — with the genuine key, and read
with `requireValidSignature` disabled — to prove the tag still refuses. In other
words `DECRYPTION_FAILED` is the last line of defence and should be rare in
practice; a reader that reports it for an ordinary corrupted download has its
verification order wrong.

The Argon2 parameters in the vectors are lowered (`m = 8192`, `t = 1`) so tests
stay fast. Production writers use the version 1 defaults; a reader honours what
the file says, which is what makes both work. The keys and passwords in
`index.json` are test material and must never appear anywhere else.
