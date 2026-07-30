//! Voxium E2E crypto engine v1 ("olm1") — wasm-bindgen bindings over vodozemac.
//!
//! DESIGN RULE (see docs/e2e-dm-spec.md): this crate is a pure marshalling
//! layer. It converts between JS types (strings, byte arrays) and vodozemac
//! types. It must never implement crypto logic of its own — no key derivation,
//! no ratcheting, no MAC/signature construction. The only computation allowed
//! here is encoding (base64/UTF-8) and the safety-number fingerprint digest,
//! which operates exclusively on PUBLIC key material.
//!
//! All binary values crossing the JS boundary are unpadded standard base64
//! (vodozemac's canonical encoding). Pickle keys are 32 raw bytes and are
//! zeroized after use.

use serde::Serialize;
use sha2::{Digest, Sha512};
use vodozemac::megolm::{
    ExportedSessionKey, GroupSession, GroupSessionPickle, InboundGroupSession,
    InboundGroupSessionPickle, MegolmMessage, SessionConfig as MegolmSessionConfig, SessionKey,
};
use vodozemac::olm::{
    Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle,
};
use vodozemac::{
    base64_decode, base64_encode, Curve25519PublicKey, Ed25519PublicKey, Ed25519SecretKey,
    Ed25519Signature,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

const PICKLE_KEY_LEN: usize = 32;

fn pickle_key_from_js(bytes: &[u8]) -> Result<[u8; PICKLE_KEY_LEN], JsError> {
    if bytes.len() != PICKLE_KEY_LEN {
        return Err(JsError::new("pickle key must be exactly 32 bytes"));
    }
    let mut key = [0u8; PICKLE_KEY_LEN];
    key.copy_from_slice(bytes);
    Ok(key)
}

fn curve_key(b64: &str) -> Result<Curve25519PublicKey, JsError> {
    Curve25519PublicKey::from_base64(b64).map_err(|_| JsError::new("invalid curve25519 public key"))
}

fn ed_key(b64: &str) -> Result<Ed25519PublicKey, JsError> {
    Ed25519PublicKey::from_base64(b64).map_err(|_| JsError::new("invalid ed25519 public key"))
}

#[derive(Serialize)]
struct JsOneTimeKey {
    #[serde(rename = "keyId")]
    key_id: String,
    key: String,
}

#[derive(Serialize)]
struct JsEncrypted {
    #[serde(rename = "messageType")]
    message_type: usize,
    body: String,
}

/// Engine/version identifier baked into envelopes and diagnostics.
#[wasm_bindgen]
pub fn engine_version() -> String {
    "olm1/vodozemac-0.10.0".to_string()
}

// ─── E2E attachment file encryption (spec §13) ───────────────────────────────
// Per-file AES-256-GCM with a random key + nonce; the key/nonce travel inside
// the message ciphertext, the encrypted blob goes to S3. GCM's auth tag makes
// a swapped/corrupted blob fail decryption — no separate content hash needed.

/// Result of encrypting attachment bytes: random key + nonce (base64) and the
/// ciphertext (plaintext + 16-byte tag).
#[wasm_bindgen]
pub struct EncryptedAttachment {
    key_b64: String,
    iv_b64: String,
    ciphertext: Vec<u8>,
}

#[wasm_bindgen]
impl EncryptedAttachment {
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> String {
        self.key_b64.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn iv(&self) -> String {
        self.iv_b64.clone()
    }

    /// Transfers the ciphertext to the caller without copying megabytes twice.
    /// Callable once.
    #[wasm_bindgen(js_name = takeCiphertext)]
    pub fn take_ciphertext(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.ciphertext)
    }
}

#[wasm_bindgen(js_name = encryptAttachment)]
pub fn encrypt_attachment(bytes: &[u8]) -> Result<EncryptedAttachment, JsError> {
    use aes_gcm::aead::rand_core::RngCore;
    use aes_gcm::aead::{Aead, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Nonce};

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| JsError::new("cipher init failed"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), bytes)
        .map_err(|_| JsError::new("attachment encryption failed"))?;

    let result = EncryptedAttachment {
        key_b64: base64_encode(key),
        iv_b64: base64_encode(nonce_bytes),
        ciphertext,
    };
    key.zeroize();
    Ok(result)
}

