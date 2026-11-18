// @vitest-environment node
// Real WebCrypto (node's crypto.subtle) under the cipher, and the construction
// the spec writes out stated a second time, by hand, over node:crypto (the same
// primitives underneath: what is independent is the IV, AAD and ratchet
// parameters, written out here rather than taken from the cipher).
import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import {
  createSenderCipher,
  createReceiverCipher,
  ratchetVoiceKey,
} from '../../services/e2e/voiceFrameCipher';
import { VOICE_FRAME_SEQ_ROTATE_AT, voiceFrameAadPrefix } from '@voxium/shared';

// The secure-voice frame cipher is the one cryptographic construction the
// client runs in JavaScript (docs/e2e-dm-spec.md §3). These tests hold the
// invariants §21.2 states for it: the IV and the ratchet are exactly the ones
// written there, no IV repeats under one key (through the counter's whole
// range, concurrent frames and key changes included), no (key, IV) pair recurs
// across rotations or a session restart, the replay window's edges, the trial
// ratchet's bounds, and that every byte of a frame is authenticated.

const CH = 'chan-1';
const ME = 'user-a';

// The frame layout of §21.2, written out here rather than imported from the
// shared constants the cipher reads, so a change to those fails this file.
const SPEC_VERSION = 1;
const SPEC_HEADER_BYTES = 5;
const SPEC_TAG_BYTES = 16;

function randomKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

function hex(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('hex');
}

function frame(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function copyOf(sealed: ArrayBuffer): Uint8Array {
  return new Uint8Array(sealed.slice(0));
}

/** The header of a sealed frame, read as §21.2 lays it out. */
function header(sealed: ArrayBuffer): { version: number; nibble: number; seq: number } {
  const view = new DataView(sealed);
  const first = view.getUint8(0);
  return { version: first >> 4, nibble: first & 0x0f, seq: view.getUint32(1, false) };
}

/** The IV §21.2 specifies, written out by hand: seq (4 bytes, big-endian) ‖ keyId mod 256 ‖ 0×7. */
function specIv(keyId: number, seq: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(seq, 0);
  iv[4] = keyId & 0xff;
  return iv;
}

/** The AAD §21.2 specifies: UTF-8 "voxv1|chv:{channelId}|{senderUserId}" ‖ the 5-byte header. */
function specAad(channelId: string, senderUserId: string, head: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`voxv1|chv:${channelId}|${senderUserId}`, 'utf8'), Buffer.from(head)]);
}

/** Open a frame with node:crypto, from the spec's construction alone. Throws when the tag fails. */
function openWithNode(sealed: ArrayBuffer, key: Uint8Array, keyId: number): number[] {
  const bytes = Buffer.from(new Uint8Array(sealed));
  const head = bytes.subarray(0, SPEC_HEADER_BYTES);
  const body = bytes.subarray(SPEC_HEADER_BYTES, bytes.length - SPEC_TAG_BYTES);
  const tag = bytes.subarray(bytes.length - SPEC_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, specIv(keyId, head.readUInt32BE(1)));
  decipher.setAAD(specAad(CH, ME, head));
  decipher.setAuthTag(tag);
  return [...Buffer.concat([decipher.update(body), decipher.final()])];
}

