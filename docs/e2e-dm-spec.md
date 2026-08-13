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

## 5. Conversations are born encrypted

**There is no enable step.** `Conversation.encryptedAt` is `NOT NULL DEFAULT
now()`, set by the database when the row is created, so a conversation is
encrypted from its first millisecond and every DM ever sent in it is
ciphertext.

`POST /api/v1/dm/:conversationId/encryption` — the old opt-in route — was
removed in the always-on cutover (migration `20260801140000_e2e_always_on`,
`docs/e2e-always-on-plan.md` §4.2, §6.1), together with the
`dm:encryption_enabled` event and the `type: system` notice it emitted. The
same migration deleted all pre-cutover DM history, so there is no plaintext
history left to reason about either.

What survives from the old behaviour is the part that mattered: the server
rejects plaintext user messages in a conversation — an outdated client gets a
hard 400 ("This conversation is end-to-end encrypted; update your client to
send messages"), never a silent downgrade. It is now the only path.

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

Two consequences of that ordering are easy to get wrong, and both were:

- **Our own device's keys come from the account, not the response.** We hold
  this device's private halves, so cross-signing what the *server* says its
  public halves are is pure downside: the server would collect a valid account
  signature over an Olm identity it generated, and every peer who compared the
  account safety number would trust it silently.
- **A conflict on our OWN account is a warning, not an exception.** The send
  path re-reads our own device list on every message, so raising the
  peer-facing `E2EIdentityChangedError` there would not inform anyone — it
  would make encrypted DMs permanently unsendable. The pinned key is kept, the
  conflict is surfaced (`hasMasterKeyConflict`), and §14.4's reset is the exit.

**Rollout.** Cross-signing fields are absent from a node that predates them,
which reads exactly like "this account has no master key" — and acting on that
mints a replacement, wiping every signature and prompting every peer. So every
device-list response from a capable node carries `crossSigning: true`, and the
client bootstraps only when it sees that flag. Without it, it defers: no mint,
no pin, no conflict, and previously known cross-signatures are carried forward
rather than being read as "every device just lost its signature".

That grace **expires the moment a capable node answers**. The flag is
server-controlled and unsigned, so an unbounded grace would be a mute button:
withhold one boolean and "these devices are not signed by the account key"
becomes silence. Once this client has seen cross-signing work, a later omission
is read literally and the user is warned. Losing a cross-signature also counts
as a device-list change in its own right — otherwise a withdrawn signature
would leave the stored state calling the device signed forever. Revoking a
device drops it from the cross-signed set as well as the device set: under the
grace that set stands in for checking a signature, so a stale entry would let a
device re-registering under the same id be trusted without one.

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

`acknowledgedMasterKey` advances **only** in `acknowledgeDeviceList`, i.e. from
an explicit user action. Advancing it anywhere else — including on a response
where nothing looks outstanding — restores the same attack in two steps:
publish the forged key alone, then add a device signed by it.

Comparing the account number also does not stamp "verified" on devices the
account key refuses to sign. Cross-signed devices inherit the comparison at
read time; unsigned ones stay unsigned, which is the whole point. (Accounts
with no master key at all keep the per-device behaviour of §12.)

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
`EngineAccount.createInboundSessionForMasterSecret` for the pre-key case), so
§7's "the pickle key is the only secret JS handles" holds. Keeping it true takes
three guards, not just the absence of a getter:

- the generic `openSecret`/`sealSecret` refuse the `master_secret` context, or
  one call with the (constant, published) context would return the raw key —
  the sealed blob and the pickle key are both reachable from JS;
- the generic `EngineSession.decrypt` refuses any plaintext carrying the
  approval prefix, because Olm has no domain separation of its own and a server
  could otherwise re-file an approval envelope into the key-share mailbox;
- the base64 secret is zeroized after use — WASM linear memory is never
  returned to the OS and is readable from JS.

The importer requires the derived public key to equal the published master key,
and the ciphertext to decrypt under the sending device's pinned Olm identity.

**Claiming is retryable.** The mailbox read does not delete; the claimant acks
the rows it actually used or rejected. A read that consumed them would make
every transient failure permanent — the target is already cross-signed by then,
so it looks fully trusted to every peer, holds no key, and is no longer offered
for approval.