#[wasm_bindgen(js_name = decryptAttachment)]
pub fn decrypt_attachment(ciphertext: &[u8], key_b64: &str, iv_b64: &str) -> Result<Vec<u8>, JsError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let mut key = base64_decode(key_b64).map_err(|_| JsError::new("invalid attachment key"))?;
    if key.len() != 32 {
        key.zeroize();
        return Err(JsError::new("invalid attachment key length"));
    }
    let nonce = base64_decode(iv_b64).map_err(|_| JsError::new("invalid attachment iv"))?;
    if nonce.len() != 12 {
        key.zeroize();
        return Err(JsError::new("invalid attachment iv length"));
    }

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| JsError::new("cipher init failed"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext)
        .map_err(|_| JsError::new("attachment decryption failed"));
    key.zeroize();
    plaintext
}

// ─── Generic secret sealing (spec §7: no raw key material at rest) ───────────
// Used for secrets that are NOT vodozemac pickles (which carry their own
// encryption), e.g. the cross-signing master private key. AES-256-GCM with a
// random 12-byte nonce PREPENDED to the ciphertext; the whole blob is unpadded
// base64. The key is the vault's 32-byte pickle key (OS keychain backed).

/// Domain string for the device-approval payload carried inside an Olm
/// ciphertext. Deliberately not JSON: parsing it in Rust keeps the private key
/// out of the JS heap entirely (base64 never contains the separator).
const MASTER_TRANSFER_PREFIX: &str = "voxium-master-v1|";

/// AAD for the sealed master secret: binds the blob to the vault field it
/// belongs to, so two sealed fields under the same key are not interchangeable.
const MASTER_SECRET_CONTEXT: &str = "voxium-vault/master_secret";

/// Parse a device-approval payload and prove it is the account's key. Kept in
/// Rust so neither the raw secret nor the check can be bypassed from JS.
fn parse_master_transfer(mut plaintext: String, expected_master_key: &str) -> Result<EngineMasterKey, JsError> {
    let parsed = (|| {
        let rest = plaintext.strip_prefix(MASTER_TRANSFER_PREFIX)?;
        let (secret_b64, public_b64) = rest.split_once('|')?;
        Some((secret_b64.to_string(), public_b64.to_string()))
    })();
    plaintext.zeroize();

    let (mut secret_b64, public_b64) =
        parsed.ok_or_else(|| JsError::new("malformed master transfer payload"))?;
    let key = Ed25519SecretKey::from_base64(&secret_b64)
        .map_err(|_| JsError::new("invalid master key material"));
    secret_b64.zeroize();
    let key = key?;

    if key.public_key().to_base64() != public_b64 || public_b64 != expected_master_key {
        return Err(JsError::new("master transfer does not match the published account key"));
    }
    Ok(EngineMasterKey { inner: key })
}

/// An inbound Olm session established BY a device-approval pre-key message,
/// plus the master key it carried.
#[wasm_bindgen]
pub struct MasterInboundResult {
    session: Option<EngineSession>,
    master: Option<EngineMasterKey>,
}

#[wasm_bindgen]
impl MasterInboundResult {
    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(&mut self) -> Result<EngineSession, JsError> {
        self.session.take().ok_or_else(|| JsError::new("session already taken"))
    }

    #[wasm_bindgen(js_name = takeMasterKey)]
    pub fn take_master_key(&mut self) -> Result<EngineMasterKey, JsError> {
        self.master.take().ok_or_else(|| JsError::new("master key already taken"))
    }
}

const SEAL_NONCE_LEN: usize = 12;
const SEAL_TAG_LEN: usize = 16;

/// Seal a UTF-8 secret under a 32-byte key. Output: base64(nonce || ciphertext).
#[wasm_bindgen(js_name = sealSecret)]
pub fn seal_secret(plaintext: &str, context: &str, pickle_key: &[u8]) -> Result<String, JsError> {
    use aes_gcm::aead::rand_core::RngCore;
    use aes_gcm::aead::{Aead, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Nonce};

    let mut key = pickle_key_from_js(pickle_key)?;
    let mut nonce_bytes = [0u8; SEAL_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| JsError::new("cipher init failed"));
    let result = cipher.and_then(|cipher| {
        cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                aes_gcm::aead::Payload { msg: plaintext.as_bytes(), aad: context.as_bytes() },
            )
            .map_err(|_| JsError::new("secret sealing failed"))
    });
    key.zeroize();

    let ciphertext = result?;
    let mut blob = Vec::with_capacity(SEAL_NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(base64_encode(blob))
}

