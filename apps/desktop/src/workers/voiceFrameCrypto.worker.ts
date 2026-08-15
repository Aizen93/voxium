/// <reference lib="webworker" />
// Frame-crypto worker for secure voice channels (docs/e2e-dm-spec.md §21).
//
// A thin shell over the pure cipher core: encoded audio frames stream through
// TransformStreams here, off the main thread. Two attachment paths:
//  - RTCRtpScriptTransform: the 'rtctransform' event delivers
//    {readable, writable, options} directly in the worker (Chromium + WebKit).
//  - Legacy insertable streams: the main thread calls createEncodedStreams()
//    and TRANSFERS the {readable, writable} pair here via postMessage.
//
// The worker only ever holds RAW media keys posted from the main thread —
// no Olm state, no identity material, no network access.
import {
  createSenderCipher,
  createReceiverCipher,
  type SenderCipher,
  type ReceiverCipher,
  type ReceiverStats,
} from '../services/e2e/voiceFrameCipher';

type InitMsg = { op: 'init'; channelId: string; selfUserId: string };
type SetSenderKeyMsg = { op: 'setSenderKey'; keyId: number; raw: Uint8Array };
type SetRecvKeyMsg = { op: 'setRecvKey'; senderUserId: string; keyId: number; raw: Uint8Array };
type RemoveSenderMsg = { op: 'removeSender'; senderUserId: string };
type AttachEncryptMsg = { op: 'attachEncrypt'; readable: ReadableStream; writable: WritableStream };
type AttachDecryptMsg = { op: 'attachDecrypt'; senderUserId: string; readable: ReadableStream; writable: WritableStream };
type StatsMsg = { op: 'stats'; requestId: number };
type InboundMsg =
  | InitMsg | SetSenderKeyMsg | SetRecvKeyMsg | RemoveSenderMsg
  | AttachEncryptMsg | AttachDecryptMsg | StatsMsg;

export type WorkerDiagnostics = {
  encrypted: number;
  encryptDropped: number;
  receivers: Record<string, ReceiverStats>;
};

let channelId: string | null = null;
let selfUserId: string | null = null;
let sender: SenderCipher | null = null;
const receivers = new Map<string, ReceiverCipher>();
let encrypted = 0;
let encryptDropped = 0;

/** Frames whose sender counter is spent trigger exactly one rotation ask. */
let counterLowSignaled = false;
const COUNTER_LOW_MARGIN = 1_000_000;

function requireReceiver(senderUserId: string): ReceiverCipher {
  let r = receivers.get(senderUserId);
  if (!r) {
    r = createReceiverCipher(channelId!, senderUserId);
    receivers.set(senderUserId, r);
  }
  return r;
}

// RTCEncodedAudioFrame in lib.dom is minimal; data is a settable ArrayBuffer.
interface EncodedFrame { data: ArrayBuffer }

function encryptTransform(): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream({
    async transform(frame, controller) {
      if (!sender) { encryptDropped++; return; } // no key ⇒ no plaintext leaves
      const out = await sender.encrypt(frame.data);
      if (out === null) { encryptDropped++; return; }
      encrypted++;
      if (!counterLowSignaled && sender.framesRemaining() < COUNTER_LOW_MARGIN) {
        counterLowSignaled = true;
        self.postMessage({ op: 'counterLow' });
      }
      frame.data = out;
      controller.enqueue(frame);
    },
  });
}

/**
 * Decrypt watchdog (spec §21.4): a sender whose frames keep failing is one
 * whose key we never received — a lost seal, a dropped envelope, a full pending
 * buffer. Nothing else notices, because a missing key is indistinguishable from
 * silence at the audio layer. After a run of consecutive failures we ask the
 * main thread to request a re-seal, and re-arm only once a frame decrypts, so a
 * still-broken sender re-asks on the next run instead of spinning.
 */
const DECRYPT_FAIL_RUN = 50; // ~1s of 20ms Opus frames
const failRuns = new Map<string, number>();