The expected key is what the account **publishes**, not what this device
pinned. The two differ exactly when a sibling has just run the reset above —
the sanctioned recovery — and checking against the stale pin would reject the
approval meant to rescue this device and then discard it. Adopting the secret
re-pins the account key, because holding it is the strongest proof there is.

"Rejected" means *provably* unusable: malformed, or already spent on a ratchet
that has moved past it. A row is never dropped for a failure that says nothing
about the payload — a sender we cannot look up yet, a request that did not
land. Acking on any error at all would rebuild the same dead end with the
client holding the delete button. Unacked rows are bounded by the per-device
cap and the retention sweep, so keeping them is the cheap side of the trade.

**Recovery.** If no approved device is available — a reinstall that lost the
vault, a lost keychain, an account key this device cannot prove — the honest
outcome is a new account identity: `resetAccountIdentity` mints and publishes a
fresh master key, and peers see the safety number change.

**Holding the key changes the remedy.** If this device still holds the account
key and the server has published something else, the fix is to publish ours
again — same key, same safety number, nobody re-verifies. Minting there would
throw away a working identity to undo a server-side edit.

It is offered **only** when nothing else can help: not while another device of
the account is still cross-signed, since that device may hold the key and
"approve this one from that one" is the answer; and never off a response that
did not advertise cross-signing, because such a node cannot report signatures
at all, so "every device looks unsigned" is absence of evidence rather than
evidence of absence. Otherwise the single
destructive action in the whole feature would appear during ordinary
second-device setup, and taking it would strip the approval from the device
that was about to help. Unlike the mint path it publishes BEFORE sealing: a
reset can be replacing a working key, so a failed publish has to leave the
device exactly as it was. Minting is safe there
precisely because the *user* asked; the danger §14.2 guards against is a
*server* provoking it. Encrypted key backup (Matrix's SSSS) is deliberately out
of scope.

### 14.5 At rest

The master secret is stored sealed (`sealSecret`, AES-256-GCM under the vault
pickle key) at `master_secret`. Sealed blobs carry the vault field name as
**AAD**, so two sealed fields cannot be swapped by anyone with IndexedDB write
access. `master:{userId}` holds public material only.

### 14.6 Server surface

`PUT /e2e/master-key` (publish + optionally sign devices), `POST
/e2e/devices/:deviceId/signature`, and a self-only master-transfer mailbox:
`POST /e2e/master-transfers` to queue, `GET` to read (non-destructive),
`POST /e2e/master-transfers/ack` to drop rows once used or rejected — all
scoped to the caller's own account and own device, per-device capped, and swept
with the key-share retention job. Every device-list response also carries
`crossSigning: true` (§14.2). The server verifies every signature it stores and
rejects the whole request on any bad one, but it is never the authority on
trust — the client re-verifies everything.

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
  a new identity rather than recovering the old one (§14.4 makes that an
  explicit action instead of a dead end).
- The engine ships as a committed WASM binary, so CI enforces that
  `pkg/.source-hash` matches the Rust source
  (`pnpm --filter @voxium/crypto-engine check:wasm-fresh`). Without it, a fix
  could live in the repository and in no user's hands: every other check reads
  `pkg/`, not `src/`.


## 15. Encrypted key backup (Phase C, shipped)

Until now, losing every device meant losing the account identity: §14.4's reset
was the only way back, and it cost every contact a re-verification. Backup makes
that recoverable — for the user, and only the user.

### 15.1 What is backed up, and what is not

The **account master secret** (§14.1). That is what a reset destroys and what
peers pin, so restoring it means the safety number never changes and nobody is
prompted.

Message history is **not** backed up. That is a separate mechanism (Megolm
session keys, one per conversation per rotation) with a different retention
question, and conflating the two would put megabytes of key material behind the
same single recovery key. History still does not follow a new device (§11).

### 15.2 The recovery key

32 random bytes from the engine's CSPRNG, plus one checksum byte, base32
(RFC 4648 — no case distinction, and none of `0/1/8` to confuse with `O/I/B`),
grouped in fours. Shown once. Never stored, never transmitted, not derivable
from anything.

The checksum byte is `SHA-512("voxium-recovery-key-v1" || secret)[0]`, and the
canonical spelling is exactly 53 base32 characters. Both are part of the format,
not implementation detail: a key minted here has to validate in any other
implementation of it, and accepting a non-canonical length would let several
different strings stand for the same key — so a key with a character appended
would still verify, which is the typo the checksum exists to catch.

**Deliberately not a passphrase.** A passphrase needs a slow KDF, which is key
derivation this crate is not allowed to implement (§1) — and worse, it would
make a server-held blob guessable offline at whatever entropy the user chose.
A 256-bit random key has no such attack. The cost is that the user must keep it;
that is the honest trade, and it is the same one Matrix's "security key" makes.

The checksum buys nothing cryptographically — GCM already fails closed. It
exists so a typo is reported as "that is not your recovery key" before any
request, instead of "decryption failed" after one, which reads like data loss.

### 15.3 The blob

`voxium-backup-v1|<secret_b64>|<public_b64>`, sealed with AES-256-GCM under the
recovery key, AAD `voxium-backup/master_secret`. Assembled, sealed, opened and
parsed **inside the engine**: the private half never becomes a JS string, and
the context is reserved from the generic `sealSecret`/`openSecret` for the same
reason as the vault's (§14.4) — the blob and the typed recovery key both pass
through JS, so a generic opener would be a complete bypass.

The payload carries the public half so a restore can prove what it recovered.
Versioned so message keys could be added later under the same recovery key
rather than a second one.

### 15.4 Restoring

The recovered secret must derive to the key the account **publishes**, verified
self-signature and all — not to whatever the blob happens to contain. The server
hands back the blob, so without that check it could substitute one of its own
making and the "recovery" would install a key it holds. Failing closed here
costs a user nothing: the honest answer is that this backup is for a different
account identity.

On success the device seals the secret, pins the account key **verified**
(holding it is the proof), clears any conflict, and cross-signs itself — a
recovering device is unsigned by definition, and leaving it that way would have
every peer warning about the device that just recovered.

### 15.5 Server surface

`PUT /e2e/backup` (store or replace), `GET /e2e/backup`, `DELETE /e2e/backup` —
own-account only, one row per account, size-capped (`KEY_BACKUP_MAX`), rate
limited with the approve limiter. The server stores ciphertext and a timestamp.
There is no server-side recovery, no passphrase hint, and no escrow: an operator
with the whole database learns only that a backup exists.

A reset that mints a NEW identity deletes the blob, because it could then only
ever fail to open. A reset that merely re-publishes a key this device already
holds (§14.4) leaves it alone.

That second rule is deliberately conservative rather than exact. Re-publishing
changes what the account publishes if the server had published something else,
so the stored blob MAY be orphaned — but it may equally be the backup of the
very key being re-published, and the client cannot tell which without the
recovery key. Deleting would destroy a working recovery to tidy up a possibly
dead one, so the blob stays and a restore that cannot open it says so plainly
("that key may belong to a previous account identity") instead of blaming a
typo. Creating a backup carries the mirror of the restore rule: a key this
device holds is only backed up if the account actually publishes it.

### 15.6 Retention

A backup is the one piece of E2E material designed to outlive every device, so
no age sweep can ever reclaim it — which makes it the worst row to leave behind.
It is therefore the only E2E table with a real foreign key to `User`, cascading
on delete.

The others (devices, registry, master key, key shares, transfers) have no FK,
which predates this and meant a deleted account kept publishing its device
identities forever. Account deletion now calls `purgeE2EMaterial()` before
removing the user, covering all of them; adding FKs retroactively needs an
orphan-cleanup migration on a live database and is left as a follow-up.

### 15.7 Known gaps

- No history backup, as above.
- A user who loses the recovery key AND every device is back to §14.4's reset.
  This is a deliberate floor: any mechanism that could rescue them could also
  rescue an attacker who compromises the account.
- The blob is one row per account; there is no versioning or rollback, so a
  replaced backup invalidates the previous recovery key immediately. If the
  replacing request commits but its response is lost, the new recovery key is
  gone with the failed call while the old one no longer opens what is stored —
  the user has to create another backup. Fixing that properly needs either a
  two-phase write or showing the key before the write is confirmed, and both
  trade a worse failure for this one.

## 16. Message-key backup (Phase 2 of the always-on plan)

§15 backs up the account *identity*. This backs up the ability to *read history*
— the thing that decides whether a newly linked device is useful or a blank
window. It matters more under always-on, because once every DM is encrypted
there is no plaintext history left to fall back on.

### 16.1 The subkey

Session keys are sealed under `SHA-512("voxium-msgbackup-v1" || master_seed)[..32]`,
a domain-separated subkey of the account master key.

**No second secret.** Every approved device already holds the master secret and
recovery already restores it, so deriving from it means: nothing extra to
distribute, no approval-payload version to bump, no envelope handed between
devices, and no second string for the user to keep. Exactly the devices that can
read new messages can read old ones.

This is the third place the engine computes rather than marshals (with the
safety-number digest and the recovery checksum), and the crate header says so.
A single domain-separated hash over an already-uniform 32-byte seed is the
smallest construction that does the job; anything more belongs in vodozemac or
a vetted crate.

**The consequence, documented rather than mitigated:** replacing the master key
(a §14.4 identity reset) makes existing backups unreadable, so the reset drops
them server-side. That is not a loss in practice — a reset already means every
device was lost, so there was no local history either, and the recovery-key path
preserves both.

### 16.2 What is stored

One row per Megolm session: `{ conversationId, sessionId, firstKnownIndex, blob }`.
The blob is AES-256-GCM with the AAD bound to
`voxium-msgbackup/session_key|<conversationId>|<sessionId>`, and it seals the
session key **together with who sent it** — a session restored as our own cannot
decrypt a peer's messages, and the server has no business learning the sender.

`firstKnownIndex` is the one field deliberately left in the clear, because the
SERVER is what has to compare it: a device that joined a session late exports
from a later index and holds strictly less of it, so a last-writer-wins upsert
would let it overwrite a key covering the whole session and destroy the messages
in between. Writes therefore only ever move a session EARLIER in the ratchet;
an equal or later index is a no-op. It reveals only how far into a session a key
begins.

The table is capped per account (`MESSAGE_KEY_STORE_CAP`) and reaching it
**refuses new uploads rather than evicting old ones**. Every other capped table
here can be refilled — a key share can be re-sent — but nothing can regenerate a
Megolm key nobody holds, so eviction destroys history irrecoverably while
refusing costs only keys the client still has locally.

That binding is load-bearing. Without it a server could move rows between
conversations, and a restoring client would decrypt one conversation's history
believing it belonged to another.

Keys are exported at their **first known index**, so a restoring device reads the
whole session rather than only the part the uploading device happened to see.

### 16.3 Client behaviour

- `backupMessageKeys()` uploads sessions the account has not stored yet, in
  batches. Already-uploaded ids are remembered locally — losing that record
  re-uploads, and the server upserts, so it is an optimisation and not state
  anything depends on.
- `restoreMessageKeys()` pages through every stored key and imports what is
  missing, through the same path a key share takes — so the session-id check
  that rejects a mislabelled key applies here too. One unreadable row is skipped
  rather than abandoning the rest of someone's history.
- Only a device holding the master secret can seal or open, which is the same
  condition as being able to approve devices.

### 16.4 Known gaps

- A device backs up what it holds. A session nobody backed up before every
  device was lost is unrecoverable — the backup is a copy of what existed, not
  an escrow.
- Sessions are stored per account, so the server learns how many sessions an
  account has and which conversation each belongs to. That is metadata it
  already has from message routing (§11.8).

## 17. Device linking (Phase 3 of the always-on plan)

Approving a second device used to mean finding it in a list and pressing a
button, with nothing to check it against. Linking replaces that with "type the
code your new device is showing" — which is easier *and* strictly safer.

It is not new cryptography. It is a safer trigger for the approval flow of
§14.4.

### 17.1 The code

`base32(SHA-512("voxium-link-v1" || userId ⁠|| deviceId || curve25519 || ed25519))`,
first 16 characters, grouped `XXXX-XXXX-XXXX-XXXX`. Public material only, like
a safety number. Fields are separated by a NUL byte so no two different tuples
can concatenate to the same input.

### 17.2 Why it is safe

- **It is not a capability.** Knowing the code grants nothing: approval still
  requires the other device to hold the account key and its user to confirm. A
  code read over a shoulder, screenshotted, or shouted across a room is worth
  nothing on its own.
- **It binds approval to published keys.** The approving device recomputes the
  code from the keys the SERVER served for each unsigned device. A device the
  server injected has keys of its own making, so it produces a different code —
  a user typing what their real new device displays can never land on it. That
  is the property the old list-and-press flow could not offer at all.
- **Already-trusted devices are not linkable**, so a second approval of a device
  that is already cross-signed cannot be provoked.

### 17.3 Residual risk

**Phishing.** Someone can be talked into typing an attacker's code. Nothing in
the construction prevents that, so the mitigation is procedural and must not be
skipped: the approving device shows *what it is about to approve* — the device
id and when it registered — and requires a confirmation, and every device of the
account sees the new device afterwards through the existing own-device warning
(§12.5).

**Entropy.** 16 base32 characters is 80 bits. An earlier draft used 8 (40 bits)
on the reasoning that a preimage needs a registered device, so the 5-device cap
and the approval rate limiter bound the attempts. That reasoning was wrong: the
attacker picks `deviceId` and both keys, so they grind the digest *offline* and
register only the one device that already matches. Neither the cap nor the
limiter is reachable from an offline search, and 40 bits falls in minutes on a
GPU. 80 bits puts it out of reach while keeping the code typeable.

Two devices matching one code therefore cannot happen by chance, so the
approving client refuses the lookup outright rather than picking one — the
server chooses the order of that list, and "first match" would let it seat a
decoy ahead of the real device.

### 17.4 Not yet built

QR is the same value in a different wrapper and waits for a client with a
camera; Voxium is desktop-first and neither end has one today. The typed code is
the primary path and is complete on its own.

## 18. Where the controls live

An early version of this feature put everything behind the lock badge of a
single DM: the device list, approvals, the recovery key, the identity reset.
The data model was always account-scoped, but the *surface* was not, and users
read the surface. That is what made a per-account feature look per-conversation.

The split is now by what the control actually governs:

| Control | Where | Because |
|---|---|---|
| Safety number, "mark verified", per-device detail | DM lock badge | it is a statement about **that contact** |
| Device list, approve / revoke, linking | Settings → Security | it is **your account**, identical in every conversation |
| Recovery key, backup, restore, identity reset | Settings → Security | same |

The DM badge keeps a shortcut into Settings → Security, so the path from
"something looks wrong here" to "manage my devices" stays one click — but the
thing being managed is presented as what it is.

The badge itself stays quiet: it renders nothing in the healthy case and names
the most actionable problem when there is one (§14, `badgeState`). A lock shown
on every conversation is noise that teaches people to ignore the one time it
matters.

## 19. Secure channels (group E2E)

Invite-only, end-to-end encrypted text channels inside a server. This is the
"many-member E2E" that §1 and §11.7 deferred — built as a generalization of the
machinery above, not a second protocol. The crypto engine is unchanged.

### 19.1 Model

- `Channel.secure` marks the channel; `Channel.createdById` names its sole
  manager. `ChannelMember` rows (composite PK `[channelId, userId]`,
  `isCreator`) are the ONLY source of access: visibility and permissions are
  membership-derived, and the owner/ADMINISTRATOR fast paths in the permission
  calculator are pierced — a non-member owner computes to `0n` like anyone
  else. Role overrides do not apply and cannot be created.
- Creation is gated by a new permission bit, `CREATE_SECURE_CHANNELS` (bit 20,
  server-level only — stripped from channel overrides like ADMINISTRATOR).
- **Opacity rule**: every surface a non-member could probe (member list,
  rename, role overrides, reorder, mark-read, search, key-share posting, the
  batch device endpoint) answers exactly as it would for a channel that does
  not exist. The single non-member surface is moderation: a COUNT in server
  settings (MANAGE_SERVER), and delete-by-id (owner/ADMINISTRATOR, the id
  learned from an abuse report). Content is never readable; deletion is the
  only lever.
- Members can leave; only the creator invites/removes/renames/deletes. A
  creator leaving the server (kick, leave, account deletion) deletes their
  channels, with member-scoped events and S3 blob cleanup.

### 19.2 Scopes

Group-session state is keyed by a SCOPE string wherever a `conversationId`
used to flow: a bare cuid is a DM, `ch:{channelId}` is a secure channel
(`e2eChannelScope` / `parseE2EScope`, shared). Cuids never contain `:`, so the
namespaces cannot collide — and the message-key-backup AAD embeds the scope,
making the separation cryptographic where it is at rest. `E2EKeySharePayload`
stays `v: 2`; the field name is kept for wire compatibility.

### 19.3 Key distribution

One outbound Megolm session per channel per sender, fanned out pairwise over
Olm to every member device (`E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP` = 25
members × `MAX_DEVICES` = 125 shares worst case — inside the key-share caps).

- `GET /e2e/channels/:channelId/devices` returns every member's device list in
  one response (member-only, opacity rule). Each per-user payload feeds the
  SAME verification path as the per-user GET (`processDeviceListPayload`):
  signature checks, TOFU pinning, cross-signing, warnings.
- That response is the AUTHORITATIVE member list. Rotation decisions never
  depend on socket events — a missed event fails closed at the next send.
- The key-share write gate is scope-aware: DM scopes keep the pre-transaction
  participant check; channel scopes are verified INSIDE the write transaction
  (sender ∈ members; recipient ∈ members or the sender's own device), so a
  concurrently removed member cannot receive a share that commits after their
  membership row is gone.
- `assertSharesE2EContext` extends the bundle-claim/device-list guard: sharing
  a secure channel is an E2E context, so co-members can build Olm sessions
  without ever opening a DM.

### 19.4 Rotation and the product guarantees

`needsChannelRotation` adds ONE trigger to the DM set (device-set fingerprints,
100 messages, 7 days): the member set itself, read from the fingerprint map's
keys. That makes both product guarantees structural rather than policed:

- **Removal**: the next send creates a session the removed member never
  receives. They keep at most the old session — messages they were already
  entitled to read.
- **No history for invitees**: joining changes the member set, so the next
  send rotates; the invitee never receives any earlier session key, and no
  code path re-shares an old session to a new member.

A member with NO published device does not block the room (any invitee could
otherwise freeze a channel by never onboarding); sends report
`notReadyUserIds` and the UI names who cannot read yet. A member whose
published devices all fail verification DOES block the send — that is a
directory problem, not an onboarding state.

### 19.5 Message + attachment enforcement

Secure channels are born encrypted, mirroring §5/§6 exactly: `encrypted: true`
required (400 otherwise, no downgrade), envelope validated, content stored
verbatim (never sanitized), mentions never resolved, excluded from server
search (`encrypted: false` filter + secure channels dropped from the channel
enumeration), edits are fresh ciphertexts under the same id, attachments
presign only as opaque `application/octet-stream` blobs with server-forced
names. The client refuses `encrypted: false` user rows in a secure channel —
the same forgery rule as §9's DM table.

Client search over a secure channel runs on this device's plaintext cache,
like encrypted DMs. Reports from channel members carry reporter-decrypted
plaintext (`contentSource: 'reporter'`), gated on channel membership.

### 19.6 Known gaps

- Metadata: the server sees membership, message timing/sizes and the channel
  NAME (needed for the members' own UI) — same class of leak as §11.8.
- Secure channels count against the server-wide channel cap (they consume real
  resources, so exempting them would let the cap be bypassed invisibly). A
  MANAGE_CHANNELS holder who hits the cap can therefore infer how MANY secure
  channels exist — the same number MANAGE_SERVER already reads from the count
  endpoint, never which or whose.
- The client's `message:new`/`message:update` handlers decrypt asynchronously
  before touching the store — the same shape the DM handlers have always had.
  The known consequences are inherited unchanged: two near-simultaneous
  messages can momentarily render out of order when one resolves from the
  plaintext cache and the other decrypts, and a delete racing a still-
  decrypting insert can leave the row until the next fetch. Serializing per
  channel would add a queue for a cosmetic, refetch-corrected artifact.
- Message-key backup accepts channel scopes transparently, so a device that
  backed up can restore its own history; there is no cross-member history
  transfer (consistent with no-history-on-join).
- Voice is out of scope: secure channels are text-only by construction
  (`type: 'text'` enforced at creation; no voice path accepts them).