/// Open a blob produced by `sealSecret`. Fails on a wrong key or any tampering
/// (GCM auth tag). Error messages never carry key or plaintext material.
#[wasm_bindgen(js_name = openSecret)]
pub fn open_secret(sealed_b64: &str, context: &str, pickle_key: &[u8]) -> Result<String, JsError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let blob = base64_decode(sealed_b64).map_err(|_| JsError::new("invalid sealed secret"))?;
    if blob.len() < SEAL_NONCE_LEN + SEAL_TAG_LEN {
        return Err(JsError::new("invalid sealed secret length"));
    }
    let (nonce_bytes, ciphertext) = blob.split_at(SEAL_NONCE_LEN);

    let mut key = pickle_key_from_js(pickle_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| JsError::new("cipher init failed"));
    let result = cipher.and_then(|cipher| {
        cipher
            .decrypt(
                Nonce::from_slice(nonce_bytes),
                aes_gcm::aead::Payload { msg: ciphertext, aad: context.as_bytes() },
            )
            .map_err(|_| JsError::new("secret unsealing failed"))
    });
    key.zeroize();

    String::from_utf8(result?).map_err(|err| {
        let mut bytes = err.into_bytes();
        bytes.zeroize();
        JsError::new("sealed secret is not valid UTF-8")
    })
}

/// Verify an Ed25519 signature over a UTF-8 message. Strict verification
/// (vodozemac 0.10 default). Returns an error when invalid.
#[wasm_bindgen]
pub fn verify_ed25519(key_b64: &str, message: &str, signature_b64: &str) -> Result<(), JsError> {
    let key = ed_key(key_b64)?;
    let signature = Ed25519Signature::from_base64(signature_b64)
        .map_err(|_| JsError::new("invalid ed25519 signature encoding"))?;
    key.verify(message.as_bytes(), &signature)
        .map_err(|_| JsError::new("signature verification failed"))
}

/// Session id embedded in a pre-key message (for matching against an
/// existing session before deciding to create a new inbound session).
#[wasm_bindgen]
pub fn prekey_message_session_id(prekey_body_b64: &str) -> Result<String, JsError> {
    let bytes = base64_decode(prekey_body_b64).map_err(|_| JsError::new("invalid base64 body"))?;
    match OlmMessage::from_parts(0, &bytes).map_err(|_| JsError::new("invalid pre-key message"))? {
        OlmMessage::PreKey(m) => Ok(m.session_id()),
        OlmMessage::Normal(_) => Err(JsError::new("not a pre-key message")),
    }
}

/// Safety-number fingerprint over PUBLIC identity keys only (Signal-style:
/// iterated SHA-512, 30 digits per party, halves sorted for a canonical
/// 60-digit number both sides can compare). Spec: docs/e2e-dm-spec.md §8.
#[wasm_bindgen]
pub fn safety_number(
    user_a: &str,
    ed_a_b64: &str,
    curve_a_b64: &str,
    user_b: &str,
    ed_b_b64: &str,
    curve_b_b64: &str,
) -> Result<String, JsError> {
    let half_a = fingerprint_half(user_a, &ed_key(ed_a_b64)?, &curve_key(curve_a_b64)?);
    let half_b = fingerprint_half(user_b, &ed_key(ed_b_b64)?, &curve_key(curve_b_b64)?);
    let mut halves = [half_a, half_b];
    halves.sort();
    Ok(format!("{}{}", halves[0], halves[1]))
}

/// Account-level safety number over the PUBLIC cross-signing master keys
/// (spec §14 / decision D3). Same construction and shape as `safety_number`
/// — 30 digits per party, halves sorted, 60 digits total — but seeded from the
/// account master key instead of a single device's identity keys, so one
/// comparison covers every cross-signed device of that account.
#[wasm_bindgen]
pub fn master_safety_number(
    user_a: &str,
    master_a_b64: &str,
    user_b: &str,
    master_b_b64: &str,
) -> Result<String, JsError> {
    let half_a = master_fingerprint_half(user_a, &ed_key(master_a_b64)?);
    let half_b = master_fingerprint_half(user_b, &ed_key(master_b_b64)?);
    let mut halves = [half_a, half_b];
    halves.sort();
    Ok(format!("{}{}", halves[0], halves[1]))
}

fn fingerprint_half(user_id: &str, ed: &Ed25519PublicKey, curve: &Curve25519PublicKey) -> String {
    let mut seed = Vec::new();
    seed.extend_from_slice(b"voxium-sn-v1");
    seed.extend_from_slice(ed.as_bytes());
    seed.extend_from_slice(&curve.to_bytes());
    seed.extend_from_slice(user_id.as_bytes());
    fingerprint_digits(seed)
}

