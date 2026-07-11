# Voxium E2E DM Protocol Specification (v1 — "olm1")

Status: **shipped (Phase B MVP)** · Engine: vodozemac `=0.10.0` · Envelope: `v1` / engine `olm1`

This document is normative for the client, the server, and the WASM binding
layer. Anything ambiguous here is a spec bug — fix the doc, not just the code.

---

## 1. Goals and threat model

**Goal:** the server (and anyone who compromises it or its database/backups)
must not be able to read DM message bodies in E2E-enabled conversations, and
must not be able to silently substitute participants' keys without the
participants being able to detect it (safety numbers).

In scope:
- Passive server compromise (DB dump, backup theft, malicious operator reads).
- Active server key-substitution attacks → **detectable** via safety-number
  comparison (§8); TOFU pinning limits the window (§4.4).
- Network attackers (TLS already covers transport; E2E covers TLS termination).

Out of scope (MVP):
- Endpoint compromise (malware on a participant's device).
- Metadata (who talks to whom, when, message sizes — the server necessarily sees this).
- Server-channel messages (server-side encrypted only; many-member E2E is a
  separate effort).
- A malicious *web-served* client build. The Tauri desktop app ships signed
  code via installers, so the server cannot inject code into it; browser dev
  builds trust the serving host by construction.

## 2. Cryptographic protocol

Olm (Matrix's Double Ratchet variant: triple-DH X3DH-style establishment +
Double Ratchet messaging), as implemented by
[vodozemac](https://github.com/matrix-org/vodozemac) — audited by Least
Authority (2022), Apache-2.0.

- **Version pin:** `vodozemac = "=0.10.0"` (Cargo.toml, `packages/crypto-engine`).
  0.10.0 includes the defense-in-depth responses to the February 2026 report:
  fallible `diffie_hellman()` (all-zero shared-secret check) and strict Ed25519
  signature verification by default. Bumps are gated by the watch workflow (§10).
- **Session config:** `SessionConfig::version_1()` — the upstream default,
  set explicitly in the binding so an upstream default change cannot silently
  alter the wire format.
- Properties: forward secrecy per message key; break-in recovery via the DH
  ratchet within a session. **No post-quantum protection** — a PQ engine
  (envelope `e` field ≠ `olm1`) is the planned Phase C evaluation.

## 3. Architecture: the engine boundary

```
UI / stores  →  services/e2e/dmCrypto.ts   (display glue; no crypto)
             →  services/e2e/e2eService.ts (orchestration; no crypto)
             →  services/e2e/vault.ts      (IndexedDB persistence; no crypto)
             →  @voxium/crypto-engine      (wasm-bindgen marshalling; no crypto LOGIC)
             →  vodozemac (Rust→WASM)      (ALL cryptography)
```

**Binding rule (hard):** `packages/crypto-engine/src/lib.rs` is pure
marshalling — base64/UTF-8 conversion and type wrapping only. No key
derivation, MAC, or signature construction may be added there or anywhere in
JS. The only computation it performs beyond encoding is the safety-number
digest (§8), which operates exclusively on public keys. The one secret JS
handles is the 32-byte pickle key (§7.3).

The engine is versioned: envelopes carry `e: "olm1"`, and
`engine_version()` reports `olm1/vodozemac-0.10.0`. A future engine (e.g.
post-quantum) is introduced as `e: "<new-id>"` — clients negotiate by
re-establishing sessions; old envelopes remain decodable from the cache.

## 4. Key hierarchy & authenticated key distribution

Each user has **one E2E device** (MVP; multi-device is Phase C). A device is a
vodozemac `Account` holding:

| Key | Type | Role |
|---|---|---|
| `ed25519Key` | Ed25519 | **Device signing root.** Signs all published key material. Anchor of the safety number. |
| `curve25519Key` | Curve25519 | Olm identity key (session establishment DH). |
| one-time keys | Curve25519 | Single-use pre-keys, consumed per inbound session. |
| fallback key | Curve25519 | Reusable pre-key handed out when OTKs are exhausted (prevents drain-DoS). |

All binary values crossing any boundary are **unpadded standard base64**
(vodozemac's canonical encoding). 32-byte keys are exactly 43 chars, Ed25519
signatures exactly 86 chars — validated by regex on the server.

### 4.1 Signature canonicals

Signed with the device's Ed25519 key over UTF-8 strings with a versioned
domain prefix (`packages/shared/src/e2e.ts` is the single source of truth):

```
device binding:  voxium-e2e-v1|device|<userId>|<curve25519_b64>|<ed25519_b64>
key binding:     voxium-e2e-v1|key|<userId>|<curve25519_identity_b64>|<keyId_b64>|<key_b64>
```

Every field is included so neither the server nor a MITM can splice keys
across users or identities: a one-time key is bound to the user AND the
identity key it belongs to.

### 4.2 Registration (`PUT /api/v1/e2e/devices`)

Client sends `{curve25519Key, ed25519Key, deviceSignature, oneTimeKeys[],
fallbackKey}` where every key entry is `{keyId, key, signature}`. The server:

1. Validates all encodings (regexes above).
2. **Verifies every signature** (Node ed25519, `utils/e2eVerify.ts`). This is
   hygiene, not trust: it stops broken clients from publishing key material
   every peer would reject. The authoritative verification is client-side (§4.3).
3. Upserts the device; replacing a device **deletes all previous one-time
   keys** (they belong to the dead account) in the same transaction.

Re-registering with a different identity invalidates the previous install —
one active E2E device per user (MVP). Peers see a safety-number change.

### 4.3 Bundle claim (`POST /api/v1/e2e/bundles/:userId`)

Guards: requester must share a conversation with the target (limits pre-key
harvesting); per-user rate limit (`e2eBundle`, 15/min) further slows draining;
fallback key guarantees exhaustion is never a hard DoS.

The server pops the oldest OTK **atomically**
(`DELETE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`) so
concurrent claims can never receive the same one-time key. When none remain it
returns the (reusable) fallback key, marked `type: "fallback"`.

**Client-side verification — MANDATORY before any session is built**
(`e2eService.createOutboundSession` / `verifyAndPinIdentity`):

1. Verify `deviceSignature` over the device canonical with the bundle's
   `ed25519Key` (binds ed25519 ↔ curve25519 ↔ userId).
2. Verify the pre-key's `signature` over the key canonical with the same
   `ed25519Key` (binds the pre-key to that identity).
3. Compare `(curve25519Key, ed25519Key)` against the **pinned identity** for
   that user (§4.4). Mismatch → hard `E2EIdentityChangedError`; nothing is
   sent until the user explicitly accepts the new identity.
4. Only then: `Account::create_outbound_session` (vodozemac re-checks the DH
   contribution; 0.10.0 rejects all-zero shared secrets).

Inbound (`createInboundSession`) passes the **pinned** identity key to
vodozemac, which rejects pre-key messages not created by that identity.

### 4.4 Trust model

Trust-on-first-use: the first identity seen for a peer is pinned in the vault.
Safety-number comparison (§8) upgrades a pin to *verified*. Any later change
is a hard error surfaced in the UI (shield-alert badge + warning modal) and
requires explicit "Accept new keys". Accepting re-pins (unverified) and drops
the dead session.

## 5. Enabling encryption on a conversation

`POST /api/v1/dm/:conversationId/encryption` — participant-only.

- Requires **both** participants to have registered devices (409 otherwise).
- Sets `Conversation.encryptedAt` (race-safe: `UPDATE … WHERE encrypted_at IS
  NULL`). **Irreversible.** From that moment the server rejects plaintext user
  messages in the conversation — an outdated client gets a hard 400, never a
  silent downgrade.
- Emits `dm:encryption_enabled` to the DM room + a plaintext `type: system`
  notice message (server-generated metadata, not user content).
- Idempotent: enabling an encrypted conversation returns the existing timestamp.

Messages sent *before* enablement remain plaintext history.

## 6. Message envelope

`Message.content` for `Message.encrypted = true` rows is exactly:

```json
{"v":1,"e":"olm1","t":<0|1>,"b":"<unpadded-base64 olm ciphertext>"}
```

- `v` envelope version · `e` engine id · `t` Olm message type (0 = pre-key,
  1 = normal) · `b` ciphertext from `Session::encrypt`.
- Server validation (`parseE2EEnvelope`, shared): strict JSON shape (exactly 4
  keys), engine/type whitelist, base64 charset, ≤ 32 768 chars. **Never
  sanitized** (sanitizeText would corrupt ciphertext), never mention-resolved,
  **excluded from server search** (`encrypted: false` filter — the pg_trgm
  index never matches ciphertext).
- Server-side enforcement in an encrypted conversation: `encrypted: true`
  required, valid envelope required, **attachments rejected**, **edits
  rejected** (an edit is a fresh ratchet ciphertext an offline peer could
  never decrypt after refetch). Deletes and reactions work normally
  (metadata).
- Client plaintext limit stays `MESSAGE_MAX` (4000 chars) pre-encryption.

## 7. Client persistence (vault)

Per account, IndexedDB `voxium-e2e-{userId}` (`services/e2e/vault.ts`):

| Key | Value |
|---|---|
| `account` | Olm account pickle (encrypted **inside vodozemac**, ChaCha20-Poly1305, pickle key) |
| `session:{peerUserId}` | Olm session pickle (same encryption) |
| `identity:{peerUserId}` | pinned `{curve25519Key, ed25519Key, verified}` |
| `pt:{messageId}` | decrypted plaintext `{conversationId, text}` |

### 7.1 Why a plaintext cache is load-bearing

Ratchet message keys are **one-shot**: a ciphertext can be decrypted exactly
once. Every fetch from the server returns ciphertext, so the client decrypts
each message once (socket event or history fetch) and serves every later
render from the cache, keyed by server message id. Own sent messages are
cached at send time (Olm does not encrypt-to-self). An encrypted message whose
plaintext is not in the vault (new install, cleared storage) renders an honest
"Unable to decrypt" placeholder — by design, history does not follow devices.

### 7.2 Ordering

All account/session mutations run through a serial queue and are re-pickled
to the vault in the same order the ratchet advances.

### 7.3 Pickle key

32 random bytes per account; the only secret JS handles. Pickle
encryption/decryption itself happens inside vodozemac; the binding zeroizes
its copy after each use.

**Storage (Phase C hardening, shipped):** in the Tauri desktop app the key
lives in the **OS credential store** (Windows Credential Manager / macOS
Keychain / Linux Secret Service) under service `app.voxium.e2e-pickle-key`,
account = userId, via the `e2e_pickle_key_get/set` Tauri commands (`keyring`
crate v3; the service name is hardcoded on the Rust side of the IPC boundary
so webview code can only reach Voxium's own entries, and inputs are
shape-validated). Pre-keychain installs are migrated out of localStorage on
first load — the plaintext copy is deleted only after a verified read-back
from the keychain. Browser dev builds (and keychain failures) fall back to
localStorage (`voxium_e2e_pk_{userId}`) — fail-soft, because a key that can't
be persisted at all would orphan every pickle in the vault. Backends implement
`PickleKeyProvider` (`services/e2e/pickleKeyProvider.ts`).

If the pickle key is lost while the vault survives, the client detects
undecryptable pickles and regenerates a fresh identity (safety number
changes — the honest signal).

## 8. Safety numbers

Computed in the Rust binding (public keys only):

```
half(user) = first 30 bytes of SHA-512^5200("voxium-sn-v1" || ed25519 || curve25519 || userId)
             → six 5-digit groups (5-byte BE chunks mod 100000)
safety_number = concat(sort(half(A), half(B)))   // 60 digits, same on both sides
```

Rendered as 12 groups of 5 digits. Users compare out-of-band and "Mark as
verified" (stored on the pinned identity). Any identity change resets
verification and shows a warning.

## 9. Product behavior summary

| Surface | Behavior |
|---|---|
| Message timeline | decrypted before entering any store; lock placeholder on failure |
| DM list preview | decrypted live; cache-hydrated on fetch; "🔒 Encrypted message" fallback |
| Reply previews | resolved from plaintext cache; lock placeholder otherwise |
| Notifications | client decrypts first → body shows plaintext locally (never leaves device) |
| Server search | E2E messages excluded server-side; client-side search is Phase C |
| Reports | reporter's client attaches its decrypted plaintext (`reportedContent`); stored with `contentSource: "reporter"` — flagged unverifiable, ciphertext never copied |
| Attachments | blocked in E2E conversations (Phase C: client-side encrypted attachments) |
| Edits | blocked for E2E messages (Phase C) |
| Logout | WASM objects freed, vault closed but **kept** (device keys persist like trusted-device tokens) |

## 10. Supply-chain policy

- **Version pinning:** vodozemac pinned exactly (`=0.10.0`); the built WASM
  artifact is vendored in-repo (`packages/crypto-engine/pkg`) so builds don't
  need a Rust toolchain. Rebuild: `pnpm --filter @voxium/crypto-engine build:wasm`
  (requires rustup target `wasm32-unknown-unknown` + wasm-pack).
- **Watch:** `.github/workflows/crypto-deps-watch.yml` runs weekly — checks
  crates.io for newer vodozemac releases and runs `cargo audit` (RustSec)
  against the lockfile; fails loudly so bumps are reviewed deliberately.
- **License:** full crypto dependency tree verified Apache-2.0 / MIT / BSD-2/3
  / Unicode-3.0 / Unlicense-only (snapshot 2026-07-11 via `cargo metadata`;
  vodozemac itself Apache-2.0, dalek crates BSD-3, RustCrypto MIT/Apache).
  **No GPL/AGPL/LGPL anywhere in the tree.** The watch workflow re-checks on
  dependency changes.

## 11. Known limitations (deliberate, tracked for Phase C)

1. Single device per account; new device ⇒ new identity ⇒ safety-number change; no history transfer.
2. No post-quantum protection (engine swap path reserved via envelope `e` field).
3. ~~Pickle key in localStorage pending OS-keychain wrapping~~ — shipped in Phase C (§7.3); localStorage remains only as the browser-dev / keychain-failure fallback.
4. No encrypted attachments / edits / client-side search of E2E history.
5. Group (server-channel) E2E out of scope.
6. Metadata (participants, timing, sizes) visible to the server, as in Signal-style designs generally.
