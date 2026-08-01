# Always-on E2E: plan, migration and cutover

**Status:** proposed, not started. Companion to `docs/e2e-dm-spec.md` (the design
of record). This document covers the change from *opt-in per conversation* to
*always on*, the device-linking flow that replaces manual approval as the
primary path, and the production cutover.

## 1. What is actually changing

Encryption stops being a feature a user turns on and becomes how DMs work.

The data model barely moves — identity, devices, cross-signing and key backup are
already account-scoped (§12, §14, §15). What changes is:

| Today | After |
|---|---|
| `Conversation.encryptedAt` is null until someone clicks "Enable encryption" | set at conversation creation; no user-facing toggle exists |
| DMs can carry plaintext | there is no plaintext path for DMs |
| E2E keys are registered on first app load | registered as part of account setup, so a recipient always has keys |
| A second device is approved by finding it in a list inside a DM modal | linked with a code shown on the new device |
| Devices, recovery key and safety numbers live inside a per-conversation modal | Settings → Security, with a per-contact shortcut from the DM badge |
| A new device has no history and an empty search | history follows the account (§4.4) |

**The single most valuable part of this work is subtraction.** Most of the
friction users hit is not cryptography, it is the existence of a choice.

## 2. Decisions already taken

1. **Always on.** No per-conversation toggle, no per-user preference, no
   fallback. A fallback is what quietly recreates today's problem.
2. **Wipe DM message history in production** rather than carry a compatibility
   path. Voxium is pre-scale and the alternative — two classes of conversation
   forever — is the thing being removed.
3. **Device linking is the primary path** for getting a second device working.
   The recovery key becomes the fallback for "I lost everything", not the
   routine flow.

## 3. Decisions still open

- **D1. ~~Scope of the wipe.~~ DECIDED: DM messages only.** Channel history is
  not encrypted and is untouched; conversations and friendships stay, so nobody
  loses their contact list.
- **D2. ~~Minimum client version.~~ DECIDED: not required.** Voxium is
  pre-scale and the failure mode is already humane: `POST /dm/:id/messages`
  has rejected plaintext into an encrypted conversation since Phase B, with
  "This conversation is end-to-end encrypted; update your client to send
  messages". An un-updated client therefore gets a clear instruction rather
  than a silent downgrade or a generic error — and the Tauri updater carries
  it forward on its own. **No version gate is built.** The cost is accepted:
  a user on an old build cannot send DMs until their app updates.
- **D3. ~~Accounts that registered but never opened the app.~~** *Resolved
  during implementation (§4.1): keys cannot be published before email
  verification, so this state is permanent and is now handled as a named
  product state rather than an error.*
- **D4. Report handling.** Every report becomes reporter-attested. This already
  works (`contentSource: "reporter"`, flagged unverifiable), but it becomes the
  only mode and should be an explicit moderation-policy decision, not a
  discovery.

## 4. Design

### 4.1 Keys as early as the auth model allows — and the state that remains

**Correction to the original draft, found during implementation.** "Register
keys at the end of signup" is not possible: `e2eRouter` sits behind
`requireVerifiedEmail`, and signup ends with an *unverified* account. The
earliest an account can publish device keys is its first authenticated session
after email verification — which is what mounting `MainLayout` already does.

Relaxing that gate for device registration was considered and rejected: it would
let an unverified address claim an identity other people then pin.

So the "recipient has no keys" state cannot be designed away from the sender's
side, and under always-on it becomes the **only** reason a DM cannot be sent.
It is therefore a product state, not an error:

- `E2EPeerNotReadyError` carries the peer id, and the send path renders
  "*<name> hasn't set up Voxium on a device yet… they'll be reachable once they
  open the app*" rather than a generic failure.
- It is raised **only** when the directory returned no devices at all. If the
  peer publishes devices and none survive signature verification, that is a
  different and much less reassuring story — it keeps its own error and must
  never be reported as the person simply not being set up.

**Status: implemented.**

### 4.2 Conversations are born encrypted

`Conversation.encryptedAt` becomes non-nullable, defaulted at creation. The
enable route, the store action, the modal and its copy are deleted. The lock
badge stops being a button that means "turn this on" and becomes status only.