/// Distinct domain string from the per-device half so an account number can
/// never collide with (or be replayed as) a device number.
fn master_fingerprint_half(user_id: &str, master: &Ed25519PublicKey) -> String {
    let mut seed = Vec::new();
    seed.extend_from_slice(b"voxium-sn-master-v1");
    seed.extend_from_slice(master.as_bytes());
    seed.extend_from_slice(user_id.as_bytes());
    fingerprint_digits(seed)
}

fn fingerprint_digits(seed: Vec<u8>) -> String {
    const ITERATIONS: usize = 5200;
    let mut digest: Vec<u8> = seed.clone();
    for _ in 0..ITERATIONS {
        let mut hasher = Sha512::new();
        hasher.update(&digest);
        hasher.update(&seed);
        digest = hasher.finalize().to_vec();
    }
    // First 30 bytes -> six 5-digit groups (each 5 bytes as big-endian u64 % 100000)
    let mut out = String::with_capacity(30);
    for chunk in digest[..30].chunks(5) {
        let mut n: u64 = 0;
        for b in chunk {
            n = (n << 8) | u64::from(*b);
        }
        out.push_str(&format!("{:05}", n % 100_000));
    }
    out
}

// ─── Cross-signing master key (spec §14, decision D1/D2/D4) ──────────────────
// One Ed25519 keypair per ACCOUNT. It self-signs its own publication and signs
// every device of the account; peers verify that chain instead of pinning each
// device individually. There is no separate self-signing key (deviation from
// Matrix, decision D1): the master secret lives in the same vault as everything
// else, so the extra hop would buy no isolation.
//
// The private half NEVER leaves the device unsealed: at rest it is a `sealSecret`
// blob, in transit (device approval, D6) it is base64 inside an Olm ciphertext.

/// Account cross-signing master key. Wraps a vodozemac `Ed25519SecretKey`.
#[wasm_bindgen]
pub struct EngineMasterKey {
    inner: Ed25519SecretKey,
}

#[wasm_bindgen]
impl EngineMasterKey {
    /// Generate a fresh master key.
    #[wasm_bindgen(constructor)]
    pub fn new() -> EngineMasterKey {
        EngineMasterKey { inner: Ed25519SecretKey::new() }
    }

    /// Restore a master key from a `sealSecret` blob (the vault's at-rest form).
    #[wasm_bindgen(js_name = fromSealed)]
    pub fn from_sealed(sealed_b64: &str, pickle_key: &[u8]) -> Result<EngineMasterKey, JsError> {
        let mut secret_b64 = open_secret(sealed_b64, MASTER_SECRET_CONTEXT, pickle_key)?;
        let result = Ed25519SecretKey::from_base64(&secret_b64)
            .map(|inner| EngineMasterKey { inner })
            .map_err(|_| JsError::new("invalid master key material"));
        secret_b64.zeroize();
        result
    }

    /// Restore a master key from its raw base64 secret — the form transferred
    /// to another of the account's own devices over the pairwise Olm channel
    /// (D6). Callers MUST check `publicKey()` against the published master key
    /// before storing.
    #[wasm_bindgen(js_name = fromSecret)]
    pub fn from_secret(secret_b64: &str) -> Result<EngineMasterKey, JsError> {
        Ed25519SecretKey::from_base64(secret_b64)
            .map(|inner| EngineMasterKey { inner })
            .map_err(|_| JsError::new("invalid master key material"))
    }

    /// Internal: the private half, for building a device-approval payload
    /// inside this crate. Deliberately NOT exposed to JS — see
    /// EngineSession::encryptMasterSecret.
    fn secret_b64_internal(&self) -> String {
        self.inner.to_base64()
    }

    /// Seal the private half for storage (AES-256-GCM under the vault key).
    pub fn seal(&self, pickle_key: &[u8]) -> Result<String, JsError> {
        let mut secret_b64 = self.inner.to_base64();
        let result = seal_secret(&secret_b64, MASTER_SECRET_CONTEXT, pickle_key);
        secret_b64.zeroize();
        result
    }

    // The private half has no JS-facing accessor by design (spec §7/§14):
    // device approval goes through EngineSession::encryptMasterSecret so the
    // secret never exists as a JS string.

    /// Base64 of the public master key (the account identity that is published
    /// and compared out of band as the account safety number).
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> String {
        self.inner.public_key().to_base64()
    }