function decryptTransform(senderUserId: string): TransformStream<EncodedFrame, EncodedFrame> {
  const receiver = requireReceiver(senderUserId);
  return new TransformStream({
    async transform(frame, controller) {
      const out = await receiver.decrypt(frame.data);
      if (out === null) {
        const run = (failRuns.get(senderUserId) ?? 0) + 1;
        failRuns.set(senderUserId, run);
        if (run === DECRYPT_FAIL_RUN) self.postMessage({ op: 'decryptStalled', senderUserId });
        return; // droppable — never surface ciphertext as audio
      }
      if (failRuns.get(senderUserId)) {
        failRuns.set(senderUserId, 0);
        self.postMessage({ op: 'decryptRecovered', senderUserId });
      }
      frame.data = out;
      controller.enqueue(frame);
    },
  });
}

function pipe(readable: ReadableStream, writable: WritableStream, transform: TransformStream<EncodedFrame, EncodedFrame>): void {
  readable
    .pipeThrough(transform as TransformStream)
    .pipeTo(writable)
    .catch((err) => {
      // Stream teardown on producer/consumer close is expected; anything else
      // is surfaced so the main thread can fail the session closed.
      self.postMessage({ op: 'pipeError', message: String(err) });
    });
}

// Ops are serialized: postMessage delivers in FIFO order, but the async work
// inside (WebCrypto importKey) resolves in ANY order, so two overlapping
// setSenderKey messages could land the OLDER generation last — the sender would
// then encrypt under a key the main thread believes was superseded and never
// sealed to anyone. The chain makes completion order match arrival order.
let opChain: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<InboundMsg>) => {
  const msg = event.data;
  opChain = opChain.then(async () => {
    switch (msg.op) {
      case 'init':
        channelId = msg.channelId;
        selfUserId = msg.selfUserId;
        sender = createSenderCipher(channelId, selfUserId);
        break;
      case 'setSenderKey':
        if (!sender) break;
        await sender.setKey(msg.keyId, msg.raw);
        counterLowSignaled = false;
        break;
      case 'setRecvKey':
        await requireReceiver(msg.senderUserId).setKey(msg.keyId, msg.raw);
        // A fresh key restarts the watchdog run, so if it still does not
        // decrypt the next failure run asks again instead of staying silent.
        failRuns.set(msg.senderUserId, 0);
        break;
      case 'removeSender':
        receivers.delete(msg.senderUserId);
        failRuns.delete(msg.senderUserId);
        break;
      case 'attachEncrypt':
        pipe(msg.readable, msg.writable, encryptTransform());
        break;
      case 'attachDecrypt':
        pipe(msg.readable, msg.writable, decryptTransform(msg.senderUserId));
        break;
      case 'stats': {
        const receiverStats: Record<string, ReceiverStats> = {};
        for (const [uid, r] of receivers) receiverStats[uid] = r.stats();
        const diagnostics: WorkerDiagnostics = { encrypted, encryptDropped, receivers: receiverStats };
        self.postMessage({ op: 'stats', requestId: msg.requestId, diagnostics });
        break;
      }
    }
  }).catch((err) => {
    self.postMessage({ op: 'workerError', message: String(err) });
  });
});

// RTCRtpScriptTransform path: the transform event carries the streams plus the
// options passed at construction on the main thread.
interface RtcTransformEvent extends Event {
  transformer: {
    readable: ReadableStream;
    writable: WritableStream;
    options: { role: 'encrypt' | 'decrypt'; senderUserId?: string };
  };
}
self.addEventListener('rtctransform', (event) => {
  const { transformer } = event as RtcTransformEvent;
  const { role, senderUserId } = transformer.options ?? {};
  if (role === 'encrypt') {
    pipe(transformer.readable, transformer.writable, encryptTransform());
  } else if (role === 'decrypt' && typeof senderUserId === 'string') {
    pipe(transformer.readable, transformer.writable, decryptTransform(senderUserId));
  }
});