**Make the badge quiet.** A green lock on every conversation is noise that
trains people to ignore the badge — the opposite of what it is for. Render
nothing in the healthy case; reserve the badge for the two states that need a
human: this contact's identity changed, or a device is not signed by their
account key.

### 4.3 Device linking

The goal is to replace "find the new device in a list and press Approve" with
"type the code your new device is showing". It is a safer *trigger* for the
approval flow that already exists (§14.4) — not new cryptography.

**Flow**

1. New device `D2` starts and registers as it does today. It is unsigned: peers
   warn about it, and it can decrypt nothing.
2. `D2` displays a **linking code** — a short code for typing, and (once a
   camera-bearing client exists) a QR carrying the same value:

   ```
   fingerprint = base32(SHA-512("voxium-link-v1" || userId || deviceId
                                || curve25519Key || ed25519Key))
   short code  = first 8 characters, grouped 4-4
   ```

3. On an approved device `D1`, the user opens Settings → Security → Link a
   device and enters the code.
4. `D1` fetches `/e2e/devices/me` and recomputes the fingerprint **from the keys
   the server served** for each unsigned device. A match identifies the target.
5. `D1` shows what it is about to approve (short device id, when it registered)
   and asks for confirmation.
6. `D1` runs the existing `approveDevice(deviceId)`: cross-sign, then hand over
   the account key over the pairwise Olm channel.
7. `D2` claims the transfer (already implemented) and becomes fully functional.

**Why this is safe**

- *The code is not a capability.* Knowing it grants nothing: approval still
  requires `D1`'s user to act and `D1` to hold the account key. A leaked or
  screenshotted code cannot approve anything.
- *It binds approval to published keys.* Because `D1` recomputes the
  fingerprint from what the server served, a server that injects a device of its
  own cannot be approved by a user following this flow — the injected device's
  fingerprint will not match the code the user is reading off their new device.
  This is strictly better than today's flow, where the user picks from a list
  and has nothing to compare against.
- *Possession is implicit.* The account key is transferred inside an Olm
  message encrypted to `D2`'s identity key, so only `D2` can read it.

**Residual risk: phishing.** A user can be socially engineered into typing an
attacker's code. Mitigations: `D1` shows what it is approving and requires
confirmation; approvals are visible afterwards on every device (the own-device
warning already exists); rate-limit approvals; refuse to "link" a device that is
already cross-signed.

**Short code entropy.** 8 base32 characters is 40 bits, and an attacker would
need a device whose fingerprint *matches a given code* — a preimage problem, not
a birthday one — while under the 5-device cap and the approval rate limiter.
The QR carries the full fingerprint, so the truncation only applies to the typed
path.

**Status: implemented — spec §17.** The service and its guards are done; the
confirmation step described above is the mitigation for the one residual risk
(phishing) and is not optional.

**Order of work:** the short code first. Voxium is desktop-first and neither end
has a camera today; QR becomes useful when a mobile client exists, and it is the
same value in a different wrapper.

### 4.4 History follows the account

**Status: implemented — spec §16.** Built without the second secret this section
proposed: the backup subkey is derived from the master key, so there is nothing
extra to distribute and no second string for the user to keep. Three bugs found
on the way are recorded there: a last-writer-wins upsert that could destroy the
messages between two ratchet indexes, restored sessions attributed to the wrong
sender, and an unbounded table that no sweep could ever reclaim.

This is the blocker for cutover, not a follow-up. Under always-on there is no
plaintext history to fall back on, so a newly linked device that cannot read
anything is a much sharper edge than it is today.

Design, staying inside primitives the engine already has:

- The account mints a 32-byte **message backup key** alongside its master key.
- It travels with the master key in the approval payload (`voxium-master-v2`),
  so every linked device can *write* backups.
- It is sealed into the §15 backup blob under the same recovery key (payload
  `voxium-backup-v2`), so recovery yields both. **No second secret for the user
  to keep** — this is why §15's payload was versioned.
- Each device uploads inbound Megolm session keys, AES-256-GCM under the backup
  key, AAD binding `conversationId || sessionId`, to a new `E2EMessageKeyBackup`
  table (one row per session, opaque to the server).
- A freshly linked device downloads and decrypts them, and history plus
  client-side search work immediately.