/** Seal a frame with node:crypto, from the spec's construction alone. */
function sealWithNode(payload: number[], key: Uint8Array, keyId: number, seq: number): ArrayBuffer {
  const head = Buffer.alloc(SPEC_HEADER_BYTES);
  head[0] = (SPEC_VERSION << 4) | (keyId & 0x0f);
  head.writeUInt32BE(seq, 1);
  const cipher = createCipheriv('aes-256-gcm', key, specIv(keyId, seq));
  cipher.setAAD(specAad(CH, ME, head));
  const out = Buffer.concat([head, cipher.update(Buffer.from(payload)), cipher.final(), cipher.getAuthTag()]);
  // A small Buffer is a view into a shared pool: hand over exactly its bytes
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function sender(keyId: number, key: Uint8Array) {
  const s = createSenderCipher(CH, ME);
  await s.setKey(keyId, key);
  return s;
}

async function receiver(keyId: number, key: Uint8Array) {
  const r = createReceiverCipher(CH, ME);
  await r.setKey(keyId, key);
  return r;
}

/** n frames sealed under one key (seq 0 … n-1), none delivered yet, and a receiver holding the key. */
async function sealedRun(n: number, keyId = 0) {
  const key = randomKey();
  const s = await sender(keyId, key);
  const frames: ArrayBuffer[] = [];
  for (let i = 0; i < n; i++) frames.push((await s.encrypt(frame([i & 0xff])))!);
  return { key, sender: s, receiver: await receiver(keyId, key), frames };
}

describe('the construction, against §21.2 written out again over node:crypto', () => {
  it('the ratchet is HKDF-SHA256 with the salt and info §21.2 names, 32 bytes out', async () => {
    for (let i = 0; i < 8; i++) {
      const key = randomKey();
      const expected = hkdfSync('sha256', key, Buffer.from('voxium-voice-ratchet'), Buffer.from('voxv1-sender-key'), 32);
      expect(hex(await ratchetVoiceKey(key))).toBe(hex(expected));
    }
  });

  it('the AAD prefix is the string §21.2 names', () => {
    expect(voiceFrameAadPrefix(CH, ME)).toBe('voxv1|chv:chan-1|user-a');
  });

  it('a sealed frame opens under the IV and AAD written out from §21.2, at every keyId shape', async () => {
    // 15 → 16 wraps the header nibble, 255 → 256 wraps the IV byte
    for (const keyId of [0, 1, 15, 16, 255, 256, 419]) {
      const key = randomKey();
      const s = await sender(keyId, key);
      for (let i = 0; i < 3; i++) {
        const payload = [i, 7, 7, 7, 7];
        const sealed = (await s.encrypt(frame(payload)))!;
        expect(header(sealed)).toEqual({ version: SPEC_VERSION, nibble: keyId & 0x0f, seq: i });
        // AES-GCM adds nothing but the tag: header ‖ ciphertext (payload length) ‖ tag
        expect(sealed.byteLength).toBe(SPEC_HEADER_BYTES + payload.length + SPEC_TAG_BYTES);
        expect(openWithNode(sealed, key, keyId)).toEqual(payload);
        // The generation byte is part of the IV: any other one fails the tag
        expect(() => openWithNode(sealed, key, keyId ^ 0x20)).toThrow();
      }
    }
  });

  it('a frame node:crypto sealed under that construction plays in the receiver', async () => {
    const key = randomKey();
    const r = await receiver(419, key);
    const sealed = sealWithNode([1, 2, 3], key, 419, 5);
    expect([...new Uint8Array((await r.decrypt(sealed))!)]).toEqual([1, 2, 3]);
  });
});

describe('no IV twice under one key', () => {
  it('consecutive frames take consecutive seqs, so every IV under the key is new', async () => {
    const key = randomKey();
    const s = await sender(3, key);
    const ivs = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const sealed = (await s.encrypt(frame([i & 0xff])))!;
      const { seq } = header(sealed);
      expect(seq).toBe(i);
      // It was sealed under exactly the IV its seq names, nothing else
      expect(openWithNode(sealed, key, 3)).toEqual([i & 0xff]);
      ivs.add(hex(specIv(3, seq)));
    }
    expect(ivs.size).toBe(300);
  });

  it('concurrent frames never share a seq: each claims its own before awaiting', async () => {
    const key = randomKey();
    const s = await sender(0, key);
    const sealed = await Promise.all(Array.from({ length: 64 }, (_, i) => s.encrypt(frame([i]))));
    const seqs = sealed.map((f) => header(f!).seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    sealed.forEach((f, i) => expect(openWithNode(f!, key, 0)).toEqual([i]));
  });

  it('a frame racing a key change is sealed under the key and IV its header names', async () => {
    const key0 = randomKey();
    const key1 = randomKey();
    const s = await sender(0, key0);
    await s.encrypt(frame([0]));

    const change = s.setKey(1, key1); // importKey in flight: not installed yet
    const during = (await s.encrypt(frame([1])))!;
    await change;
    const after = (await s.encrypt(frame([2])))!;

    expect(header(during)).toMatchObject({ nibble: 0, seq: 1 });
    expect(openWithNode(during, key0, 0)).toEqual([1]);
    // The new key starts its own counter
    expect(header(after)).toMatchObject({ nibble: 1, seq: 0 });
    expect(openWithNode(after, key1, 1)).toEqual([2]);
  });

  it('frames remaining counts down one per frame (the worker rotates on it before the ceiling)', async () => {
    const s = await sender(0, randomKey());
    expect(s.framesRemaining()).toBe(VOICE_FRAME_SEQ_ROTATE_AT);
    for (let i = 0; i < 3; i++) await s.encrypt(frame([i]));
    expect(s.framesRemaining()).toBe(VOICE_FRAME_SEQ_ROTATE_AT - 3);
  });

  it('at the ceiling the cipher stops for good, its last seq below the 4-byte wrap', async () => {
    expect(VOICE_FRAME_SEQ_ROTATE_AT).toBe(2 ** 32 - 2 ** 16);
    const key = randomKey();
    const s = createSenderCipher(CH, ME, { initialSeqForTest: VOICE_FRAME_SEQ_ROTATE_AT - 3 });
    await s.setKey(0, key);
    expect(s.framesRemaining()).toBe(3);

    const sealed: ArrayBuffer[] = [];
    for (let i = 0; i < 3; i++) sealed.push((await s.encrypt(frame([i])))!);
    expect(sealed.map((f) => header(f).seq)).toEqual([
      VOICE_FRAME_SEQ_ROTATE_AT - 3,
      VOICE_FRAME_SEQ_ROTATE_AT - 2,
      VOICE_FRAME_SEQ_ROTATE_AT - 1,
    ]);
    expect(header(sealed[2]).seq).toBeLessThan(2 ** 32 - 1);
    sealed.forEach((f, i) => expect(openWithNode(f, key, 0)).toEqual([i]));

    // Spent: silence, never a wrapped counter, however often it is asked
    for (let i = 0; i < 5; i++) expect(await s.encrypt(frame([9]))).toBeNull();
    expect(s.framesRemaining()).toBe(0);

    // A receiver follows seqs that high, and its window still refuses a replay there
    const r = await receiver(0, key);
    for (const f of sealed) expect(await r.decrypt(f)).not.toBeNull();
    expect(await r.decrypt(sealed[2])).toBeNull();
    expect(await r.decrypt(sealed[0])).toBeNull();
    expect(r.stats()).toMatchObject({ ok: 3, replayed: 2 });
  });
});

describe('no (key, IV) pair across rotations and session restarts', () => {
  it('through ratchet and fresh rotations, the counter restarts with each key and no pair recurs', async () => {
    const s = createSenderCipher(CH, ME);
    let key = randomKey();
    let keyId = 0;
    const pairs = new Set<string>();
    const keys = new Set<string>();

    const generation = async () => {
      await s.setKey(keyId, key);
      keys.add(hex(key));
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const sealed = (await s.encrypt(frame([i])))!;
        const { seq } = header(sealed);
        expect(openWithNode(sealed, key, keyId)).toEqual([i]);
        pairs.add(`${hex(key)}:${hex(specIv(keyId, seq))}`);
        seqs.push(seq);
      }
      // The same IV values recur in every generation, each time under a new key
      expect(seqs).toEqual([0, 1, 2, 3, 4]);
    };

    await generation();
    for (const step of ['ratchet', 'fresh', 'ratchet', 'ratchet', 'fresh'] as const) {
      key = step === 'ratchet' ? await ratchetVoiceKey(key) : randomKey();
      keyId += 1;
      await generation();
    }
    expect(keys.size).toBe(6);
    expect(pairs.size).toBe(6 * 5);
  });

  it('the ratchet chain never revisits a key, leaves its input alone, and is the same chain for every party', async () => {
    const start = randomKey();
    const startHex = hex(start);
    const seen = new Set([startHex]);
    let k = start;
    for (let i = 0; i < 64; i++) {
      k = await ratchetVoiceKey(k);
      expect(seen.has(hex(k))).toBe(false);
      seen.add(hex(k));
    }
    expect(hex(start)).toBe(startHex);

    let again = start;
    for (let i = 0; i < 64; i++) again = await ratchetVoiceKey(again);
    expect(hex(again)).toBe(hex(k));
  });

  it('a session restart reuses keyId 0 and seq 0 under a new key, which replaces the old generation', async () => {
    const old = await sealedRun(3);
    for (const f of old.frames) expect(await old.receiver.decrypt(f)).not.toBeNull();

    // A restart: a new key, a fresh counter, the same keyId
    const newKey = randomKey();
    const restarted = await sender(0, newKey);
    const first = (await restarted.encrypt(frame([42])))!;
    expect(header(first)).toEqual(header(old.frames[0])); // the same IV as before...
    expect(hex(newKey)).not.toBe(hex(old.key)); // ...under a different key

    await old.receiver.setKey(0, newKey);
    expect(await old.receiver.decrypt(first)).not.toBeNull();
    for (const f of old.frames) expect(await old.receiver.decrypt(f)).toBeNull();
  });
});

