/* tslint:disable */
/* eslint-disable */

/**
 * Result of encrypting attachment bytes: random key + nonce (base64) and the
 * ciphertext (plaintext + 16-byte tag).
 */
export class EncryptedAttachment {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Transfers the ciphertext to the caller without copying megabytes twice.
     * Callable once.
     */
    takeCiphertext(): Uint8Array;
    readonly iv: string;
    readonly key: string;
}

export class EngineAccount {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Establish an inbound session from a pre-key message. The expected
     * identity key MUST be the peer's pinned/server-published key — vodozemac
     * rejects the message if it was not created by that identity.
     */
    createInboundSession(their_identity_key_b64: string, prekey_body_b64: string): InboundResult;
    /**
     * Device approval arriving as a PRE-KEY message (the usual case for a
     * device that has never talked to its sibling): establishes the session and
     * returns the master key without the secret ever reaching JS.
     */
    createInboundSessionForMasterSecret(their_identity_key_b64: string, prekey_body_b64: string, expected_master_key: string): MasterInboundResult;
    /**
     * Establish an outbound session to a peer from their (already
     * signature-verified) identity key and one-time/fallback key.
     */
    createOutboundSession(their_identity_key_b64: string, their_one_time_key_b64: string): EngineSession;
    curve25519Key(): string;
    ed25519Key(): string;
    /**
     * Unpublished fallback key as { keyId, key } or null.
     */
    fallbackKey(): any;
    /**
     * Restore an account from an encrypted pickle (decryption happens inside
     * vodozemac; the pickle key is wiped from this crate's memory after use).
     */
    static fromPickle(encrypted_pickle: string, pickle_key: Uint8Array): EngineAccount;
    generateFallbackKey(): void;
    generateOneTimeKeys(count: number): any;
    markKeysAsPublished(): void;
    maxOneTimeKeys(): number;
    constructor();
    /**
     * Unpublished one-time keys as [{ keyId, key }].
     */
    oneTimeKeys(): any;
    pickle(pickle_key: Uint8Array): string;
    /**
     * Sign a UTF-8 message with the account's Ed25519 key.
     */
    sign(message: string): string;
}

/**
 * Outbound Megolm group session — the sending half. Owns the signing key, so
 * its pickle is secret material and never leaves the vault.
 */
export class EngineGroupSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Encrypt UTF-8 plaintext. Returns the unpadded-base64 MegolmMessage.
     */
    encrypt(plaintext: string): string;
    static fromPickle(encrypted_pickle: string, pickle_key: Uint8Array): EngineGroupSession;
    /**
     * Number of messages already encrypted (== the index the next message
     * will use).
     */
    messageIndex(): number;
    /**
     * Create a fresh outbound group session. Megolm session config is pinned
     * to version 1 (the interoperable, non-experimental variant).
     */
    constructor();
    pickle(pickle_key: Uint8Array): string;
    /**
     * Globally unique session id (base64 of the session's Ed25519 public key).
     */
    sessionId(): string;
    /**
     * Export the session key at the CURRENT ratchet index, base64-encoded.
     * This is the secret shared with recipient devices (and with our own
     * device, so the sender can decrypt its own history). Recipients can only
     * decrypt messages from this index onwards.
     */
    sessionKey(): string;
}

/**
 * Inbound Megolm group session — the receiving half, rebuilt from a session
 * key that arrived over the authenticated pairwise Olm channel.
 */
export class EngineInboundGroupSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypt an unpadded-base64 MegolmMessage.
     */
    decrypt(ciphertext_b64: string): GroupDecryptResult;
    /**
     * Export this session's key at its earliest known ratchet index, so a
     * recipient that missed the original share can still read the whole
     * session. The session id is preserved (it is derived from the signing
     * key, which the exported key carries).
     */
    exportAtFirstKnownIndex(): string;
    /**
     * Lowest ratchet index this session can decrypt. Messages sent before the
     * key was exported are permanently unreadable by this importer.
     */
    firstKnownIndex(): number;
    /**
     * Build an inbound session from an EXPORTED session key (as produced by
     * `exportAtFirstKnownIndex`). Used when a key share is re-sent from an
     * already-imported session, so the sender never has to keep raw key
     * material outside an encrypted pickle (spec §12.4).
     */
    static fromExportedSessionKey(exported_key_b64: string): EngineInboundGroupSession;
    static fromPickle(encrypted_pickle: string, pickle_key: Uint8Array): EngineInboundGroupSession;
    /**
     * Build an inbound session from a base64 session key produced by
     * `EngineGroupSession.sessionKey()`.
     */
    static fromSessionKey(session_key_b64: string): EngineInboundGroupSession;
    pickle(pickle_key: Uint8Array): string;
    sessionId(): string;
}

/**
 * Account cross-signing master key. Wraps a vodozemac `Ed25519SecretKey`.
 */
