# Post-Quantum Engine Evaluation (Phase C, 2026-07)

Decision memo for the E2E DM crypto engine's post-quantum path
(docs/e2e-dm-spec.md §2 reserves the envelope `e` field for exactly this).

## Threat being addressed

**Harvest-now-decrypt-later**: an adversary recording ciphertext today could
decrypt it once a cryptographically relevant quantum computer can run Shor's
algorithm against X25519 key agreement. AES-256 and the SHA-2 family are not
meaningfully threatened (Grover only halves effective strength). So the gap is
confined to **key agreement** — session establishment and the DH ratchet steps.

## State of the art (verified 2026-07)

| Option | Status | Verdict for Voxium |
|---|---|---|
| **Signal Triple Ratchet** (Double Ratchet + SPQR sparse ML-KEM-768 ratchet, hybrid) | Shipped in Signal clients since late 2025; reference implementation lives in libsignal (Rust) | The gold standard — but libsignal still has **no supported browser/WASM build** for third parties, and Signal discourages external use of the Rust crates. Not adoptable in a webview today. |
| **vodozemac / Matrix PQ** | No protocol-level PQ at the Olm layer; Matrix's 2026 PQ work is at the TLS transport layer, with MLS integration still in progress | Our engine has **no upstream PQ upgrade path yet**. The crypto-deps-watch workflow will surface any vodozemac release that changes this. |
| **MLS (RFC 9420) with PQ ciphersuites** | PQ ciphersuites still drafts; OpenMLS wasm story immature | Premature, and group-oriented — wrong shape for 1:1 DMs. |
| **Custom hybrid outer layer** (design below) | RustCrypto `ml-kem` (FIPS 203) is pure Rust, permissive-licensed, wasm-compatible | Buildable by us **inside the existing binding** without touching Olm internals. |

## The designed path: `olm1+mlkem` hybrid outer layer (engine v2)

If we decide to close the PQ gap before upstream does, the contained design is
a **hybrid encapsulation layer around (not inside) Olm**, mirroring PQXDH's
philosophy — the classical protocol stays untouched, PQ protection wraps it:

1. Each device additionally publishes a signed **ML-KEM-768 encapsulation key**
   (same Ed25519 canonical-string scheme as today, spec §4.1 gains a
   `voxium-e2e-v1|kem|…` binding).
2. On session establishment the sender encapsulates → a 32-byte PQ shared
   secret, sends the KEM ciphertext once alongside the first pre-key message.
3. Every envelope body becomes `AES-256-GCM(key = HKDF(pq_secret, session_id),
   olm_ciphertext)` — envelope `e: "olm1+mlkem"`. An attacker must break
   **both** X25519 (Olm) and ML-KEM-768 to read anything.
4. All of it lives in the Rust binding (RustCrypto `ml-kem` + `aes-gcm` +
   `hkdf`, all Apache/MIT) — the "no crypto in JS" rule holds; JS marshals one
   more opaque field.

Honest limitation vs Signal's SPQR: the PQ secret is per-session, not
ratcheted, so PQ *forward secrecy within a session* is weaker — but
harvest-now-decrypt-later is fully addressed, which is the actual 2026 threat.

## Decision

**Do not build PQ now.** Rationale:

- Voxium's stated E2E goal (server/DB compromise must not expose plaintext) is
  fully met by olm1; the PQ gap only matters against a recording nation-state
  adversary — worth closing, but not ahead of multi-device.
- Multi-device (spec §12) changes key distribution anyway (per-device bundles,
  probable Megolm layer). Building PQ before that means building it twice.
- Upstream may deliver a vetted path first (vodozemac PQ or a libsignal WASM
  build) — strictly better than our own layer.

**Revisit triggers** (first one to fire reopens this memo):
1. vodozemac ships protocol-level PQ (crypto-deps-watch will flag the release).
2. libsignal publishes a supported browser/WASM target.
3. Multi-device implementation starts (fold `olm1+mlkem` into the new
   key-distribution design at that point).
4. RustCrypto `ml-kem` receives an independent audit (strengthens option B).