describe('replay window', () => {
  it('128 frames behind the highest is outside the window, 127 inside', async () => {
    const { receiver: r, frames } = await sealedRun(131);
    expect(await r.decrypt(frames[130])).not.toBeNull(); // the highest
    expect(await r.decrypt(frames[3])).not.toBeNull(); // 127 behind
    expect(await r.decrypt(frames[2])).toBeNull(); // 128 behind
    expect(await r.decrypt(frames[0])).toBeNull();
    expect(await r.decrypt(frames[3])).toBeNull(); // inside, but already seen
    expect(await r.decrypt(frames[130])).toBeNull();
    expect(r.stats()).toMatchObject({ ok: 2, replayed: 4, tagFailed: 0 });
  });

  it('out-of-order arrival inside the window: each frame plays once, in any order', async () => {
    const { receiver: r, frames } = await sealedRun(128);
    // 37 is coprime with 128: i * 37 mod 128 visits every seq once, scrambled
    const order = Array.from({ length: 128 }, (_, i) => (i * 37) % 128);
    for (const i of order) expect(await r.decrypt(frames[i])).not.toBeNull();
    for (const i of order) expect(await r.decrypt(frames[i])).toBeNull();
    expect(r.stats()).toMatchObject({ ok: 128, replayed: 128 });
  });

  it('a jump of less than 128 keeps what was seen; a jump of 128 or more clears it', async () => {
    const { receiver: r, frames } = await sealedRun(300);
    for (let i = 0; i < 10; i++) expect(await r.decrypt(frames[i])).not.toBeNull();

    expect(await r.decrypt(frames[99])).not.toBeNull(); // 90 ahead
    for (let i = 0; i < 10; i++) expect(await r.decrypt(frames[i])).toBeNull(); // still remembered
    expect(await r.decrypt(frames[50])).not.toBeNull(); // never seen, inside

    expect(await r.decrypt(frames[299])).not.toBeNull(); // 200 ahead
    expect(await r.decrypt(frames[171])).toBeNull(); // 128 behind
    expect(await r.decrypt(frames[172])).not.toBeNull(); // 127 behind, never seen
    expect(await r.decrypt(frames[99])).toBeNull(); // seen, and now outside
  });

  it('a forged far-ahead header cannot move the window', async () => {
    const { receiver: r, frames } = await sealedRun(6);
    for (let i = 0; i < 5; i++) expect(await r.decrypt(frames[i])).not.toBeNull();

    // The SFU rewrites a real frame's seq a million ahead: the tag fails first
    const forged = copyOf(frames[0]);
    new DataView(forged.buffer).setUint32(1, 1_000_000, false);
    expect(await r.decrypt(forged.buffer as ArrayBuffer)).toBeNull();
    expect(r.stats().tagFailed).toBe(1);

    // Had the window moved, frame 5 would sit far outside it
    expect(await r.decrypt(frames[5])).not.toBeNull();
    expect(await r.decrypt(frames[0])).toBeNull();
  });

  it('a tampered copy does not spend the seq of the genuine frame', async () => {
    const { receiver: r, frames } = await sealedRun(2);
    const tampered = copyOf(frames[1]);
    tampered[tampered.length - 1] ^= 0x80;
    expect(await r.decrypt(tampered.buffer as ArrayBuffer)).toBeNull();
    expect(await r.decrypt(frames[1])).not.toBeNull();
  });

  it('each generation keeps a window of its own', async () => {
    const key0 = randomKey();
    const key1 = randomKey();
    const s = await sender(0, key0);
    const r = await receiver(0, key0);
    const gen0 = [(await s.encrypt(frame([0])))!, (await s.encrypt(frame([1])))!];
    await s.setKey(1, key1);
    await r.setKey(1, key1);
    const gen1 = [(await s.encrypt(frame([0])))!, (await s.encrypt(frame([1])))!];

    // The same seqs in two generations are two different frames
    for (const f of [...gen0, ...gen1]) expect(await r.decrypt(f)).not.toBeNull();
    for (const f of [...gen0, ...gen1]) expect(await r.decrypt(f)).toBeNull();
  });

  it('a generation pruned from the ring cannot be replayed, even when its key is delivered again', async () => {
    const keys = [randomKey(), randomKey(), randomKey(), randomKey()];
    const s = await sender(0, keys[0]);
    const r = await receiver(0, keys[0]);
    const gen0: ArrayBuffer[] = [];
    for (let i = 0; i < 3; i++) gen0.push((await s.encrypt(frame([i])))!);
    for (const f of gen0) expect(await r.decrypt(f)).not.toBeNull();

    for (let id = 1; id < 4; id++) {
      await s.setKey(id, keys[id]);
      await r.setKey(id, keys[id]);
    }
    for (const f of gen0) expect(await r.decrypt(f)).toBeNull(); // generation 0 left the ring

    await r.setKey(0, keys[0]); // a withheld envelope for generation 0 arrives late
    for (const f of gen0) expect(await r.decrypt(f)).toBeNull();
    expect(r.stats().replayed).toBe(0); // refused as unknown, never re-admitted to a window

    expect(await r.decrypt((await s.encrypt(frame([7])))!)).not.toBeNull();
  });
});