Trade-off worth stating: any approved device can read all backed-up history.
That is not a downgrade — an approved device already holds the account key and
can approve further devices.

### 4.5 Move the UI to where accounts live

Device list, approve/revoke, linking, recovery key and identity reset move to
**Settings → Security** (the tab already exists). Safety numbers stay reachable
from the DM badge, because verifying a contact genuinely is per contact.

Administering account-level state from a per-conversation modal is a large part
of why the current design *reads* as per-conversation even though the data model
is not.

## 5. What gets deleted

Code and concepts to remove, not deprecate:

- `POST /dm/:conversationId/encryption`, `dmStore.enableEncryption`, and
  `EnableEncryptionModal` with its copy (`enableExplainer`,
  `enablePointIrreversible`, `enablePointServer`, `enableConfirm`, …).
- The plaintext-vs-encrypted branching in the DM list, reply previews and
  notifications that exists only because a conversation could be either.
- The `encrypted: false` send path for DMs, server-side.
- Whatever i18n keys the above orphan, across all 11 locales.

## 6. Migration

### 6.1 Server

One migration, additive except for the wipe:

```sql
-- 1. DM history goes (D1: DM messages only; channel history is untouched).
--    Reactions cascade from messages (MessageReaction.message onDelete:
--    Cascade) and replyToId is SetNull, so this one statement is enough.
DELETE FROM messages WHERE conversation_id IS NOT NULL;

-- 1b. read markers point at messages that no longer exist; without this every
--     DM shows a stale unread state on first load after cutover
DELETE FROM conversation_reads;

-- 2. every conversation is encrypted from now on
UPDATE conversations SET encrypted_at = NOW() WHERE encrypted_at IS NULL;
ALTER TABLE conversations ALTER COLUMN encrypted_at SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN encrypted_at SET DEFAULT NOW();

-- 3. every account re-registers cleanly (the §12.7 pattern).
--    NOTE: the table is e2e_device_registry (singular), and e2e_one_time_keys
--    must be listed explicitly — it holds the only FK into e2e_devices, and
--    postgres refuses to truncate a referenced table otherwise. Listed rather
--    than CASCADE so the set is auditable.
TRUNCATE e2e_key_shares, e2e_master_transfers, e2e_key_backups,
         e2e_message_key_backups, e2e_master_keys, e2e_device_registry,
         e2e_one_time_keys, e2e_devices;
```

`ALTER COLUMN … SET NOT NULL` takes ACCESS EXCLUSIVE and scans the table. At
today's row count that is instant; if `conversations` ever grows large, add
`CHECK (encrypted_at IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` (weaker
lock), then `SET NOT NULL`, which can then skip the scan.

**The S3 claim in the first draft of this plan was wrong.** `attachmentCleanup`
selects from `message_attachments` *rows*, and the cascade above deletes exactly
those rows — so the job can never see the objects it was supposed to reclaim.
DM attachment blobs leak **permanently** unless their keys are captured BEFORE
the delete:

```sql
-- run first, keep the output; these are the objects to sweep from S3 afterwards
SELECT a.s3_key FROM message_attachments a
  JOIN messages m ON m.id = a.message_id
 WHERE m.conversation_id IS NOT NULL;
```

Sweeping the `attachments/dm-*` prefix by hand is the alternative.

`TRUNCATE e2e_key_backups` deserves a moment: it destroys recovery keys people
may have written down. That is correct here — those blobs seal master keys that
no longer exist after the truncate — but it must be in the user-facing notice.

### 6.2 Client vaults

Every installed client holds pickled sessions, pinned identities and a plaintext
cache for keys that will not exist after the wipe. Stale state must not survive.

The vault database is named `voxium-e2e-{userId}[-{namespace}]`. Bump it to
`voxium-e2e-v2-{userId}`: old databases become unreachable, and the client
bootstraps clean. Add a one-time sweep that deletes the `voxium-e2e-*` databases
that do not match the current version, so the data is gone rather than merely
orphaned.

### 6.3 Clients in the wild

Gate the API on a minimum client version (D2) before the wipe, so nobody is left
on a build that cannot send. The Tauri updater should carry everyone forward in
the days before cutover.

## 7. Cutover runbook

