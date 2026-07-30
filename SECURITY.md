# Reporting a security issue

Please report vulnerabilities privately rather than opening a public issue.

- Open a [private security advisory](https://github.com/mateof/passvault/security/advisories/new), or
- email **mateof@gmail.com**.

Include what you did, what happened, and what you expected. A proof of concept
helps; a full exploit is not required.

This is a personal project without a support contract, so there is no response-time
commitment. Reports are read and acted on. You will get an acknowledgement and,
where the report leads to a fix, credit in the release notes unless you prefer
otherwise.

## Scope

In scope: the server, the web frontend, the `.tkpak` format, the Android app in
[mateof/passvault-android](https://github.com/mateof/passvault-android), and the
cryptographic design in [docs/security.md](docs/security.md).

Out of scope, because they are documented properties rather than defects — see
[docs/threat-model.md](docs/threat-model.md):

- A recipient keeping a copy of a ticket they were legitimately sent. There is no
  revocation of a bearer token, and the documentation says so.
- Two people presenting the same barcode. Assignment is bookkeeping, not
  enforcement.
- Metadata visible to someone holding the database: that an event exists, when, how
  many tickets it has, and who is connected to whom.
- Reading the data of a user whose session is active, given code execution on the
  server. Their data key is in memory by design.
- Denial of service against a self-hosted instance.

A report showing that one of those properties is *worse than documented* is in
scope and welcome.

## Supported versions

The latest release on `main`. This project has no long-term support branches.