    /// Sign a canonical UTF-8 string (master self-signature, device
    /// cross-signature). Verified with the existing `verify_ed25519`.
    pub fn sign(&self, message: &str) -> String {
        self.inner.sign(message.as_bytes()).to_base64()
    }
}

impl Default for EngineMasterKey {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of creating an inbound session from a pre-key message: the new
/// session plus the plaintext of the message that established it.
#[wasm_bindgen]
pub struct InboundResult {
    session: Option<EngineSession>,
    plaintext: String,
}

#[wasm_bindgen]
impl InboundResult {
    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> String {
        self.plaintext.clone()
    }

    /// Transfers ownership of the session to the caller. Callable once.
    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(&mut self) -> Result<EngineSession, JsError> {
        self.session
            .take()
            .ok_or_else(|| JsError::new("session already taken"))
    }
}

#[wasm_bindgen]
pub struct EngineAccount {
    inner: Account,
}

#[wasm_bindgen]
impl EngineAccount {
    #[wasm_bindgen(constructor)]
    pub fn new() -> EngineAccount {
        EngineAccount { inner: Account::new() }
    }

    /// Restore an account from an encrypted pickle (decryption happens inside
    /// vodozemac; the pickle key is wiped from this crate's memory after use).
    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(encrypted_pickle: &str, pickle_key: &[u8]) -> Result<EngineAccount, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let result = AccountPickle::from_encrypted(encrypted_pickle, &key)
            .map(|p| EngineAccount { inner: Account::from_pickle(p) })
            .map_err(|_| JsError::new("failed to decrypt account pickle"));
        key.zeroize();
        result
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let pickled = self.inner.pickle().encrypt(&key);
        key.zeroize();
        Ok(pickled)
    }

    #[wasm_bindgen(js_name = curve25519Key)]
    pub fn curve25519_key(&self) -> String {
        self.inner.curve25519_key().to_base64()
    }

    #[wasm_bindgen(js_name = ed25519Key)]
    pub fn ed25519_key(&self) -> String {
        self.inner.ed25519_key().to_base64()
    }

    /// Sign a UTF-8 message with the account's Ed25519 key.
    pub fn sign(&self, message: &str) -> String {
        self.inner.sign(message.as_bytes()).to_base64()
    }

    #[wasm_bindgen(js_name = generateOneTimeKeys)]
    pub fn generate_one_time_keys(&mut self, count: u32) -> Result<JsValue, JsError> {
        self.inner.generate_one_time_keys(count as usize);
        self.unpublished_one_time_keys()
    }

    /// Unpublished one-time keys as [{ keyId, key }].
    #[wasm_bindgen(js_name = oneTimeKeys)]
    pub fn unpublished_one_time_keys(&self) -> Result<JsValue, JsError> {
        let keys: Vec<JsOneTimeKey> = self
            .inner
            .one_time_keys()
            .into_iter()
            .map(|(id, key)| JsOneTimeKey { key_id: id.to_base64(), key: key.to_base64() })
            .collect();
        serde_wasm_bindgen::to_value(&keys).map_err(|_| JsError::new("serialization failed"))
    }