Ordered so that nobody is stranded mid-flight. Steps 1–5 ship normally and are
individually revertible; step 7 is the point of no return.

1. **Keys at signup** (§4.1). Ships alone, changes nothing user-visible.
2. **Message-key backup** (§4.4). Ships behind the existing backup feature;
   devices start populating it immediately, which is what makes step 7 survivable.
3. **Device linking** (§4.3). Ships alongside the existing approve-from-list
   flow, which stays until linking has been exercised in production.
4. **Move the UI to Settings** (§4.5), leaving the DM badge shortcut.
5. ~~Minimum client version enforced~~ — dropped (D2). The existing plaintext
   rejection is the whole mitigation.
6. **Announce.** Users need to know: DM history will be deleted on a date, and
   existing recovery keys stop working. This is a product communication, not a
   changelog line.
7. **Maintenance window:**
   1. put the API in maintenance mode
   2. take a database snapshot (this is the only rollback for steps 7.3–7.4)
   3. capture the DM attachment keys (§6.1) — after the delete they are
      unreachable
   4. run the migration in §6.1 **through `prisma migrate deploy`, or through
      `psql` inside an explicit `BEGIN`/`COMMIT`**. Do NOT use
      `prisma db execute`: it does not wrap the file in a transaction, so a
      statement killed part-way leaves history deleted with `encrypted_at`
      still nullable and the key tables intact — a half-cutover with no clean
      state to resume from
   5. deploy the server build with the toggle removed and DM plaintext rejected
   6. deploy the client build with the bumped vault version
   7. verify (below), then lift maintenance
   8. AFTER lifting: `VACUUM (ANALYZE) messages`, and consider reindexing its
      trigram GIN index on `content`. A bulk delete of that size leaves both
      bloated, and neither can run inside the migration transaction
8. **Remove the dead code** (§5) in the release after cutover.

   This ordering is not tidiness, it is a hard constraint. Until the migration
   has run in production, `encrypted_at` is still nullable there and real
   conversations are still plaintext — a server build with the plaintext path
   removed would reject every one of them. **The build that deletes it must go
   out after the migration, never with it.**

   Already done, because it carries no such hazard: the `dm:encryption_enabled`
   event, its listener and its store handler. The server stopped emitting it in
   the cutover build, so removing the other end is pure dead code.

   Still to remove, once production has cut over: the plaintext branches of the
   DM send and edit routes (keeping the rejection that tells an old client what
   to do), and `Conversation.encryptedAt` can stop being nullable in the shared
   client type.

**Verification before lifting maintenance**

- two fresh accounts can DM each other with no setup step and no toggle
- the server stores only ciphertext for those messages (the existing live
  Playwright spec asserts exactly this)
- a second device links by code, receives the account key, and reads history
- restoring from a *new* recovery key on a third install yields the same
  account identity and the same history
- `GET /e2e/devices/me` still advertises `crossSigning: true` from every node

**Rollback.** Up to 7.3 the snapshot restores everything. After 7.3 the message
data is gone by design — rollback means reverting the code, not the data. Say
this out loud before starting.

## 8. Consequences to accept deliberately

- **Server-side DM search is gone permanently.** Client-side search covers what
  the device has decrypted, which §4.4 makes equal to "everything" for a linked
  device.
- **Reports are reporter-attested** (D4).
- **A user who loses every device and the recovery key starts a new account
  identity** (§14.4). Linking makes this rarer; it cannot make it impossible,
  and any mechanism that could rescue that user could also rescue an attacker.

## 9. Sequencing summary

| Phase | Work | Done when |
|---|---|---|
| 1 | ~~Keys at signup~~ → name the not-ready state | sending to an account with no devices explains itself (**done**) |
| 2 | ~~Message-key backup~~ | a linked device reads history it was never sent (**done**, spec §16) |
| 3 | ~~Device linking by code~~ | a second device works without touching a device list (**done**, spec §17) |
| 4 | ~~UI to Settings → Security~~ | nothing account-level is administered from a DM (**done**, spec §18) |
| 5 | ~~Min client version~~ | **dropped** — the plaintext rejection already tells an old client what to do (D2) |
| 6 | Cutover | §7 verification passes |
| 7 | Delete the opt-in code | no reference to `encryptedAt` as a choice remains |
