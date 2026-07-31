/* @ts-self-types="./voxium_crypto_engine.d.ts" */

/**
 * Result of encrypting attachment bytes: random key + nonce (base64) and the
 * ciphertext (plaintext + 16-byte tag).
 */
export class EncryptedAttachment {
    static __wrap(ptr) {
        const obj = Object.create(EncryptedAttachment.prototype);
        obj.__wbg_ptr = ptr;
        EncryptedAttachmentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptedAttachmentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptedattachment_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get iv() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedattachment_iv(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get key() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedattachment_key(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Transfers the ciphertext to the caller without copying megabytes twice.
     * Callable once.
     * @returns {Uint8Array}
     */
    takeCiphertext() {
        const ret = wasm.encryptedattachment_takeCiphertext(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) EncryptedAttachment.prototype[Symbol.dispose] = EncryptedAttachment.prototype.free;

export class EngineAccount {
    static __wrap(ptr) {
        const obj = Object.create(EngineAccount.prototype);
        obj.__wbg_ptr = ptr;
        EngineAccountFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineAccountFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engineaccount_free(ptr, 0);
    }
    /**
     * Establish an inbound session from a pre-key message. The expected
     * identity key MUST be the peer's pinned/server-published key — vodozemac
     * rejects the message if it was not created by that identity.
     * @param {string} their_identity_key_b64
     * @param {string} prekey_body_b64
     * @returns {InboundResult}
     */
    createInboundSession(their_identity_key_b64, prekey_body_b64) {
        const ptr0 = passStringToWasm0(their_identity_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(prekey_body_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engineaccount_createInboundSession(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return InboundResult.__wrap(ret[0]);
    }
    /**
     * Device approval arriving as a PRE-KEY message (the usual case for a
     * device that has never talked to its sibling): establishes the session and
     * returns the master key without the secret ever reaching JS.
     * @param {string} their_identity_key_b64
     * @param {string} prekey_body_b64
     * @param {string} expected_master_key
     * @returns {MasterInboundResult}
     */
    createInboundSessionForMasterSecret(their_identity_key_b64, prekey_body_b64, expected_master_key) {
        const ptr0 = passStringToWasm0(their_identity_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(prekey_body_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(expected_master_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.engineaccount_createInboundSessionForMasterSecret(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return MasterInboundResult.__wrap(ret[0]);
    }
    /**
     * Establish an outbound session to a peer from their (already
     * signature-verified) identity key and one-time/fallback key.
     * @param {string} their_identity_key_b64
     * @param {string} their_one_time_key_b64
     * @returns {EngineSession}
     */
    createOutboundSession(their_identity_key_b64, their_one_time_key_b64) {
        const ptr0 = passStringToWasm0(their_identity_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(their_one_time_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engineaccount_createOutboundSession(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineSession.__wrap(ret[0]);
    }
    /**
     * @returns {string}
     */
    curve25519Key() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineaccount_curve25519Key(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    ed25519Key() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineaccount_ed25519Key(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Unpublished fallback key as { keyId, key } or null.
     * @returns {any}
     */
    fallbackKey() {
        const ret = wasm.engineaccount_fallbackKey(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Restore an account from an encrypted pickle (decryption happens inside
     * vodozemac; the pickle key is wiped from this crate's memory after use).
     * @param {string} encrypted_pickle
     * @param {Uint8Array} pickle_key
     * @returns {EngineAccount}
     */
    static fromPickle(encrypted_pickle, pickle_key) {
        const ptr0 = passStringToWasm0(encrypted_pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engineaccount_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineAccount.__wrap(ret[0]);
    }
    generateFallbackKey() {
        wasm.engineaccount_generateFallbackKey(this.__wbg_ptr);
    }
    /**
     * @param {number} count
     * @returns {any}
     */
    generateOneTimeKeys(count) {
        const ret = wasm.engineaccount_generateOneTimeKeys(this.__wbg_ptr, count);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    markKeysAsPublished() {
        wasm.engineaccount_markKeysAsPublished(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    maxOneTimeKeys() {
        const ret = wasm.engineaccount_maxOneTimeKeys(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.engineaccount_new();
        this.__wbg_ptr = ret;
        EngineAccountFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Unpublished one-time keys as [{ keyId, key }].
     * @returns {any}
     */
    oneTimeKeys() {
        const ret = wasm.engineaccount_oneTimeKeys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} pickle_key
     * @returns {string}
     */
    pickle(pickle_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engineaccount_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Sign a UTF-8 message with the account's Ed25519 key.
     * @param {string} message
     * @returns {string}
     */
    sign(message) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engineaccount_sign(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) EngineAccount.prototype[Symbol.dispose] = EngineAccount.prototype.free;

/**
 * Outbound Megolm group session — the sending half. Owns the signing key, so
 * its pickle is secret material and never leaves the vault.
 */
export class EngineGroupSession {
    static __wrap(ptr) {
        const obj = Object.create(EngineGroupSession.prototype);
        obj.__wbg_ptr = ptr;
        EngineGroupSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineGroupSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_enginegroupsession_free(ptr, 0);
    }
    /**
     * Encrypt UTF-8 plaintext. Returns the unpadded-base64 MegolmMessage.
     * @param {string} plaintext
     * @returns {string}
     */
    encrypt(plaintext) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginegroupsession_encrypt(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} encrypted_pickle
     * @param {Uint8Array} pickle_key
     * @returns {EngineGroupSession}
     */
    static fromPickle(encrypted_pickle, pickle_key) {
        const ptr0 = passStringToWasm0(encrypted_pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.enginegroupsession_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineGroupSession.__wrap(ret[0]);
    }
    /**
     * Number of messages already encrypted (== the index the next message
     * will use).
     * @returns {number}
     */
    messageIndex() {
        const ret = wasm.enginegroupsession_messageIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a fresh outbound group session. Megolm session config is pinned
     * to version 1 (the interoperable, non-experimental variant).
     */
    constructor() {
        const ret = wasm.enginegroupsession_new();
        this.__wbg_ptr = ret;
        EngineGroupSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} pickle_key
     * @returns {string}
     */
    pickle(pickle_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginegroupsession_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Globally unique session id (base64 of the session's Ed25519 public key).
     * @returns {string}
     */
    sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.enginegroupsession_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Export the session key at the CURRENT ratchet index, base64-encoded.
     * This is the secret shared with recipient devices (and with our own
     * device, so the sender can decrypt its own history). Recipients can only
     * decrypt messages from this index onwards.
     * @returns {string}
     */
    sessionKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.enginegroupsession_sessionKey(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) EngineGroupSession.prototype[Symbol.dispose] = EngineGroupSession.prototype.free;

/**
 * Inbound Megolm group session — the receiving half, rebuilt from a session
 * key that arrived over the authenticated pairwise Olm channel.
 */
export class EngineInboundGroupSession {
    static __wrap(ptr) {
        const obj = Object.create(EngineInboundGroupSession.prototype);
        obj.__wbg_ptr = ptr;
        EngineInboundGroupSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineInboundGroupSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engineinboundgroupsession_free(ptr, 0);
    }
    /**
     * Decrypt an unpadded-base64 MegolmMessage.
     * @param {string} ciphertext_b64
     * @returns {GroupDecryptResult}
     */
    decrypt(ciphertext_b64) {
        const ptr0 = passStringToWasm0(ciphertext_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engineinboundgroupsession_decrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return GroupDecryptResult.__wrap(ret[0]);
    }
    /**
     * Export this session's key at its earliest known ratchet index, so a
     * recipient that missed the original share can still read the whole
     * session. The session id is preserved (it is derived from the signing
     * key, which the exported key carries).
     * @returns {string}
     */
    exportAtFirstKnownIndex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineinboundgroupsession_exportAtFirstKnownIndex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Lowest ratchet index this session can decrypt. Messages sent before the
     * key was exported are permanently unreadable by this importer.
     * @returns {number}
     */
    firstKnownIndex() {
        const ret = wasm.engineinboundgroupsession_firstKnownIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Build an inbound session from an EXPORTED session key (as produced by
     * `exportAtFirstKnownIndex`). Used when a key share is re-sent from an
     * already-imported session, so the sender never has to keep raw key
     * material outside an encrypted pickle (spec §12.4).
     * @param {string} exported_key_b64
     * @returns {EngineInboundGroupSession}
     */
    static fromExportedSessionKey(exported_key_b64) {
        const ptr0 = passStringToWasm0(exported_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engineinboundgroupsession_fromExportedSessionKey(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineInboundGroupSession.__wrap(ret[0]);
    }
    /**
     * @param {string} encrypted_pickle
     * @param {Uint8Array} pickle_key
     * @returns {EngineInboundGroupSession}
     */
    static fromPickle(encrypted_pickle, pickle_key) {
        const ptr0 = passStringToWasm0(encrypted_pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engineinboundgroupsession_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineInboundGroupSession.__wrap(ret[0]);
    }
    /**
     * Build an inbound session from a base64 session key produced by
     * `EngineGroupSession.sessionKey()`.
     * @param {string} session_key_b64
     * @returns {EngineInboundGroupSession}
     */
    static fromSessionKey(session_key_b64) {
        const ptr0 = passStringToWasm0(session_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engineinboundgroupsession_fromSessionKey(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineInboundGroupSession.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} pickle_key
     * @returns {string}
     */
    pickle(pickle_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engineinboundgroupsession_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineinboundgroupsession_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) EngineInboundGroupSession.prototype[Symbol.dispose] = EngineInboundGroupSession.prototype.free;

/**
 * Account cross-signing master key. Wraps a vodozemac `Ed25519SecretKey`.
 */
export class EngineMasterKey {
    static __wrap(ptr) {
        const obj = Object.create(EngineMasterKey.prototype);
        obj.__wbg_ptr = ptr;
        EngineMasterKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineMasterKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_enginemasterkey_free(ptr, 0);
    }
    /**
     * Restore a master key from a `sealSecret` blob (the vault's at-rest form).
     * @param {string} sealed_b64
     * @param {Uint8Array} pickle_key
     * @returns {EngineMasterKey}
     */
    static fromSealed(sealed_b64, pickle_key) {
        const ptr0 = passStringToWasm0(sealed_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.enginemasterkey_fromSealed(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineMasterKey.__wrap(ret[0]);
    }
    /**
     * Restore a master key from its raw base64 secret — the form transferred
     * to another of the account's own devices over the pairwise Olm channel
     * (D6). Callers MUST check `publicKey()` against the published master key
     * before storing.
     * @param {string} secret_b64
     * @returns {EngineMasterKey}
     */
    static fromSecret(secret_b64) {
        const ptr0 = passStringToWasm0(secret_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.enginemasterkey_fromSecret(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineMasterKey.__wrap(ret[0]);
    }
    /**
     * Generate a fresh master key.
     */
    constructor() {
        const ret = wasm.enginemasterkey_new();
        this.__wbg_ptr = ret;
        EngineMasterKeyFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Open a backed-up session key. Fails closed on a wrong account key, a
     * tampered blob, or a blob restored into the wrong conversation/session.
     * @param {string} sealed_b64
     * @param {string} context
     * @returns {string}
     */
    openSessionKey(sealed_b64, context) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(sealed_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(context, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.enginemasterkey_openSessionKey(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Base64 of the public master key (the account identity that is published
     * and compared out of band as the account safety number).
     * @returns {string}
     */
    publicKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.enginemasterkey_publicKey(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Seal the private half for storage (AES-256-GCM under the vault key).
     * @param {Uint8Array} pickle_key
     * @returns {string}
     */
    seal(pickle_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginemasterkey_seal(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Seal this key into a backup blob under a recovery key (spec §15). The
     * payload carries the public half too, so restoring can prove the blob
     * belongs to the account before anything is stored.
     * @param {string} recovery_key
     * @returns {string}
     */
    sealForBackup(recovery_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(recovery_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginemasterkey_sealForBackup(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Seal one Megolm session key for backup (spec §16). `context` is the
     * conversation and session it belongs to, so a blob cannot be replayed
     * into a different conversation.
     * @param {string} session_key_b64
     * @param {string} context
     * @returns {string}
     */
    sealSessionKey(session_key_b64, context) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(session_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(context, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.enginemasterkey_sealSessionKey(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Sign a canonical UTF-8 string (master self-signature, device
     * cross-signature). Verified with the existing `verify_ed25519`.
     * @param {string} message
     * @returns {string}
     */
    sign(message) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginemasterkey_sign(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) EngineMasterKey.prototype[Symbol.dispose] = EngineMasterKey.prototype.free;

export class EngineSession {
    static __wrap(ptr) {
        const obj = Object.create(EngineSession.prototype);
        obj.__wbg_ptr = ptr;
        EngineSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_enginesession_free(ptr, 0);
    }
    /**
     * Decrypt a message previously produced by the peer's session.
     *
     * A device-approval payload is refused here even though it decrypts fine:
     * Olm gives no domain separation of its own, so without this check a
     * server could re-file an approval envelope into any other mailbox (key
     * shares, DM ciphertext) and have the client hand it back as a plaintext
     * JS string — the one thing `encryptMasterSecret` exists to prevent.
     * @param {number} message_type
     * @param {string} body_b64
     * @returns {string}
     */
    decrypt(message_type, body_b64) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(body_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginesession_decrypt(this.__wbg_ptr, message_type, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Decrypt a device-approval payload into a usable master key. The expected
     * public key is checked HERE, so JS cannot skip the check, and the private
     * half is never exposed to it.
     * @param {number} message_type
     * @param {string} body_b64
     * @param {string} expected_master_key
     * @returns {EngineMasterKey}
     */
    decryptMasterSecret(message_type, body_b64, expected_master_key) {
        const ptr0 = passStringToWasm0(body_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(expected_master_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.enginesession_decryptMasterSecret(this.__wbg_ptr, message_type, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineMasterKey.__wrap(ret[0]);
    }
    /**
     * Encrypt UTF-8 plaintext. Returns { messageType, body } where body is
     * unpadded base64 and messageType is 0 (pre-key) or 1 (normal).
     * @param {string} plaintext
     * @returns {any}
     */
    encrypt(plaintext) {
        const ptr0 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.enginesession_encrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Encrypt this account's master secret to another of OUR devices (spec
     * §14, device approval). The payload is assembled here so the private key
     * never becomes a JS string; the caller only ever sees Olm ciphertext.
     * @param {EngineMasterKey} master
     * @returns {any}
     */
    encryptMasterSecret(master) {
        _assertClass(master, EngineMasterKey);
        const ret = wasm.enginesession_encryptMasterSecret(this.__wbg_ptr, master.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {string} encrypted_pickle
     * @param {Uint8Array} pickle_key
     * @returns {EngineSession}
     */
    static fromPickle(encrypted_pickle, pickle_key) {
        const ptr0 = passStringToWasm0(encrypted_pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.enginesession_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineSession.__wrap(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    hasReceivedMessage() {
        const ret = wasm.enginesession_hasReceivedMessage(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} pickle_key
     * @returns {string}
     */
    pickle(pickle_key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.enginesession_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.enginesession_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) EngineSession.prototype[Symbol.dispose] = EngineSession.prototype.free;

/**
 * Result of a Megolm decryption: the plaintext and the ratchet index the
 * message was encrypted at (callers use the index for replay detection).
 */
export class GroupDecryptResult {
    static __wrap(ptr) {
        const obj = Object.create(GroupDecryptResult.prototype);
        obj.__wbg_ptr = ptr;
        GroupDecryptResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupDecryptResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_groupdecryptresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get messageIndex() {
        const ret = wasm.groupdecryptresult_messageIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get plaintext() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.groupdecryptresult_plaintext(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) GroupDecryptResult.prototype[Symbol.dispose] = GroupDecryptResult.prototype.free;

/**
 * Result of creating an inbound session from a pre-key message: the new
 * session plus the plaintext of the message that established it.
 */
export class InboundResult {
    static __wrap(ptr) {
        const obj = Object.create(InboundResult.prototype);
        obj.__wbg_ptr = ptr;
        InboundResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InboundResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inboundresult_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get plaintext() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.inboundresult_plaintext(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Transfers ownership of the session to the caller. Callable once.
     * @returns {EngineSession}
     */
    takeSession() {
        const ret = wasm.inboundresult_takeSession(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineSession.__wrap(ret[0]);
    }
}
if (Symbol.dispose) InboundResult.prototype[Symbol.dispose] = InboundResult.prototype.free;

/**
 * An inbound Olm session established BY a device-approval pre-key message,
 * plus the master key it carried.
 */
export class MasterInboundResult {
    static __wrap(ptr) {
        const obj = Object.create(MasterInboundResult.prototype);
        obj.__wbg_ptr = ptr;
        MasterInboundResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MasterInboundResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_masterinboundresult_free(ptr, 0);
    }
    /**
     * @returns {EngineMasterKey}
     */
    takeMasterKey() {
        const ret = wasm.masterinboundresult_takeMasterKey(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineMasterKey.__wrap(ret[0]);
    }
    /**
     * @returns {EngineSession}
     */
    takeSession() {
        const ret = wasm.masterinboundresult_takeSession(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EngineSession.__wrap(ret[0]);
    }
}
if (Symbol.dispose) MasterInboundResult.prototype[Symbol.dispose] = MasterInboundResult.prototype.free;

/**
 * @param {Uint8Array} ciphertext
 * @param {string} key_b64
 * @param {string} iv_b64
 * @returns {Uint8Array}
 */
export function decryptAttachment(ciphertext, key_b64, iv_b64) {
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(iv_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decryptAttachment(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * @param {Uint8Array} bytes
 * @returns {EncryptedAttachment}
 */
export function encryptAttachment(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encryptAttachment(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return EncryptedAttachment.__wrap(ret[0]);
}

/**
 * Engine/version identifier baked into envelopes and diagnostics.
 * @returns {string}
 */
export function engine_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.engine_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Mint a recovery key: 32 random bytes plus a checksum byte, base32, grouped
 * in fours so it can be read aloud and written down without losing your place.
 * @returns {string}
 */
export function generateRecoveryKey() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generateRecoveryKey();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Does this look like a recovery key at all (checksum included)? Lets the UI
 * reject a typo without touching the network or the blob.
 * @param {string} text
 * @returns {boolean}
 */
export function isRecoveryKeyWellFormed(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.isRecoveryKeyWellFormed(ptr0, len0);
    return ret !== 0;
}

/**
 * Account-level safety number over the PUBLIC cross-signing master keys
 * (spec §14 / decision D3). Same construction and shape as `safety_number`
 * — 30 digits per party, halves sorted, 60 digits total — but seeded from the
 * account master key instead of a single device's identity keys, so one
 * comparison covers every cross-signed device of that account.
 * @param {string} user_a
 * @param {string} master_a_b64
 * @param {string} user_b
 * @param {string} master_b_b64
 * @returns {string}
 */
export function master_safety_number(user_a, master_a_b64, user_b, master_b_b64) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(user_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(master_a_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(user_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(master_b_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.master_safety_number(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Open a backup blob and prove it holds the account's key.
 *
 * The expected key is what the account PUBLISHES. A blob that decrypts to
 * anything else is refused rather than adopted: otherwise a server could hand
 * back a blob of its own making and the "recovery" would install its key.
 * @param {string} blob_b64
 * @param {string} recovery_key
 * @param {string} expected_master_key
 * @returns {EngineMasterKey}
 */
export function openMasterKeyBackup(blob_b64, recovery_key, expected_master_key) {
    const ptr0 = passStringToWasm0(blob_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(recovery_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(expected_master_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.openMasterKeyBackup(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return EngineMasterKey.__wrap(ret[0]);
}

/**
 * Open a blob produced by `sealSecret`. Fails on a wrong key or any tampering
 * (GCM auth tag). Error messages never carry key or plaintext material.
 * @param {string} sealed_b64
 * @param {string} context
 * @param {Uint8Array} pickle_key
 * @returns {string}
 */
export function openSecret(sealed_b64, context, pickle_key) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(sealed_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(context, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.openSecret(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Session id embedded in a pre-key message (for matching against an
 * existing session before deciding to create a new inbound session).
 * @param {string} prekey_body_b64
 * @returns {string}
 */
export function prekey_message_session_id(prekey_body_b64) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(prekey_body_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.prekey_message_session_id(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Safety-number fingerprint over PUBLIC identity keys only (Signal-style:
 * iterated SHA-512, 30 digits per party, halves sorted for a canonical
 * 60-digit number both sides can compare). Spec: docs/e2e-dm-spec.md §8.
 * @param {string} user_a
 * @param {string} ed_a_b64
 * @param {string} curve_a_b64
 * @param {string} user_b
 * @param {string} ed_b_b64
 * @param {string} curve_b_b64
 * @returns {string}
 */
export function safety_number(user_a, ed_a_b64, curve_a_b64, user_b, ed_b_b64, curve_b_b64) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passStringToWasm0(user_a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(ed_a_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(curve_a_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(user_b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(ed_b_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(curve_b_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.safety_number(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        var ptr7 = ret[0];
        var len7 = ret[1];
        if (ret[3]) {
            ptr7 = 0; len7 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred8_0 = ptr7;
        deferred8_1 = len7;
        return getStringFromWasm0(ptr7, len7);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}

/**
 * Seal a UTF-8 secret under a 32-byte key. Output: base64(nonce || ciphertext).
 * @param {string} plaintext
 * @param {string} context
 * @param {Uint8Array} pickle_key
 * @returns {string}
 */
export function sealSecret(plaintext, context, pickle_key) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(context, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(pickle_key, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.sealSecret(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Verify an Ed25519 signature over a UTF-8 message. Strict verification
 * (vodozemac 0.10 default). Returns an error when invalid.
 * @param {string} key_b64
 * @param {string} message
 * @param {string} signature_b64
 */
export function verify_ed25519(key_b64, message, signature_b64) {
    const ptr0 = passStringToWasm0(key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(signature_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verify_ed25519(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./voxium_crypto_engine_bg.js": import0,
    };
}

const EncryptedAttachmentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedattachment_free(ptr, 1));
const EngineAccountFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engineaccount_free(ptr, 1));
const EngineGroupSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_enginegroupsession_free(ptr, 1));
const EngineInboundGroupSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engineinboundgroupsession_free(ptr, 1));
const EngineMasterKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_enginemasterkey_free(ptr, 1));
const EngineSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_enginesession_free(ptr, 1));
const GroupDecryptResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_groupdecryptresult_free(ptr, 1));
const InboundResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inboundresult_free(ptr, 1));
const MasterInboundResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_masterinboundresult_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('voxium_crypto_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