    #[wasm_bindgen(js_name = markKeysAsPublished)]
    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
    }

    #[wasm_bindgen(js_name = generateFallbackKey)]
    pub fn generate_fallback_key(&mut self) {
        self.inner.generate_fallback_key();
    }

    /// Unpublished fallback key as { keyId, key } or null.
    #[wasm_bindgen(js_name = fallbackKey)]
    pub fn fallback_key(&self) -> Result<JsValue, JsError> {
        let key = self
            .inner
            .fallback_key()
            .into_iter()
            .next()
            .map(|(id, key)| JsOneTimeKey { key_id: id.to_base64(), key: key.to_base64() });
        serde_wasm_bindgen::to_value(&key).map_err(|_| JsError::new("serialization failed"))
    }

    #[wasm_bindgen(js_name = maxOneTimeKeys)]
    pub fn max_one_time_keys(&self) -> u32 {
        self.inner.max_number_of_one_time_keys() as u32
    }

    /// Establish an outbound session to a peer from their (already
    /// signature-verified) identity key and one-time/fallback key.
    #[wasm_bindgen(js_name = createOutboundSession)]
    pub fn create_outbound_session(
        &self,
        their_identity_key_b64: &str,
        their_one_time_key_b64: &str,
    ) -> Result<EngineSession, JsError> {
        let identity = curve_key(their_identity_key_b64)?;
        let one_time = curve_key(their_one_time_key_b64)?;
        let session = self
            .inner
            .create_outbound_session(SessionConfig::version_1(), identity, one_time)
            .map_err(|e| JsError::new(&format!("outbound session creation failed: {e}")))?;
        Ok(EngineSession { inner: session })
    }

    /// Device approval arriving as a PRE-KEY message (the usual case for a
    /// device that has never talked to its sibling): establishes the session and
    /// returns the master key without the secret ever reaching JS.
    #[wasm_bindgen(js_name = createInboundSessionForMasterSecret)]
    pub fn create_inbound_session_for_master_secret(
        &mut self,
        their_identity_key_b64: &str,
        prekey_body_b64: &str,
        expected_master_key: &str,
    ) -> Result<MasterInboundResult, JsError> {
        let identity = curve_key(their_identity_key_b64)?;
        let bytes = base64_decode(prekey_body_b64).map_err(|_| JsError::new("invalid base64 body"))?;
        let message = match OlmMessage::from_parts(0, &bytes)
            .map_err(|_| JsError::new("invalid pre-key message"))?
        {
            OlmMessage::PreKey(m) => m,
            OlmMessage::Normal(_) => return Err(JsError::new("not a pre-key message")),
        };
        let result = self
            .inner
            .create_inbound_session(SessionConfig::version_1(), identity, &message)
            .map_err(|e| JsError::new(&format!("inbound session creation failed: {e}")))?;
        let plaintext = String::from_utf8(result.plaintext)
            .map_err(|_| JsError::new("plaintext is not valid UTF-8"))?;
        let master = parse_master_transfer(plaintext, expected_master_key)?;
        Ok(MasterInboundResult {
            session: Some(EngineSession { inner: result.session }),
            master: Some(master),
        })
    }

    /// Establish an inbound session from a pre-key message. The expected
    /// identity key MUST be the peer's pinned/server-published key — vodozemac
    /// rejects the message if it was not created by that identity.
    #[wasm_bindgen(js_name = createInboundSession)]
    pub fn create_inbound_session(
        &mut self,
        their_identity_key_b64: &str,
        prekey_body_b64: &str,
    ) -> Result<InboundResult, JsError> {
        let identity = curve_key(their_identity_key_b64)?;
        let bytes = base64_decode(prekey_body_b64).map_err(|_| JsError::new("invalid base64 body"))?;
        let message = match OlmMessage::from_parts(0, &bytes)
            .map_err(|_| JsError::new("invalid pre-key message"))?
        {
            OlmMessage::PreKey(m) => m,
            OlmMessage::Normal(_) => return Err(JsError::new("not a pre-key message")),
        };
        let result = self
            .inner
            .create_inbound_session(SessionConfig::version_1(), identity, &message)
            .map_err(|e| JsError::new(&format!("inbound session creation failed: {e}")))?;
        let plaintext = String::from_utf8(result.plaintext)
            .map_err(|_| JsError::new("plaintext is not valid UTF-8"))?;
        Ok(InboundResult {
            session: Some(EngineSession { inner: result.session }),
            plaintext,
        })
    }
}

impl Default for EngineAccount {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct EngineSession {
    inner: Session,
}

#[wasm_bindgen]
impl EngineSession {
    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(encrypted_pickle: &str, pickle_key: &[u8]) -> Result<EngineSession, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let result = SessionPickle::from_encrypted(encrypted_pickle, &key)
            .map(|p| EngineSession { inner: Session::from_pickle(p) })
            .map_err(|_| JsError::new("failed to decrypt session pickle"));
        key.zeroize();
        result
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let pickled = self.inner.pickle().encrypt(&key);
        key.zeroize();
        Ok(pickled)
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    #[wasm_bindgen(js_name = hasReceivedMessage)]
    pub fn has_received_message(&self) -> bool {
        self.inner.has_received_message()
    }

    /// Encrypt UTF-8 plaintext. Returns { messageType, body } where body is
    /// unpadded base64 and messageType is 0 (pre-key) or 1 (normal).
    pub fn encrypt(&mut self, plaintext: &str) -> Result<JsValue, JsError> {
        let message = self
            .inner
            .encrypt(plaintext.as_bytes())
            .map_err(|e| JsError::new(&format!("encryption failed: {e}")))?;
        let (message_type, ciphertext) = message.to_parts();
        serde_wasm_bindgen::to_value(&JsEncrypted {
            message_type,
            body: base64_encode(ciphertext),
        })
        .map_err(|_| JsError::new("serialization failed"))
    }

