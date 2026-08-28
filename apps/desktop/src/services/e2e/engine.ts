// Loader for the E2E crypto engine (docs/e2e-dm-spec.md §3). All protocol
// crypto executes inside the vodozemac WASM module; this file only initializes
// it and re-exports the marshalling API.
import init, {
  EngineAccount,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  EngineMasterKey,
  MasterInboundResult,
  GroupDecryptResult,
  engine_version,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
  master_safety_number,
  sealSecret,
  openSecret,
  generateRecoveryKey,
  linkingCode,
  isRecoveryKeyWellFormed,
  openMasterKeyBackup,
  encryptAttachment,
  decryptAttachment,
} from '@voxium/crypto-engine';
// Vite serves the wasm binary as a static asset URL (CSP already allows
// 'wasm-unsafe-eval' in the Tauri webview)
import wasmUrl from '@voxium/crypto-engine/wasm?url';

let initPromise: Promise<void> | null = null;

/**
 * Idempotent engine initialization. Tests (node environment) pass the wasm
 * bytes directly; the app resolves the Vite asset URL.
 */
export function initEngine(wasmInput?: BufferSource): Promise<void> {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmInput ?? wasmUrl })
      .then(() => undefined)
      .catch((err) => {
        initPromise = null; // allow retry after a transient load failure
        throw err;
      });
  }
  return initPromise;
}

export {
  EngineAccount,
  EngineSession,
  EngineGroupSession,
  EngineInboundGroupSession,
  EngineMasterKey,
  MasterInboundResult,
  GroupDecryptResult,
  engine_version,
  verify_ed25519,
  prekey_message_session_id,
  safety_number,
  master_safety_number,
  sealSecret,
  openSecret,
  generateRecoveryKey,
  linkingCode,
  isRecoveryKeyWellFormed,
  openMasterKeyBackup,
  encryptAttachment,
  decryptAttachment,
};