describe('trial ratchet bounds', () => {
  it('follows one generation ahead, never two: a double jump waits for the sealed key', async () => {
    const k0 = randomKey();
    const k1 = await ratchetVoiceKey(k0);
    const k2 = await ratchetVoiceKey(k1);
    const s = await sender(0, k0);
    const r = await receiver(0, k0);
    expect(await r.decrypt((await s.encrypt(frame([0])))!)).not.toBeNull();

    // Two arrivals of which this receiver saw no frame: the sender is at k2
    await s.setKey(2, k2);
    const twoAhead = (await s.encrypt(frame([2])))!;
    expect(await r.decrypt(twoAhead)).toBeNull();
    expect(r.stats()).toMatchObject({ ratcheted: 0, unknownKey: 1 });

    // The re-seal the decrypt watchdog asks for is what heals it
    await r.setKey(2, k2);
    expect(await r.decrypt(twoAhead)).not.toBeNull();
  });

  it('the frame that triggered a trial ratchet is recorded: delivered again, it is a replay', async () => {
    const k0 = randomKey();
    const s = await sender(0, k0);
    const r = await receiver(0, k0);
    expect(await r.decrypt((await s.encrypt(frame([0])))!)).not.toBeNull();

    await s.setKey(1, await ratchetVoiceKey(k0));
    const trigger = (await s.encrypt(frame([1])))!;
    const next = (await s.encrypt(frame([2])))!;
    expect(await r.decrypt(trigger)).not.toBeNull();
    expect(r.stats()).toMatchObject({ ratcheted: 1, replayed: 0 });

    expect(await r.decrypt(trigger)).toBeNull();
    expect(r.stats()).toMatchObject({ ratcheted: 1, replayed: 1 });
    expect(await r.decrypt(next)).not.toBeNull();
  });

  it('one step at a time, it follows a run of arrivals', async () => {
    let key = randomKey();
    const s = await sender(0, key);
    const r = await receiver(0, key);
    expect(await r.decrypt((await s.encrypt(frame([0])))!)).not.toBeNull();
    for (let id = 1; id <= 5; id++) {
      key = await ratchetVoiceKey(key);
      await s.setKey(id, key);
      expect(await r.decrypt((await s.encrypt(frame([id])))!)).not.toBeNull();
    }
    expect(r.stats().ratcheted).toBe(5);
  });

  it('follows across the header nibble wrap (keyId 15 to 16)', async () => {
    const k15 = randomKey();
    const s = await sender(15, k15);
    const r = await receiver(15, k15);
    expect(await r.decrypt((await s.encrypt(frame([0])))!)).not.toBeNull();

    await s.setKey(16, await ratchetVoiceKey(k15));
    const wrapped = (await s.encrypt(frame([1])))!;
    expect(header(wrapped).nibble).toBe(0);
    expect(await r.decrypt(wrapped)).not.toBeNull();
    expect(await r.decrypt((await s.encrypt(frame([2])))!)).not.toBeNull();
    expect(r.stats().ratcheted).toBe(1);
  });

  it('derives only from the newest generation it holds', async () => {
    const k0 = randomKey();
    const k1 = randomKey(); // a fresh rotation, not a ratchet of k0
    const r = await receiver(0, k0);
    await r.setKey(1, k1);

    const fromOlder = await sender(2, await ratchetVoiceKey(k0));
    expect(await r.decrypt((await fromOlder.encrypt(frame([1])))!)).toBeNull();

    const fromNewest = await sender(2, await ratchetVoiceKey(k1));
    expect(await r.decrypt((await fromNewest.encrypt(frame([2])))!)).not.toBeNull();
    expect(r.stats().ratcheted).toBe(1);
  });

  it('never derives backward: the post-arrival key opens no frame sealed before it', async () => {
    const k0 = randomKey();
    const k1 = await ratchetVoiceKey(k0);
    const s = await sender(0, k0);
    const past: ArrayBuffer[] = [];
    for (let i = 0; i < 4; i++) past.push((await s.encrypt(frame([i])))!);

    const joiner = await receiver(1, k1);
    for (const f of past) expect(await joiner.decrypt(f)).toBeNull();
    expect(joiner.stats()).toMatchObject({ ok: 0, unknownKey: 4, ratcheted: 0 });

    await s.setKey(1, k1);
    expect(await joiner.decrypt((await s.encrypt(frame([9])))!)).not.toBeNull();
  });

  it('a failed trial installs nothing: the current generation plays on and the genuine ratchet still lands', async () => {
    const k0 = randomKey();
    const s = await sender(0, k0);
    const r = await receiver(0, k0);
    expect(await r.decrypt((await s.encrypt(frame([0])))!)).not.toBeNull();

    // A keyId+1 frame under a fresh key whose sealed copy has not arrived
    const fresh = await sender(1, randomKey());
    expect(await r.decrypt((await fresh.encrypt(frame([1])))!)).toBeNull();
    expect(r.stats().ratcheted).toBe(0);

    expect(await r.decrypt((await s.encrypt(frame([2])))!)).not.toBeNull();
    await s.setKey(1, await ratchetVoiceKey(k0));
    expect(await r.decrypt((await s.encrypt(frame([3])))!)).not.toBeNull();
    expect(r.stats().ratcheted).toBe(1);
  });

  it('the ring keeps the newest three generations as trial ratchets add them', async () => {
    let key = randomKey();
    const s = await sender(0, key);
    const r = await receiver(0, key);
    const heldBack: ArrayBuffer[] = [];
    for (let id = 0; id <= 3; id++) {
      if (id > 0) {
        key = await ratchetVoiceKey(key);
        await s.setKey(id, key);
      }
      expect(await r.decrypt((await s.encrypt(frame([id])))!)).not.toBeNull();
      heldBack.push((await s.encrypt(frame([id + 100])))!);
    }
    expect(await r.decrypt(heldBack[0])).toBeNull(); // generation 0 was pruned
    for (const f of heldBack.slice(1)) expect(await r.decrypt(f)).not.toBeNull();
  });
});

