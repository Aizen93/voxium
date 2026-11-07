# Security Policy

## Reporting a vulnerability

Please do not report a security problem in a public issue, pull request or
discussion: everything posted there is public at once and cannot be fully
taken back.

Report it privately through GitHub instead: open the repository's
**Security** tab and choose **Report a vulnerability**, or go straight to
<https://github.com/Aizen93/voxium/security/advisories/new>. Only the
maintainer can read the report.

If you cannot use that form, open an issue that asks for a private contact,
without any detail of the problem.

A useful report says:

- which part is affected (server, desktop or web client, admin dashboard,
  crypto engine, deployment files) and the version or commit;
- how to reproduce it, ideally against your own local instance;
- what an attacker gains, and what they need first (an account, a role in a
  space, a position on the network).

## What happens next

- We aim to acknowledge a report within 20 days.
- We confirm the problem, work on a fix, and keep you informed along the way.
- We agree a disclosure date with you. Once the fix is released, we publish a
  GitHub security advisory that credits you, unless you prefer not to be
  named.

Voxium does not pay bug bounties.

## Testing

Test against an instance you run yourself (see
[CONTRIBUTING.md](CONTRIBUTING.md) for a local setup). Do not test against
instances you do not run, the official Voxium service included: no scanning,
no load or denial-of-service testing, and no access to other people's
accounts or data.

## Scope

Everything in this repository: the server (`apps/server`), the desktop and
web client (`apps/desktop`), the admin dashboard (`apps/admin`), the shared
package (`packages/shared`), the crypto engine (`packages/crypto-engine`)
and the deployment files shipped here (`Dockerfile`, the compose files). The
end-to-end encryption protocol is specified in
[docs/e2e-dm-spec.md](docs/e2e-dm-spec.md).

A published advisory in a dependency is handled through regular dependency
updates; report it here only if you found a way to exploit it in Voxium.

## Supported versions

Fixes land on `develop` and ship in the next release. Only the latest
release receives security fixes.
