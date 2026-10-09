# Licensing Notice

Voxium is **source-available** under the [Voxium Community License 1.0](LICENSE.md).

## License history

- Every **tagged release up to and including `v1.7.3`**, and the `main`
  branch **up to and including commit
  `e3cb3687af09ea3b9bdcd04ce174b55a6d31561c`**, was published under the GNU
  Affero General Public License v3.0 only (AGPL-3.0-only). Those versions
  remain available under that license; nothing revokes it for copies already
  obtained, and the corresponding release artifacts stay published as-is.
- **All later development** — including the entire `fix/p0-stabilization`
  development branch (never merged into `main` or released under AGPL) and
  every release after `v1.7.3` — is offered **only** under the Voxium
  Community License 1.0. The AGPL grant does not extend to it, and the
  branch history carries the Voxium Community License throughout.
  Development-branch snapshots pushed before 2026-08-14 carried the previous
  license file; any rights validly obtained from those snapshots are
  unaffected by this notice.

## Why the change

Voxium's philosophy is unchanged: anyone can read, audit, self-host, and
modify the entire codebase, and access to a Voxium instance must always be
free for its users — no paywalls, no gated features, no ads, no selling of
user data. The AGPL, however, allowed third parties to commercialize Voxium.
The Voxium Community License keeps the community freedoms while reserving
commercial exploitation to the project, which is how its maintenance is
funded (see ROADMAP.md).

## Third-party software

Voxium depends on third-party open-source packages under their own licenses
(MIT, Apache-2.0, ISC, BSD-2/3-Clause, BlueOak-1.0.0, 0BSD, Unlicense, MIT-0,
and OFL-1.1 for bundled fonts). Audited 2026-08-14: **no copyleft
(GPL/AGPL/LGPL) dependency exists in any distributed artifact.** The
Rust/WASM cryptography tree (vodozemac and its dependencies, Apache-2.0 /
MIT / BSD) is additionally re-verified on every dependency change by
`.github/workflows/crypto-deps-watch.yml`. For a current inventory, run
`pnpm licenses list --prod`.
