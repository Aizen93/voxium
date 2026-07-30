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

Each user may register up to `E2E_LIMITS.MAX_DEVICES` (5) devices — see §12
for the multi-device protocol. A device is a vodozemac `Account` holding:

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
device binding:  voxium-e2e-v2|device|<userId>|<deviceId>|<curve25519_b64>|<ed25519_b64>
key binding:     voxium-e2e-v2|key|<userId>|<deviceId>|<curve25519_identity_b64>|<keyId_b64>|<key_b64>
```

Every field is included so neither the server nor a MITM can splice keys
across users, devices, or identities: a one-time key is bound to the user, the
**device**, AND the identity key it belongs to. There is no v1 verification
path anywhere — the domain string changed with multi-device (§12.1).

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

### 4.3 Bundle claim (`POST /api/v1/e2e/bundles/:userId/:deviceId`)

Guards: requester must share a conversation with the target (limits pre-key
harvesting); per-user rate limit (`e2eBundle`, 15/min) further slows draining;
fallback key guarantees exhaustion is never a hard DoS.

The server pops the oldest OTK **atomically**
(`DELETE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`) so
concurrent claims can never receive the same one-time key. When none remain it
returns the (reusable) fallback key, marked `type: "fallback"`.

**Client-side verification — MANDATORY before any session is built**
(`e2eService.ensureOlmSession` / `pinDevice`):

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
| `identity:{peerUserId}:{deviceId}` | pinned `{curve25519Key, ed25519Key, verified}`, per device |
| `dlv:{userId}` | last seen / acknowledged device list (drives the injection warning, §12.5) |
| `gs:{conversationId}` | our outbound Megolm session (pickle + rotation bookkeeping) |
| `igs:{sessionId}` | an inbound Megolm session + the attribution it arrived under |
| `pt:{messageId}` | decrypted plaintext `{conversationId, text}` |

Only the `pickle` fields are encrypted (by vodozemac, under the pickle key).
Everything else in a record — session ids, device ids, counters, and the
plaintext cache — is readable by anyone who can read the IndexedDB file. **No
raw Megolm or Olm key material is ever stored outside a pickle**: key-share
retries re-derive the key from the encrypted inbound session via
`exportAtFirstKnownIndex()` rather than keeping a copy (§12.4).

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
| Attachments | encrypted client-side (AES-256-GCM in the binding); real metadata inside the message ciphertext; server stores opaque blobs (§13) |
| Edits | fresh ratchet ciphertext under the same id; plaintext cache versioned by editedAt |
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

## 11. Known limitations

1. ~~Single device per account~~ — shipped in Phase C (§12): up to 5 devices, Megolm group sessions with pairwise key shares. History still does not follow a new device (no key backup). (Design: §12.)
2. No post-quantum protection — evaluated and deliberately deferred; designed path + revisit triggers in `docs/e2e-pq-evaluation.md`.
3. ~~Pickle key in localStorage pending OS-keychain wrapping~~ — shipped in Phase C (§7.3); localStorage remains only as the browser-dev / keychain-failure fallback.
4. ~~No edits~~ — shipped in Phase C: edits are fresh ratchet ciphertexts under the same id; the plaintext cache is versioned by `editedAt` (§6, §7.1).
5. ~~No client-side search~~ — shipped in Phase C: encrypted conversations search this device's plaintext cache (coverage = what this device decrypted; §9).
6. ~~No encrypted attachments~~ — shipped in Phase C (§13); the server can still see ciphertext sizes and upload timing (metadata, limitation 8).
7. Group (server-channel) E2E out of scope.
8. Metadata (participants, timing, sizes) visible to the server, as in Signal-style designs generally.

## 12. Multi-device (Phase C, shipped)

Each account may register up to `E2E_LIMITS.MAX_DEVICES` (5) devices. Message
bodies are encrypted **once** with Megolm; the group-session key is distributed
pairwise over Olm to every participating device — the peer's and the sender's
own others.

### 12.1 Identity and registration

- `deviceId` is client-generated (`/^[A-Za-z0-9_-]{8,32}$/`), stable per
  install, stored in the vault. `E2EDevice` is keyed `@@unique([userId, deviceId])`.
- Signature canonicals are **v2** and include the deviceId, so a signature can
  never be replayed onto a different device or user:
  `voxium-e2e-v2|device|<userId>|<deviceId>|<curve>|<ed>` and
  `voxium-e2e-v2|key|<userId>|<deviceId>|<curveIdentity>|<keyId>|<key>`.
- `E2EDeviceRegistry.version` is bumped in the **same transaction** as any
  device add or revoke; `GET /e2e/devices/:userId` returns `{devices[], listVersion}`.

### 12.2 Envelope

New sends use `{"v":1,"e":"megolm1","sid":"<session id>","b":"<ciphertext>"}`.
`olm1` remains valid: it is the key-share transport, and legacy history keeps
decrypting. Both are validated structurally by `parseE2EEnvelope`.

### 12.3 Key shares (`E2EKeyShare` mailbox)

Share plaintext (inside the pairwise Olm ciphertext):
`{v:2, conversationId, sessionId, sessionKey, senderUserId, senderDeviceId}`.

Server-side rules — every one of these is load-bearing:

- **Sender attribution** must be truthful: the claimed sender device must belong
  to the caller.
- **Conversation gate**: the sender must be a participant of the share's
  `conversationId`, and the recipient must be the sender (own other device) or
  the other participant. Without this, a DM peer could plant inbound-session
  records labelled with a conversation they are not in.
- **Recipient devices must exist**. Rows addressed to fabricated device ids
  would never be claimable and never expire — an unbounded, third-party-writable
  storage sink.
- **The inbox cap is per (sender, recipient device)** and evicts only that
  sender's oldest rows (`KEYSHARE_STORE_CAP_PER_SENDER`). A shared per-recipient
  cap would let anyone who can DM a victim flood the mailbox and evict the
  session keys a legitimate peer had queued — remote, unprivileged censorship of
  an E2E conversation.
- Claiming (`GET /e2e/keyshares?deviceId=`) is **claim-and-delete**, ownership
  checked, `FOR UPDATE SKIP LOCKED` (Olm pre-key bodies are one-shot).
- Bodies are capped at `KEYSHARE_BODY_MAX` (2 KB — a real Olm share is ~600
  bytes; `ENVELOPE_MAX` would allow 50x that), and a sender may hold at most
  `KEYSHARE_SENDER_TOTAL_CAP` (2000) undelivered shares across **all**
  recipients. The per-recipient cap alone is not a bound, because any account
  can open a DM with any user, making "number of conversations" attacker-chosen.
- Recipient-device existence is checked **inside** the write transaction, so a
  concurrent revoke cannot leave orphaned rows.
- Undelivered shares are swept after `KEYSHARE_MAX_AGE_MS` (30 days) by
  `utils/keyShareCleanup.ts`, which is indexed on `created_at` (the sweep runs
  across all recipients; the recipient-scoped composite index cannot serve it).
  The table intentionally has no FK to `User`, so the sweep is also what
  reclaims rows after account deletion.
- Claiming drains **every** page, not just the first: the inbox is oldest-first,
  so stopping at one page would let queued older shares delay a live one.

Client-side, the importer verifies the share's `sessionId` and `conversationId`
match the row, takes sender attribution from the **authenticated Olm session**
(pinned per-device identity) rather than the share body, and re-derives the
session id from the key. On Megolm decrypt, `message.authorId` must equal the
inbound session's `senderUserId`, else the message is treated as undecryptable.

### 12.4 Rotation

A new outbound session is created when: none exists, either participant's
**device set** changed, `GROUP_SESSION_MAX_MESSAGES` (100) is reached, or the
session is older than `GROUP_SESSION_MAX_AGE_MS` (7 days).

Rotation keys off the device **set fingerprint**, not the server-supplied
`listVersion` — a server that injects a device while replaying the old version
must still force a re-key. The rotation decision always fetches device lists
with `force: true`, so a revoked device cannot keep receiving keys for the
cache window.

An undelivered share does **not** rotate. The share is retried on the same
session behind a 30s backoff and is dropped after 10 rounds: rotating on every
transient failure would burn peer one-time keys, flood inboxes, and
self-amplify. The retry is lossless — the key is re-derived at the session's
first known index from our own (encrypted) inbound copy via
`exportAtFirstKnownIndex()`, so the recovering device can still read the
messages it missed. Because it travels as an **ExportedSessionKey**, the share
payload carries `keyType: 'exported'` and the importer uses
`fromExportedSessionKey`.

**Both** device lists are fetched fresh when deciding to rotate. A stale peer
list keeps feeding session keys to a revoked device; a stale *own* list
silently skips the fanout to a device the user just added, leaving those
messages permanently unreadable there (a 15s window was tried and the live
multi-device test caught exactly that). Concurrent fetches for the same user
are coalesced into one request, and `e2eStatus` is budgeted for the resulting
read rate (300/min) because these reads sit on the message-send path.

Revoking a device also clears it from the unacknowledged set — revocation *is*
the user dealing with it, and the warning must not outlive the device.

If **every** device of the peer fails signature verification (or they revoked
them all), sending fails loudly rather than producing ciphertext nobody can
read.

### 12.5 Trust and detection

- Per-device TOFU pinning (`identity:{userId}:{deviceId}`) and per-device safety
  numbers; a pinned device whose keys change is a hard `E2EIdentityChangedError`.
- **The device set — not `listVersion` — drives the new-device warning.** A
  hostile server can replay or roll back the version; it cannot make the set it
  serves match what the user acknowledged.
- The service emits device-list change events (`onDeviceListChanged`), which the
  store subscribes to, so a device appearing mid-conversation raises the warning
  immediately instead of at the next component mount.
- **This applies to our OWN account too.** A server that registers a device
  under the local user's id would otherwise receive every session key we fan
  out with no signal at all — the mirror image of peer injection. Unrecognised
  own devices raise the same warning badge and are highlighted in the device
  manager until acknowledged.
- Warnings are **sticky**: the set of device ids seen since the last
  acknowledgement is persisted, so a server that adds a device and then
  withdraws it cannot erase the notice — the device keeps whatever session key
  it was already given. Acknowledgement applies only to the exact devices the
  UI displayed, so one confirmation can never bless a change the user was not
  shown.
- Detection is advisory, not blocking: a newly-appeared device still receives
  the session key in the same operation (matching Signal's model). The control
  is that the user is told, verifiably and promptly — not that key delivery is
  withheld.
- `acceptNewIdentity` re-pins every device unverified, drops pairwise sessions,
  drops **inbound group sessions attributed to that user** (otherwise the holder
  of the old keys could keep publishing into a session we still trust), and
  clears outbound sessions to force a re-key.

### 12.6 Known gaps

- The `MAX_DEVICES` check is read-then-write inside a transaction with no
  DB-level constraint; two concurrent registrations could both observe 4. Bounded
  by `rateLimitE2EDevice` (5/hour) and harmless (a 6th device is still fully
  authenticated).
- History does not follow a new device (no key backup) — by design, §11.
- ~~Cross-signing~~ — shipped, see §14: one safety number per account, and
  device trust is now a signature check rather than a user judgement call.

### 12.7 Pre-release reset

E2E shipped in the same unmerged PR, so the migration
(`20260730120000_e2e_multi_device`) simply `DELETE`s existing `e2e_devices`
rows rather than carrying a compatibility path. Clients re-register their
**existing identity keys** under a deviceId, so pinned identities survive; old
`olm1` history keeps decrypting from pickled sessions and the plaintext cache.

## 13. Encrypted attachments (Phase C, shipped)

- Client encrypts file bytes with a random per-file **AES-256-GCM** key inside
  the Rust binding (`encryptAttachment`/`decryptAttachment`, RustCrypto
  `aes-gcm` — the no-crypto-in-JS rule holds) before the presigned S3 upload;
  the server stores an opaque blob. GCM's auth tag makes a swapped or
  corrupted blob fail decryption, so no separate content hash is needed.
- **Structured plaintext**: messages with attachments encrypt
  `"" + JSON {v:1, t:text, a:[metas]}`; text-only messages remain raw
  strings (wire-compatible with Phase B). The control-character prefix cannot
  be typed, so raw text and payloads never collide. Each meta carries the real
  `fileName`/`mimeType`/`fileSize` plus `key`/`iv` — peer-authored metas are
  validated like any untrusted input and invalid ones dropped
  (`parseE2EPlaintext`, shared).
- **What the server sees**: presign requests with `encrypted: true`
  (DM-only) are forced to `application/octet-stream`, the S3 key ends in
  `-encrypted.bin` (never the real name), and `MessageAttachment` rows store
  only the key + ciphertext size — a client-supplied fileName is discarded
  server-side. Outer size cap = largest plaintext cap + 16-byte tag; the
  per-type plaintext caps are client-enforced (the server cannot see the real
  type — documented trade-off).
- Rendering: ciphertext is fetched through the existing authenticated proxy,
  decrypted in the binding, displayed via blob URLs (`E2EAttachmentDisplay`);
  retention/cleanup jobs work unchanged on ciphertext.
- The sender caches the **raw structured plaintext** (spec §7.2), so refetch,
  reply previews, and client-side search all recover text + attachment names
  (search matches file names too).

## 14. Cross-signing (Phase C, shipped)

Verifying a contact used to mean comparing a 60-digit number with **every one
of their devices**, and every device they added raised a warning the user had
to judge. Cross-signing replaces that with one number per account, and turns
"an unknown device appeared" from a UX prompt into a cryptographic fact: a
device either carries a valid signature from the account's master key or it
does not.

### 14.1 Keys

Each account has one Ed25519 **master key**. Its public half is published; the
private half never leaves a device unsealed.

```
master binding:  voxium-e2e-v2|master|<userId>|<masterKeyB64>          signed by MSK
device binding:  voxium-e2e-v2|device-cross|<userId>|<deviceId>|<curve25519>|<ed25519>   signed by MSK
```

The self-signature proves possession of the key being published. The device
binding names the user, the device, **and both of that device's public keys**,
so a signature cannot be replayed onto another device, another account, or the
same device after it re-registers with new keys.

There is deliberately **no separate self-signing key** (Matrix's SSK). That
layer exists so a master key can stay offline; ours lives in the same vault as
everything else, so it would add a level of indirection and no isolation. The
master key signs devices directly.

The existing per-device self-signature (§4.1) is unchanged and still verified —
cross-signing is an additional layer, not a replacement.

### 14.2 Trust ordering (the part that matters)

The server is untrusted storage. Every decision follows one precedence:

> **the secret we hold  >  the key we pinned earlier  >  what the server says**

Concretely, on startup (`bootstrapMasterKey`):

- **We hold the secret** → it *is* the account key. If the server publishes a
  different one we neither adopt it nor delete ours; the conflict is surfaced
  (`hasMasterKeyConflict`). If the server has none, we publish ours.
- **No secret but a pin** → we already know our account key. A different
  published key raises the conflict; we never mint a replacement. This device
  stays unsigned until an existing device approves it.
- **No secret, no pin, key published** → trust on first use, pinned
  **unverified**. Marking it verified here would let a server-supplied key
  bless server-injected devices.
- **Nothing at all** → genuinely the first device: mint, seal, publish,
  self-sign.

Two rules follow from this and are load-bearing:

1. **Never delete local key material on the server's assertion.** A server that
   serves a plausible wrong key would otherwise strip every device of its
   approval capability and break sending outright.
2. **Never mint a replacement for a key we have pinned.** "The account has no
   master key" is the server's word; believing it would wipe every device
   signature and force an identity-change prompt on every peer — a remote,
   repeatable trust reset that also trains users to click through the one
   dialog the whole model depends on.

### 14.3 Peer verification and the auto-trust window

`fetchDeviceList` verifies, in order: the master self-signature; the master key
against the TOFU pin (`master:{userId}` — a change raises
`E2EIdentityChangedError`); then each device's self-signature and its
cross-signature **against the pinned key**, never one supplied in the same
response.

Cross-signed devices are acknowledged automatically — no warning, no prompt.
That is the entire UX payoff, and it is gated: auto-trust applies only under a
master key the user has **acknowledged** (`acknowledgedMasterKey`) or verified
out of band. A key that first appears in the same response as the devices it
signs proves nothing, and *seeing* a key twice is not acknowledgement either.
Without that gate, a server could mint a master key for an account that never
had one, sign its own device with it, and have it silently trusted — strictly
worse than the pre-cross-signing warning it replaced.

Devices without a valid cross-signature warn, are labelled "not signed by
<name>'s account key" in the badge, the safety-number modal and the device
manager, and cannot be cleared by acknowledgement alone.

### 14.4 Device approval

A device holding the master secret can approve another of its own devices:

1. queue the master secret to the target over the existing pairwise Olm channel
2. publish the target's cross-signature

**That order is deliberate.** The reverse leaves a device everyone treats as
fully trusted but which never received the key — and the approve button
disappears with it, because approval is only offered for unsigned devices.

The secret is assembled, encrypted, parsed and checked **inside the engine**
(`EngineSession.encryptMasterSecret` / `decryptMasterSecret`,
`EngineAccount.createInboundSessionForMasterSecret` for the pre-key case). The
private half has no JS-facing accessor at all, so §7's "the pickle key is the
only secret JS handles" still holds. The importer requires the derived public
key to equal the published master key, and the ciphertext to decrypt under the
sending device's pinned Olm identity.

If no approved device is available, the honest outcome is a new account
identity: peers see a changed safety number, which is the correct signal.
Encrypted key backup (Matrix's SSSS) is deliberately out of scope.

### 14.5 At rest

The master secret is stored sealed (`sealSecret`, AES-256-GCM under the vault
pickle key) at `master_secret`. Sealed blobs carry the vault field name as
**AAD**, so two sealed fields cannot be swapped by anyone with IndexedDB write
access. `master:{userId}` holds public material only.

### 14.6 Server surface

`PUT /e2e/master-key` (publish + optionally sign devices), `POST
/e2e/devices/:deviceId/signature`, and a self-only `POST`/`GET
/e2e/master-transfers` mailbox (claim-and-delete, `FOR UPDATE SKIP LOCKED`,
per-device cap, swept with the key-share retention job). The server verifies
every signature it stores and rejects the whole request on any bad one, but it
is never the authority on trust — the client re-verifies everything.

Cross-signing writes use their own rate limiter: sharing the 5/hour device
registration bucket made a normal multi-device setup 429 halfway through an
approval.

### 14.7 Known gaps

- Fanout is unchanged: unsigned devices still receive session keys (warn, don't
  block — §12.5). Blocking would lock a user out of a new device with no way to
  approve it.
- Trust on first use remains for a peer's very first master key, as in any
  system without a prior channel. The safety number is what closes it.
- No encrypted key backup, so an account with no approved device online starts
  a new identity rather than recovering the old one.