export class EngineMasterKey {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Restore a master key from a `sealSecret` blob (the vault's at-rest form).
     */
    static fromSealed(sealed_b64: string, pickle_key: Uint8Array): EngineMasterKey;
    /**
     * Restore a master key from its raw base64 secret — the form transferred
     * to another of the account's own devices over the pairwise Olm channel
     * (D6). Callers MUST check `publicKey()` against the published master key
     * before storing.
     */
    static fromSecret(secret_b64: string): EngineMasterKey;
    /**
     * Generate a fresh master key.
     */
    constructor();
    /**
     * Base64 of the public master key (the account identity that is published
     * and compared out of band as the account safety number).
     */
    publicKey(): string;
    /**
     * Seal the private half for storage (AES-256-GCM under the vault key).
     */
    seal(pickle_key: Uint8Array): string;
    /**
     * Sign a canonical UTF-8 string (master self-signature, device
     * cross-signature). Verified with the existing `verify_ed25519`.
     */
    sign(message: string): string;
}

export class EngineSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypt a message previously produced by the peer's session.
     */
    decrypt(message_type: number, body_b64: string): string;
    /**
     * Decrypt a device-approval payload into a usable master key. The expected
     * public key is checked HERE, so JS cannot skip the check, and the private
     * half is never exposed to it.
     */
    decryptMasterSecret(message_type: number, body_b64: string, expected_master_key: string): EngineMasterKey;
    /**
     * Encrypt UTF-8 plaintext. Returns { messageType, body } where body is
     * unpadded base64 and messageType is 0 (pre-key) or 1 (normal).
     */
    encrypt(plaintext: string): any;
    /**
     * Encrypt this account's master secret to another of OUR devices (spec
     * §14, device approval). The payload is assembled here so the private key
     * never becomes a JS string; the caller only ever sees Olm ciphertext.
     */
    encryptMasterSecret(master: EngineMasterKey): any;
    static fromPickle(encrypted_pickle: string, pickle_key: Uint8Array): EngineSession;
    hasReceivedMessage(): boolean;
    pickle(pickle_key: Uint8Array): string;
    sessionId(): string;
}

/**
 * Result of a Megolm decryption: the plaintext and the ratchet index the
 * message was encrypted at (callers use the index for replay detection).
 */
export class GroupDecryptResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly messageIndex: number;
    readonly plaintext: string;
}

/**
 * Result of creating an inbound session from a pre-key message: the new
 * session plus the plaintext of the message that established it.
 */
export class InboundResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Transfers ownership of the session to the caller. Callable once.
     */
    takeSession(): EngineSession;
    readonly plaintext: string;
}

/**
 * An inbound Olm session established BY a device-approval pre-key message,
 * plus the master key it carried.
 */
export class MasterInboundResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takeMasterKey(): EngineMasterKey;
    takeSession(): EngineSession;
}

export function decryptAttachment(ciphertext: Uint8Array, key_b64: string, iv_b64: string): Uint8Array;

export function encryptAttachment(bytes: Uint8Array): EncryptedAttachment;

/**
 * Engine/version identifier baked into envelopes and diagnostics.
 */
export function engine_version(): string;

/**
 * Account-level safety number over the PUBLIC cross-signing master keys
 * (spec §14 / decision D3). Same construction and shape as `safety_number`
 * — 30 digits per party, halves sorted, 60 digits total — but seeded from the
 * account master key instead of a single device's identity keys, so one
 * comparison covers every cross-signed device of that account.
 */
export function master_safety_number(user_a: string, master_a_b64: string, user_b: string, master_b_b64: string): string;

/**
 * Open a blob produced by `sealSecret`. Fails on a wrong key or any tampering
 * (GCM auth tag). Error messages never carry key or plaintext material.
 */
export function openSecret(sealed_b64: string, context: string, pickle_key: Uint8Array): string;

/**
 * Session id embedded in a pre-key message (for matching against an
 * existing session before deciding to create a new inbound session).
 */
export function prekey_message_session_id(prekey_body_b64: string): string;

/**
 * Safety-number fingerprint over PUBLIC identity keys only (Signal-style:
 * iterated SHA-512, 30 digits per party, halves sorted for a canonical
 * 60-digit number both sides can compare). Spec: docs/e2e-dm-spec.md §8.
 */
export function safety_number(user_a: string, ed_a_b64: string, curve_a_b64: string, user_b: string, ed_b_b64: string, curve_b_b64: string): string;

/**
 * Seal a UTF-8 secret under a 32-byte key. Output: base64(nonce || ciphertext).
 */
export function sealSecret(plaintext: string, context: string, pickle_key: Uint8Array): string;

/**
 * Verify an Ed25519 signature over a UTF-8 message. Strict verification
 * (vodozemac 0.10 default). Returns an error when invalid.
 */
