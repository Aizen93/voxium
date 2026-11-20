// @vitest-environment node
// Pure WebCrypto — node env gives us the real crypto.subtle without jsdom.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSenderCipher,
  createReceiverCipher,
  ratchetVoiceKey,
} from '../../services/e2e/voiceFrameCipher';

/**
 * Spec §21.4: re-installing a generation already held preserves its replay
 * window. A generation can reach the receiver twice at once, through the
 * trial ratchet (derived from the frames) and as its sealed copy (installed
 * from a key message), and each route waits on a key import before it writes
 * the ring. Whichever lands second keeps the entry, and the frames recorded
 * under it, when it holds the same key.
 */

const CH = 'chan-1';
const ME = 'user-a';

function randomKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

const frame = (byte: number) => new Uint8Array([byte, byte, byte]).buffer;

type ImportKey = (...args: unknown[]) => Promise<CryptoKey>;

/** Holds the next AES-GCM key import open until released; every other import runs as usual. */
function holdNextGcmImport() {
  const original = crypto.subtle.importKey.bind(crypto.subtle) as unknown as ImportKey;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let used = false;
  const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation((async (...args: unknown[]) => {
    const algorithm = args[2] as string | { name: string };
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (!used && name === 'AES-GCM') {
      used = true;
      reached();
      await gate;
    }
    return original(...args);
  }) as never);
  return { started, release, restore: () => spy.mockRestore() };
}

/** Two frames sealed under generation 1, the arrival ratchet of generation 0. */
async function generationOneFrames() {
  const k0 = randomKey();
  const k1 = await ratchetVoiceKey(k0);
  const sender = createSenderCipher(CH, ME);
  await sender.setKey(1, k1);
  const a = (await sender.encrypt(frame(1)))!;
  const b = (await sender.encrypt(frame(2)))!;
  const receiver = createReceiverCipher(CH, ME);
  await receiver.setKey(0, k0);
  return { k1, a, b, receiver };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a generation installed twice keeps its replay window', () => {
  it('the sealed copy installed after a trial ratchet took the same generation keeps the frames that ratchet recorded', async () => {
    const { k1, a, b, receiver } = await generationOneFrames();
    const hold = holdNextGcmImport();

    const install = receiver.setKey(1, k1); // its key import held open
    await hold.started;
    // Meanwhile the frames arrive: the trial ratchet takes generation 1 and plays them
    expect(await receiver.decrypt(a)).not.toBeNull();
    expect(await receiver.decrypt(b)).not.toBeNull();
    expect(receiver.stats().ratcheted).toBe(1);

    hold.release();
    await install;
    hold.restore();

    expect(await receiver.decrypt(a)).toBeNull();
    expect(await receiver.decrypt(b)).toBeNull();
    expect(receiver.stats()).toMatchObject({ ok: 2, replayed: 2 });
  });

  it('a trial ratchet completing after the sealed copy of its generation was installed keeps the frames recorded under that copy', async () => {
    const { k1, a, b, receiver } = await generationOneFrames();
    const hold = holdNextGcmImport();

    const trial = receiver.decrypt(a); // derives generation 1; its key import held open
    await hold.started;
    await receiver.setKey(1, k1);
    // Another pipeline for the same sender plays the next frame under the installed copy
    expect(await receiver.decrypt(b)).not.toBeNull();

    hold.release();
    expect(await trial).not.toBeNull();
    hold.restore();

    expect(await receiver.decrypt(b)).toBeNull();
    expect(await receiver.decrypt(a)).toBeNull();
    expect(receiver.stats()).toMatchObject({ ok: 2, replayed: 2 });
  });

  it('a DIFFERENT key for that keyId, installed meanwhile, still installs as a new generation', async () => {
    const { a, receiver } = await generationOneFrames();
    const other = randomKey();
    const hold = holdNextGcmImport();

    const install = receiver.setKey(1, other); // a peer that restarted: other bytes, same keyId
    await hold.started;
    expect(await receiver.decrypt(a)).not.toBeNull(); // the trial ratchet's generation 1

    hold.release();
    await install;
    hold.restore();

    const restarted = createSenderCipher(CH, ME);
    await restarted.setKey(1, other);
    expect(await receiver.decrypt((await restarted.encrypt(frame(9)))!)).not.toBeNull();
  });
});
