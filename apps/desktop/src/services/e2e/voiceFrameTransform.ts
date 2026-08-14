// Main-thread side of the secure-voice frame crypto (docs/e2e-dm-spec.md §21):
// feature detection and the per-session worker handle that installs encoded
// transforms on mediasoup's RTCRtpSender/RTCRtpReceiver pairs.
//
// Key material flows main thread → worker as raw bytes; the worker never sees
// Olm state and the main thread never sees frames.
import type { WorkerDiagnostics } from '../../workers/voiceFrameCrypto.worker';

// Non-standard APIs used by the two attachment paths. `transform` already
// exists on newer lib.dom typings; createEncodedStreams is the legacy
// Chromium API and is typed here as an optional extension.
type EncodedStreamsPair = { readable: ReadableStream; writable: WritableStream };
type RtpSenderWithStreams = RTCRtpSender & { createEncodedStreams?: () => EncodedStreamsPair };
type RtpReceiverWithStreams = RTCRtpReceiver & { createEncodedStreams?: () => EncodedStreamsPair };
declare global {
  interface Window {
    RTCRtpScriptTransform?: new (worker: Worker, options: Record<string, unknown>) => unknown;
  }
}

/**
 * Whether this runtime can run E2E voice at all. Hard requirement: without an
 * encoded-frame transform there is no way to encrypt OR decrypt, so secure
 * voice channels are simply unjoinable (no plaintext fallback, ever).
 */
export function isSecureVoiceSupported(): boolean {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return false;
  if (typeof window.RTCRtpScriptTransform === 'function') return true;
  return typeof RTCRtpSender !== 'undefined'
    && typeof (RTCRtpSender.prototype as RtpSenderWithStreams).createEncodedStreams === 'function';
}

export interface FrameCryptoSession {
  /** Install the encrypt transform on the mic producer's sender. Throws on failure — caller must abort the session. */
  attachSender(sender: RTCRtpSender): void;
  /** Install the decrypt transform for one remote participant's consumer. */
  attachReceiver(receiver: RTCRtpReceiver, senderUserId: string): void;
  setLocalKey(keyId: number, raw: Uint8Array): void;
  setRemoteKey(senderUserId: string, keyId: number, raw: Uint8Array): void;
  removeRemote(senderUserId: string): void;
  /** Fires when the sender counter approaches the ceiling — rotate. */
  onCounterLow(cb: () => void): void;
  /** Fires on any worker/pipe failure — the session must fail closed. */
  onFatal(cb: (message: string) => void): void;
  getDiagnostics(): Promise<WorkerDiagnostics>;
  destroy(): void;
}

export function createFrameCryptoSession(channelId: string, selfUserId: string): FrameCryptoSession {
  // Same-origin bundled worker (Vite `new URL` pattern) — satisfies the Tauri
  // CSP, which has no worker-src carve-out for blob: workers.
  const worker = new Worker(new URL('../../workers/voiceFrameCrypto.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.postMessage({ op: 'init', channelId, selfUserId });

  let counterLowCb: (() => void) | null = null;
  let fatalCb: ((message: string) => void) | null = null;
  let nextRequestId = 1;
  const statsWaiters = new Map<number, (d: WorkerDiagnostics) => void>();
  let destroyed = false;

  worker.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as { op?: string; requestId?: number; diagnostics?: WorkerDiagnostics; message?: string };
    if (msg.op === 'counterLow') counterLowCb?.();
    else if (msg.op === 'stats' && typeof msg.requestId === 'number') {
      statsWaiters.get(msg.requestId)?.(msg.diagnostics!);
      statsWaiters.delete(msg.requestId);
    } else if (msg.op === 'pipeError' || msg.op === 'workerError') {
      console.error(`[SecureVoice] Frame-crypto worker failure (${msg.op}):`, msg.message);
      fatalCb?.(msg.message ?? 'worker failure');
    }
  });
  worker.addEventListener('error', (event) => {
    console.error('[SecureVoice] Frame-crypto worker error:', event.message);
    fatalCb?.(event.message || 'worker error');
  });

  function attach(role: 'encrypt' | 'decrypt', target: RtpSenderWithStreams | RtpReceiverWithStreams, senderUserId?: string): void {
    if (destroyed) throw new Error('frame-crypto session destroyed');
    if (typeof window.RTCRtpScriptTransform === 'function') {
      (target as { transform: unknown }).transform = new window.RTCRtpScriptTransform(worker, { role, senderUserId });
      return;
    }
    if (typeof target.createEncodedStreams === 'function') {
      // Legacy Chromium path — requires encodedInsertableStreams: true on the
      // RTCPeerConnection (mediasoup transport additionalSettings).
      const { readable, writable } = target.createEncodedStreams();
      worker.postMessage(
        role === 'encrypt'
          ? { op: 'attachEncrypt', readable, writable }
          : { op: 'attachDecrypt', senderUserId, readable, writable },
        [readable as unknown as Transferable, writable as unknown as Transferable],
      );
      return;
    }
    throw new Error('no encoded-transform API available');
  }

  return {
    attachSender(sender) { attach('encrypt', sender as RtpSenderWithStreams); },
    attachReceiver(receiver, senderUserId) { attach('decrypt', receiver as RtpReceiverWithStreams, senderUserId); },
    setLocalKey(keyId, raw) { worker.postMessage({ op: 'setSenderKey', keyId, raw }); },
    setRemoteKey(senderUserId, keyId, raw) { worker.postMessage({ op: 'setRecvKey', senderUserId, keyId, raw }); },
    removeRemote(senderUserId) { worker.postMessage({ op: 'removeSender', senderUserId }); },
    onCounterLow(cb) { counterLowCb = cb; },
    onFatal(cb) { fatalCb = cb; },
    getDiagnostics() {
      return new Promise<WorkerDiagnostics>((resolve, reject) => {
        if (destroyed) { reject(new Error('destroyed')); return; }
        const requestId = nextRequestId++;
        statsWaiters.set(requestId, resolve);
        worker.postMessage({ op: 'stats', requestId });
        setTimeout(() => {
          if (statsWaiters.delete(requestId)) reject(new Error('stats timeout'));
        }, 2_000);
      });
    },
    destroy() {
      destroyed = true;
      statsWaiters.clear();
      worker.terminate();
    },
  };
}