export function verify_ed25519(key_b64: string, message: string, signature_b64: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_encryptedattachment_free: (a: number, b: number) => void;
    readonly __wbg_engineaccount_free: (a: number, b: number) => void;
    readonly __wbg_enginegroupsession_free: (a: number, b: number) => void;
    readonly __wbg_engineinboundgroupsession_free: (a: number, b: number) => void;
    readonly __wbg_enginemasterkey_free: (a: number, b: number) => void;
    readonly __wbg_enginesession_free: (a: number, b: number) => void;
    readonly __wbg_groupdecryptresult_free: (a: number, b: number) => void;
    readonly __wbg_inboundresult_free: (a: number, b: number) => void;
    readonly __wbg_masterinboundresult_free: (a: number, b: number) => void;
    readonly decryptAttachment: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly encryptAttachment: (a: number, b: number) => [number, number, number];
    readonly encryptedattachment_iv: (a: number) => [number, number];
    readonly encryptedattachment_key: (a: number) => [number, number];
    readonly encryptedattachment_takeCiphertext: (a: number) => [number, number];
    readonly engine_version: () => [number, number];
    readonly engineaccount_createInboundSession: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly engineaccount_createInboundSessionForMasterSecret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly engineaccount_createOutboundSession: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly engineaccount_curve25519Key: (a: number) => [number, number];
    readonly engineaccount_ed25519Key: (a: number) => [number, number];
    readonly engineaccount_fallbackKey: (a: number) => [number, number, number];
    readonly engineaccount_fromPickle: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly engineaccount_generateFallbackKey: (a: number) => void;
    readonly engineaccount_generateOneTimeKeys: (a: number, b: number) => [number, number, number];
    readonly engineaccount_markKeysAsPublished: (a: number) => void;
    readonly engineaccount_maxOneTimeKeys: (a: number) => number;
    readonly engineaccount_new: () => number;
    readonly engineaccount_oneTimeKeys: (a: number) => [number, number, number];
    readonly engineaccount_pickle: (a: number, b: number, c: number) => [number, number, number, number];
    readonly engineaccount_sign: (a: number, b: number, c: number) => [number, number];
    readonly enginegroupsession_encrypt: (a: number, b: number, c: number) => [number, number];
    readonly enginegroupsession_fromPickle: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly enginegroupsession_messageIndex: (a: number) => number;
    readonly enginegroupsession_new: () => number;
    readonly enginegroupsession_pickle: (a: number, b: number, c: number) => [number, number, number, number];
    readonly enginegroupsession_sessionId: (a: number) => [number, number];
    readonly enginegroupsession_sessionKey: (a: number) => [number, number];
    readonly engineinboundgroupsession_decrypt: (a: number, b: number, c: number) => [number, number, number];
    readonly engineinboundgroupsession_exportAtFirstKnownIndex: (a: number) => [number, number];
    readonly engineinboundgroupsession_firstKnownIndex: (a: number) => number;
    readonly engineinboundgroupsession_fromExportedSessionKey: (a: number, b: number) => [number, number, number];
    readonly engineinboundgroupsession_fromPickle: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly engineinboundgroupsession_fromSessionKey: (a: number, b: number) => [number, number, number];
    readonly engineinboundgroupsession_pickle: (a: number, b: number, c: number) => [number, number, number, number];
    readonly engineinboundgroupsession_sessionId: (a: number) => [number, number];
    readonly enginemasterkey_fromSealed: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly enginemasterkey_fromSecret: (a: number, b: number) => [number, number, number];
    readonly enginemasterkey_new: () => number;
    readonly enginemasterkey_publicKey: (a: number) => [number, number];
    readonly enginemasterkey_seal: (a: number, b: number, c: number) => [number, number, number, number];
    readonly enginemasterkey_sign: (a: number, b: number, c: number) => [number, number];
    readonly enginesession_decrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly enginesession_decryptMasterSecret: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly enginesession_encrypt: (a: number, b: number, c: number) => [number, number, number];
    readonly enginesession_encryptMasterSecret: (a: number, b: number) => [number, number, number];
    readonly enginesession_fromPickle: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly enginesession_hasReceivedMessage: (a: number) => number;
    readonly enginesession_pickle: (a: number, b: number, c: number) => [number, number, number, number];
    readonly enginesession_sessionId: (a: number) => [number, number];
    readonly groupdecryptresult_messageIndex: (a: number) => number;
    readonly groupdecryptresult_plaintext: (a: number) => [number, number];
    readonly inboundresult_plaintext: (a: number) => [number, number];
    readonly inboundresult_takeSession: (a: number) => [number, number, number];
    readonly master_safety_number: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly masterinboundresult_takeMasterKey: (a: number) => [number, number, number];
    readonly masterinboundresult_takeSession: (a: number) => [number, number, number];
    readonly openSecret: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly prekey_message_session_id: (a: number, b: number) => [number, number, number, number];
    readonly safety_number: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly sealSecret: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly verify_ed25519: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