    /// Encrypt this account's master secret to another of OUR devices (spec
    /// §14, device approval). The payload is assembled here so the private key
    /// never becomes a JS string; the caller only ever sees Olm ciphertext.
    #[wasm_bindgen(js_name = encryptMasterSecret)]
    pub fn encrypt_master_secret(&mut self, master: &EngineMasterKey) -> Result<JsValue, JsError> {
        let mut payload = format!(
            "{}{}|{}",
            MASTER_TRANSFER_PREFIX,
            master.secret_b64_internal(),
            master.public_key()
        );
        let encrypted = self
            .inner
            .encrypt(payload.as_bytes())
            .map_err(|e| JsError::new(&format!("encryption failed: {e}")));
        payload.zeroize();
        let (message_type, ciphertext) = encrypted?.to_parts();
        serde_wasm_bindgen::to_value(&JsEncrypted {
            message_type,
            body: base64_encode(ciphertext),
        })
        .map_err(|_| JsError::new("serialization failed"))
    }

    /// Decrypt a device-approval payload into a usable master key. The expected
    /// public key is checked HERE, so JS cannot skip the check, and the private
    /// half is never exposed to it.
    #[wasm_bindgen(js_name = decryptMasterSecret)]
    pub fn decrypt_master_secret(
        &mut self,
        message_type: usize,
        body_b64: &str,
        expected_master_key: &str,
    ) -> Result<EngineMasterKey, JsError> {
        let plaintext = self.decrypt(message_type, body_b64)?;
        parse_master_transfer(plaintext, expected_master_key)
    }

    /// Decrypt a message previously produced by the peer's session.
    pub fn decrypt(&mut self, message_type: usize, body_b64: &str) -> Result<String, JsError> {
        let bytes = base64_decode(body_b64).map_err(|_| JsError::new("invalid base64 body"))?;
        let message = OlmMessage::from_parts(message_type, &bytes)
            .map_err(|_| JsError::new("invalid message encoding"))?;
        let plaintext = self
            .inner
            .decrypt(&message)
            .map_err(|e| JsError::new(&format!("decryption failed: {e}")))?;
        String::from_utf8(plaintext).map_err(|_| JsError::new("plaintext is not valid UTF-8"))
    }
}

// ─── Megolm group sessions ("megolm1", spec §12) ─────────────────────────────
// One outbound GroupSession per conversation encrypts every message once; the
// session key is fanned out to each peer device over the pairwise Olm channel
// (never to the server). Recipients rebuild an InboundGroupSession from that
// key. Same rule as above: this is marshalling only — the ratchet, the MAC and
// the Ed25519 signature all live inside vodozemac.

/// Result of a Megolm decryption: the plaintext and the ratchet index the
/// message was encrypted at (callers use the index for replay detection).
#[wasm_bindgen]
pub struct GroupDecryptResult {
    plaintext: String,
    message_index: u32,
}

#[wasm_bindgen]
impl GroupDecryptResult {
    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> String {
        self.plaintext.clone()
    }

    #[wasm_bindgen(getter, js_name = messageIndex)]
    pub fn message_index(&self) -> u32 {
        self.message_index
    }
}

/// Outbound Megolm group session — the sending half. Owns the signing key, so
/// its pickle is secret material and never leaves the vault.
#[wasm_bindgen]
pub struct EngineGroupSession {
    inner: GroupSession,
}

#[wasm_bindgen]
impl EngineGroupSession {
    /// Create a fresh outbound group session. Megolm session config is pinned
    /// to version 1 (the interoperable, non-experimental variant).
    #[wasm_bindgen(constructor)]
    pub fn new() -> EngineGroupSession {
        EngineGroupSession { inner: GroupSession::new(MegolmSessionConfig::version_1()) }
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(
        encrypted_pickle: &str,
        pickle_key: &[u8],
    ) -> Result<EngineGroupSession, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let result = GroupSessionPickle::from_encrypted(encrypted_pickle, &key)
            .map(|p| EngineGroupSession { inner: GroupSession::from_pickle(p) })
            .map_err(|_| JsError::new("failed to decrypt group session pickle"));
        key.zeroize();
        result
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let pickled = self.inner.pickle().encrypt(&key);
        key.zeroize();
        Ok(pickled)
    }

