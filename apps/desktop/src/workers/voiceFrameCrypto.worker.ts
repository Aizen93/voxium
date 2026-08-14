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

function decryptTransform(senderUserId: string): TransformStream<EncodedFrame, EncodedFrame> {
  const receiver = requireReceiver(senderUserId);
  return new TransformStream({
    async transform(frame, controller) {
      const out = await receiver.decrypt(frame.data);
      if (out === null) return; // droppable — never surface ciphertext as audio
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

self.addEventListener('message', (event: MessageEvent<InboundMsg>) => {
  const msg = event.data;
  void (async () => {
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
        break;
      case 'removeSender':
        receivers.delete(msg.senderUserId);
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
  })().catch((err) => {
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
