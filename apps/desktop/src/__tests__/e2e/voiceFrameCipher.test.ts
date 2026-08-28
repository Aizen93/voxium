// @vitest-environment node
// Pure WebCrypto — node env gives us the real crypto.subtle without jsdom.
import { describe, it, expect } from 'vitest';
import {
  createSenderCipher,
  createReceiverCipher,
  ratchetVoiceKey,
} from '../../services/e2e/voiceFrameCipher';
import { VOICE_FRAME_HEADER_BYTES, VOICE_FRAME_SEQ_ROTATE_AT } from '@voxium/shared';

// The frame cipher is the E2E boundary for secure voice: everything the SFU
// forwards passes through encrypt(); everything a member hears passes through
// decrypt(). What must hold: authenticated round-trips, binding to channel +
// sender + generation + seq via the AAD, replay resistance, and the
// tag-verified trial-ratchet that makes member arrivals gapless.

const CH = 'chan-1';
const ME = 'user-a';

function randomKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

function frame(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function pair(key = randomKey()) {
  const sender = createSenderCipher(CH, ME);
  const receiver = createReceiverCipher(CH, ME);
  await sender.setKey(0, key);
  await receiver.setKey(0, key);
  return { sender, receiver, key };
}

describe('voiceFrameCipher — round trips', () => {
  it('encrypts and decrypts frames, including empty DTX frames', async () => {
    const { sender, receiver } = await pair();

    for (const payload of [[1, 2, 3, 4, 5], [], [0], Array.from({ length: 400 }, (_, i) => i % 256)]) {
      const ct = await sender.encrypt(frame(payload));
      expect(ct).not.toBeNull();
      expect(ct!.byteLength).toBeGreaterThan(payload.length); // header + tag overhead
      const pt = await receiver.decrypt(ct!);
      expect(pt).not.toBeNull();
      expect([...new Uint8Array(pt!)]).toEqual(payload);
    }
    expect(receiver.stats().ok).toBe(4);
  });

  it('refuses to pass anything through without a key (no plaintext fallback)', async () => {
    const sender = createSenderCipher(CH, ME);
    expect(await sender.encrypt(frame([1, 2, 3]))).toBeNull();
  });

  it('drops tampered ciphertext, tampered headers, and short frames', async () => {
    const { sender, receiver } = await pair();
    const ct = new Uint8Array((await sender.encrypt(frame([9, 9, 9])))!);

    const flippedBody = ct.slice(); flippedBody[VOICE_FRAME_HEADER_BYTES] ^= 0x01;
    expect(await receiver.decrypt(flippedBody.buffer)).toBeNull();

    const flippedSeq = new Uint8Array((await sender.encrypt(frame([9])))!.slice(0));
    flippedSeq[2] ^= 0x01; // header seq is AAD-bound — the tag must fail
    expect(await receiver.decrypt(flippedSeq.buffer)).toBeNull();

    expect(await receiver.decrypt(frame([1, 2, 3]))).toBeNull(); // below minimum
    expect(receiver.stats().malformed).toBe(1);
  });
});

describe('voiceFrameCipher — AAD binding', () => {
  it('a frame from one channel never decrypts in another (same key!)', async () => {
    const key = randomKey();
    const sender = createSenderCipher('chan-A', ME);
    await sender.setKey(0, key);
    const wrongChannel = createReceiverCipher('chan-B', ME);
    await wrongChannel.setKey(0, key);

    const ct = await sender.encrypt(frame([1, 2, 3]));
    expect(await wrongChannel.decrypt(ct!)).toBeNull();
  });

  it('a frame attributed to the wrong SENDER never decrypts (same key!)', async () => {
    const key = randomKey();
    const sender = createSenderCipher(CH, 'user-a');
    await sender.setKey(0, key);
    const wrongSender = createReceiverCipher(CH, 'user-b');
    await wrongSender.setKey(0, key);

    const ct = await sender.encrypt(frame([1, 2, 3]));
    expect(await wrongSender.decrypt(ct!)).toBeNull();
  });
});

describe('voiceFrameCipher — replay window', () => {
  it('drops exact replays and pre-window stragglers, allows in-window reorder', async () => {
    const { sender, receiver } = await pair();

    const frames: ArrayBuffer[] = [];
    for (let i = 0; i < 5; i++) frames.push((await sender.encrypt(frame([i])))!);

    // Deliver out of order: 0, 2, 1 — reorder within the window is fine
    expect(await receiver.decrypt(frames[0])).not.toBeNull();
    expect(await receiver.decrypt(frames[2])).not.toBeNull();
    expect(await receiver.decrypt(frames[1])).not.toBeNull();

    // Exact replays die
    expect(await receiver.decrypt(frames[2])).toBeNull();
    expect(await receiver.decrypt(frames[0])).toBeNull();
    expect(receiver.stats().replayed).toBe(2);
  });

  it('RE-INSTALLING the same generation keeps the window (key_request re-seal)', async () => {
    const { sender, receiver, key } = await pair();

    const frames: ArrayBuffer[] = [];
    for (let i = 0; i < 3; i++) frames.push((await sender.encrypt(frame([i])))!);
    for (const f of frames) expect(await receiver.decrypt(f)).not.toBeNull();

    // The same key generation is delivered again — a re-seal answering a
    // key_request, or a duplicated envelope. If this reset the window, the SFU
    // could re-inject everything it already forwarded under this key: the tags
    // and AAD are still valid, so it would play as live audio.
    await receiver.setKey(0, key);

    for (const f of frames) expect(await receiver.decrypt(f)).toBeNull();
    expect(receiver.stats().replayed).toBe(3);
  });

  it('a DIFFERENT key under the same keyId still installs (peer restarted)', async () => {
    const { receiver } = await pair();
    const other = randomKey();
    await receiver.setKey(0, other);

    const restarted = createSenderCipher(CH, ME);
    await restarted.setKey(0, other);
    expect(await receiver.decrypt((await restarted.encrypt(frame([9])))!)).not.toBeNull();
  });
});

describe('voiceFrameCipher — trial ratchet (member arrival, spec §21)', () => {
  it('a keyId+1 frame under the RATCHETED key installs gaplessly', async () => {
    const { sender, receiver, key } = await pair();
    expect(await receiver.decrypt((await sender.encrypt(frame([1])))!)).not.toBeNull();

    // Sender ratchets for an arrival; receiver has NOT been told
    const next = await ratchetVoiceKey(key);
    await sender.setKey(1, next);

    const ct = await sender.encrypt(frame([42]));
    const pt = await receiver.decrypt(ct!);
    expect(pt).not.toBeNull();
    expect([...new Uint8Array(pt!)]).toEqual([42]);
    expect(receiver.stats().ratcheted).toBe(1);

    // And the installed key keeps working for subsequent frames
    expect(await receiver.decrypt((await sender.encrypt(frame([43])))!)).not.toBeNull();
  });

  it('a keyId+1 frame under a FRESH key is dropped (await the sealed key)', async () => {
    const { sender, receiver } = await pair();
    await sender.setKey(1, randomKey()); // fresh rotation — NOT the ratchet

    const ct = await sender.encrypt(frame([7]));
    expect(await receiver.decrypt(ct!)).toBeNull();
    expect(receiver.stats().ratcheted).toBe(0);

    // Once the sealed key arrives, decryption resumes
    // (the fresh key reaches the receiver via secureVoiceKeys → setKey)
  });

  it('rotation races: the previous generation stays decryptable from the ring', async () => {
    const key0 = randomKey();
    const { sender, receiver } = await pair(key0);

    const late = await sender.encrypt(frame([1])); // sealed under key 0

    const key1 = randomKey();
    await sender.setKey(1, key1);
    await receiver.setKey(1, key1);
    expect(await receiver.decrypt((await sender.encrypt(frame([2])))!)).not.toBeNull();

    // The straggler from generation 0 still lands
    expect(await receiver.decrypt(late!)).not.toBeNull();
  });
});

describe('voiceFrameCipher — counter exhaustion (IV-reuse firewall)', () => {
  it('refuses to encrypt past the rotation ceiling', async () => {
    const sender = createSenderCipher(CH, ME, { initialSeqForTest: VOICE_FRAME_SEQ_ROTATE_AT - 2 });
    await sender.setKey(0, randomKey());

    expect(await sender.encrypt(frame([1]))).not.toBeNull();
    expect(await sender.encrypt(frame([2]))).not.toBeNull();
    // Ceiling reached — the cipher goes silent rather than ever reusing an IV
    expect(await sender.encrypt(frame([3]))).toBeNull();
    expect(sender.framesRemaining()).toBe(0);
  });
});