    /// Globally unique session id (base64 of the session's Ed25519 public key).
    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Export the session key at the CURRENT ratchet index, base64-encoded.
    /// This is the secret shared with recipient devices (and with our own
    /// device, so the sender can decrypt its own history). Recipients can only
    /// decrypt messages from this index onwards.
    #[wasm_bindgen(js_name = sessionKey)]
    pub fn session_key(&self) -> String {
        self.inner.session_key().to_base64()
    }

    /// Number of messages already encrypted (== the index the next message
    /// will use).
    #[wasm_bindgen(js_name = messageIndex)]
    pub fn message_index(&self) -> u32 {
        self.inner.message_index()
    }

    /// Encrypt UTF-8 plaintext. Returns the unpadded-base64 MegolmMessage.
    pub fn encrypt(&mut self, plaintext: &str) -> String {
        self.inner.encrypt(plaintext.as_bytes()).to_base64()
    }
}

impl Default for EngineGroupSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Inbound Megolm group session — the receiving half, rebuilt from a session
/// key that arrived over the authenticated pairwise Olm channel.
#[wasm_bindgen]
pub struct EngineInboundGroupSession {
    inner: InboundGroupSession,
}

#[wasm_bindgen]
impl EngineInboundGroupSession {
    /// Build an inbound session from a base64 session key produced by
    /// `EngineGroupSession.sessionKey()`.
    #[wasm_bindgen(js_name = fromSessionKey)]
    pub fn from_session_key(session_key_b64: &str) -> Result<EngineInboundGroupSession, JsError> {
        let key = SessionKey::from_base64(session_key_b64)
            .map_err(|_| JsError::new("invalid megolm session key"))?;
        Ok(EngineInboundGroupSession {
            inner: InboundGroupSession::new(&key, MegolmSessionConfig::version_1()),
        })
    }

    /// Build an inbound session from an EXPORTED session key (as produced by
    /// `exportAtFirstKnownIndex`). Used when a key share is re-sent from an
    /// already-imported session, so the sender never has to keep raw key
    /// material outside an encrypted pickle (spec §12.4).
    #[wasm_bindgen(js_name = fromExportedSessionKey)]
    pub fn from_exported_session_key(
        exported_key_b64: &str,
    ) -> Result<EngineInboundGroupSession, JsError> {
        let key = ExportedSessionKey::from_base64(exported_key_b64)
            .map_err(|_| JsError::new("invalid exported megolm session key"))?;
        Ok(EngineInboundGroupSession {
            inner: InboundGroupSession::import(&key, MegolmSessionConfig::version_1()),
        })
    }

    /// Export this session's key at its earliest known ratchet index, so a
    /// recipient that missed the original share can still read the whole
    /// session. The session id is preserved (it is derived from the signing
    /// key, which the exported key carries).
    #[wasm_bindgen(js_name = exportAtFirstKnownIndex)]
    pub fn export_at_first_known_index(&self) -> String {
        self.inner.export_at_first_known_index().to_base64()
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(
        encrypted_pickle: &str,
        pickle_key: &[u8],
    ) -> Result<EngineInboundGroupSession, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let result = InboundGroupSessionPickle::from_encrypted(encrypted_pickle, &key)
            .map(|p| EngineInboundGroupSession { inner: InboundGroupSession::from_pickle(p) })
            .map_err(|_| JsError::new("failed to decrypt inbound group session pickle"));
        key.zeroize();
        result
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsError> {
        let mut key = pickle_key_from_js(pickle_key)?;
        let pickled = self.inner.pickle().encrypt(&key);
        key.zeroize();
        Ok(pickled)
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Lowest ratchet index this session can decrypt. Messages sent before the
    /// key was exported are permanently unreadable by this importer.
    #[wasm_bindgen(js_name = firstKnownIndex)]
    pub fn first_known_index(&self) -> u32 {
        self.inner.first_known_index()
    }

    /// Decrypt an unpadded-base64 MegolmMessage.
    pub fn decrypt(&mut self, ciphertext_b64: &str) -> Result<GroupDecryptResult, JsError> {
        let message = MegolmMessage::from_base64(ciphertext_b64)
            .map_err(|_| JsError::new("invalid megolm message encoding"))?;
        let decrypted = self
            .inner
            .decrypt(&message)
            .map_err(|e| JsError::new(&format!("group decryption failed: {e}")))?;
        let plaintext = String::from_utf8(decrypted.plaintext)
            .map_err(|_| JsError::new("plaintext is not valid UTF-8"))?;
        Ok(GroupDecryptResult { plaintext, message_index: decrypted.message_index })
    }
}