describe('every byte of a frame is authenticated', () => {
  it('flipping any one bit of the header refuses the frame', async () => {
    const { receiver: r, frames } = await sealedRun(1);
    for (let byte = 0; byte < SPEC_HEADER_BYTES; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const tampered = copyOf(frames[0]);
        tampered[byte] ^= 1 << bit;
        expect(await r.decrypt(tampered.buffer as ArrayBuffer)).toBeNull();
      }
    }
    expect(r.stats().ok).toBe(0);
    expect(await r.decrypt(frames[0])).not.toBeNull();
  });

  it('flipping a bit anywhere in the ciphertext or the tag refuses the frame', async () => {
    const key = randomKey();
    const s = await sender(0, key);
    const r = await receiver(0, key);
    const sealed = (await s.encrypt(frame(Array.from({ length: 40 }, (_, i) => i))))!;
    const last = sealed.byteLength - 1;
    const tagStart = sealed.byteLength - SPEC_TAG_BYTES;
    for (const at of [SPEC_HEADER_BYTES, SPEC_HEADER_BYTES + 20, tagStart - 1, tagStart, last]) {
      const tampered = copyOf(sealed);
      tampered[at] ^= 0x01;
      expect(await r.decrypt(tampered.buffer as ArrayBuffer)).toBeNull();
    }
    expect(await r.decrypt(sealed.slice(0, last))).toBeNull(); // one byte short
    const longer = new Uint8Array(sealed.byteLength + 1);
    longer.set(new Uint8Array(sealed));
    expect(await r.decrypt(longer.buffer)).toBeNull(); // one byte more
    expect(await r.decrypt(sealed)).not.toBeNull();
  });

  it("one frame's header on another frame's body is refused (no splicing)", async () => {
    const { receiver: r, frames } = await sealedRun(2);
    const a = new Uint8Array(frames[0]);
    const b = new Uint8Array(frames[1]);
    const spliced = (head: Uint8Array, body: Uint8Array) => {
      const out = new Uint8Array(body.length);
      out.set(body);
      out.set(head.subarray(0, SPEC_HEADER_BYTES), 0);
      return out.buffer;
    };
    expect(await r.decrypt(spliced(a, b))).toBeNull();
    expect(await r.decrypt(spliced(b, a))).toBeNull();
    expect(await r.decrypt(frames[0])).not.toBeNull();
    expect(await r.decrypt(frames[1])).not.toBeNull();
  });

  it('the AAD binds the exact channel and sender, near misses included', async () => {
    const key = randomKey();
    const sealed = (await (await sender(0, key)).encrypt(frame([1, 2, 3])))!;
    const nearMisses: Array<[string, string]> = [['chan-10', ME], ['chan-', ME], [CH, 'user-A'], [CH, 'user-a ']];
    for (const [channelId, senderUserId] of nearMisses) {
      const r = createReceiverCipher(channelId, senderUserId);
      await r.setKey(0, key);
      expect(await r.decrypt(sealed)).toBeNull();
    }
    expect(await (await receiver(0, key)).decrypt(sealed)).not.toBeNull();
  });
});
