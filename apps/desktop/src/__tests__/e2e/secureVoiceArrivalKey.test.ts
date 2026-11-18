// @vitest-environment node
// The real frame cipher runs here (WebCrypto from node), so every assertion is
// about what a sealed key can and cannot open.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { buildVoiceKeyPlaintext, e2eVoiceScope } from '@voxium/shared';
import {
  createSenderCipher,
  createReceiverCipher,
  ratchetVoiceKey,
  type SenderCipher,
} from '../../services/e2e/voiceFrameCipher';

/**
 * Spec §21.4: a member who joins a secure voice channel is keyed with a
 * generation that starts after their arrival, so nothing sent before it opens
 * for them, whichever path keys them first. Members already present follow the
 * arrival without a new sealed key (trial ratchet), and occupants present when
 * we joined are keyed with our current key.
 *
 * Harness: the module under test is real; the E2E service, the socket and the
 * stores are mocked as in secureVoiceKeys.test.ts. Our frame session's
 * setLocalKey feeds a real sender cipher, so "speaking" seals a frame under the
 * generation installed at that moment, and every key the module seals is read
 * back from the Olm plaintext it hands over.
 */

// The service itself is not loaded here: a stand-in for the one class the
// module under test takes from it.
const { TestIdentityChangedError } = vi.hoisted(() => ({
  TestIdentityChangedError: class extends Error {
    constructor(public readonly peerUserId: string) {
      super('Peer identity key changed');
      this.name = 'E2EIdentityChangedError';
    }
  },
}));

const fetchChannelDeviceLists = vi.fn();
const fetchDeviceList = vi.fn();
const encryptToDevice = vi.fn();
const decryptFromDevice = vi.fn();

vi.mock('../../services/e2e/e2eService', () => ({
  E2EIdentityChangedError: TestIdentityChangedError,
  getE2EService: () => ({
    deviceId: 'device-me000001',
    fetchChannelDeviceLists,
    fetchDeviceList,
    encryptToDevice,
    decryptFromDevice,
  }),
}));

const socketEmit = vi.fn();
vi.mock('../../services/socket', () => ({
  getSocket: () => ({ emit: socketEmit }),
}));

const frameSession = vi.hoisted(() => ({
  setLocalKey: vi.fn(),
  setRemoteKey: vi.fn(),
  removeRemote: vi.fn(),
  attachSender: vi.fn(),
  attachReceiver: vi.fn(),
  onCounterLow: vi.fn(),
  onDecryptStalled: vi.fn(),
  onFatal: vi.fn(),
  getDiagnostics: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../../services/e2e/voiceFrameTransform', () => ({
  isSecureVoiceSupported: () => true,
  createFrameCryptoSession: vi.fn(() => frameSession),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me' } }) },
}));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ flagIdentityChanged: vi.fn() }) },
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ markSecureVoicePeerExcluded: vi.fn(), clearSecureVoicePeerIssue: vi.fn() }) },
}));

import {
  beginSecureVoiceSession,
  endSecureVoiceSession,
  onParticipantJoined,
  onParticipantLeft,
  handleInboundKey,
  handleKeyRequest,
  confirmMembership,
} from '../../services/e2e/secureVoiceKeys';

const CH = 'chan-1';
const ENV = '{"v":1,"e":"olm1","t":0,"b":"Zg"}';
/** Every participant of the tests, with the devices they publish. */
const DEVICES: Record<string, string[]> = {
  old: ['device-old00001'],
  x: ['device-x0000001', 'device-x0000002'],
  y: ['device-y0000001'],
  z: ['device-z0000001'],
};

const user = (id: string, epoch = `epoch-${id}-1`, deviceId = DEVICES[id][0]) => ({ id, deviceId, epoch });

/** Members whose device-list fetch fails as a network error would. */
const failingVets = new Set<string>();
let myEpoch = '';

// ── Our outgoing frames, through a real sender cipher ──────────────────────

let sender: SenderCipher;
let senderReady: Promise<void>;
let installs: Array<{ keyId: number; key: Uint8Array }>;

function routeLocalKeysToCipher(): void {
  sender = createSenderCipher(CH, 'me');
  senderReady = Promise.resolve();
  installs = [];
  frameSession.setLocalKey.mockImplementation((keyId: number, raw: Uint8Array) => {
    // A copy: the module zero-fills its own array when the session ends
    const key = raw.slice();
    installs.push({ keyId, key });
    senderReady = senderReady.then(() => sender.setKey(keyId, key));
  });
}

/** One frame of our audio, sealed under the generation installed right now. */
async function speak(byte: number): Promise<ArrayBuffer> {
  await senderReady;
  const sealed = await sender.encrypt(new Uint8Array([byte, byte, byte]).buffer);
  if (!sealed) throw new Error('the sender cipher had no key');
  return sealed;
}

// ── What we sealed, and what it opens ───────────────────────────────────────

interface SealedKey { keyId: number; key: Uint8Array; reason: string; deviceId: string }

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sealedTo(userId: string): SealedKey[] {
  return encryptToDevice.mock.calls
    .filter((call) => call[0] === userId)
    .map((call) => {
      const p = JSON.parse(call[2] as string) as { keyId: number; keyB64: string; reason: string };
      return { keyId: p.keyId, key: fromB64(p.keyB64), reason: p.reason, deviceId: call[1] as string };
    });
}

/** Whether a receiver holding exactly these keys plays the frame. */
async function opens(keys: Array<{ keyId: number; key: Uint8Array }>, frame: ArrayBuffer): Promise<boolean> {
  const receiver = createReceiverCipher(CH, 'me');
  for (const k of keys) await receiver.setKey(k.keyId, k.key);
  return (await receiver.decrypt(frame)) !== null;
}

/**
 * The frame stays closed to this key: not only under the key's own keyId, but
 * also installed under the keyId the frame names, where the GCM tag (and not a
 * keyId mismatch) is what refuses it.
 */
async function expectClosedTo(sealed: SealedKey, frame: ArrayBuffer, frameKeyId: number): Promise<void> {
  expect(await opens([sealed], frame)).toBe(false);
  const receiver = createReceiverCipher(CH, 'me');
  await receiver.setKey(frameKeyId, sealed.key);
  expect(await receiver.decrypt(frame)).toBeNull();
  expect(receiver.stats().tagFailed).toBe(1);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// ── Session plumbing ─────────────────────────────────────────────────────────

function deviceListFor(userId: string) {
  return {
    devices: DEVICES[userId].map((deviceId) => ({ deviceId, curve25519Key: 'c', ed25519Key: 'e', verified: false, crossSigned: true })),
    servedDeviceCount: DEVICES[userId].length,
    listVersion: 1,
    masterKey: null,
  };
}

const ALL_MEMBERS = {
  members: ['me', ...Object.keys(DEVICES)].map((userId) => ({ userId, isCreator: userId === 'me' })),
  lists: new Map(),
  unverifiableUserIds: [],
};

async function begin() {
  const session = await beginSecureVoiceSession(CH);
  myEpoch = session.epoch;
  return session;
}

/** Our session, with `old` present at our join and keyed, and our frames flowing. */
async function callWithOccupant() {
  const session = await begin();
  onParticipantJoined(CH, user('old'), { initialReplay: true });
  await until(() => sealedTo('old').length === 1);
  session.frames.attachSender({} as RTCRtpSender);
  return session;
}

async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!condition()) throw new Error('not yet');
  }, { timeout: 3000, interval: 2 });
}

/** Let the key chain finish whatever it was given (it mixes imports, timers and WebCrypto). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await senderReady;
}

/** A transiently failing first vet: the step logs it and leaves them un-vetted. */
async function arriveWithFailingVet(id: string, epoch?: string): Promise<void> {
  failingVets.add(id);
  const before = warn.mock.calls.length;
  onParticipantJoined(CH, user(id, epoch), { initialReplay: false });
  await until(() => warn.mock.calls.slice(before).some((args) => String(args[0]).includes(`Vetting ${id} failed transiently`)));
}

/**
 * The periodic membership check, with every device list answering again.
 * Resolves once the check has started; callers wait for what it produces.
 */
async function membershipCheck(opts: { stillFailing?: boolean } = {}): Promise<void> {
  if (!opts.stillFailing) failingVets.clear();
  const fetchesBefore = fetchChannelDeviceLists.mock.calls.length;
  confirmMembership(CH);
  await until(() => fetchChannelDeviceLists.mock.calls.length > fetchesBefore);
}

let warn: MockInstance<typeof console.warn>;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  endSecureVoiceSession(CH);
  vi.clearAllMocks();
  failingVets.clear();
  routeLocalKeysToCipher();
  fetchChannelDeviceLists.mockResolvedValue(ALL_MEMBERS);
  fetchDeviceList.mockImplementation(async (userId: string) => {
    if (failingVets.has(userId)) throw new Error('Network Error');
    return deviceListFor(userId);
  });
  encryptToDevice.mockResolvedValue(ENV);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  endSecureVoiceSession(CH);
  warn.mockRestore();
  log.mockRestore();
  frameSession.setLocalKey.mockReset();
});

describe('a member who joins is keyed from their arrival', () => {
  it('a joiner vetted at arrival is sealed the generation after the one in use, and existing members follow it without a new key', async () => {
    await callWithOccupant();
    const before = await speak(1);

    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    const after = await speak(2);

    const [sealed] = sealedTo('x');
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    expect(sealed).toMatchObject({ keyId: 1, reason: 'ratchet' });
    await expectClosedTo(sealed, before, 0);
    expect(await opens([sealed], after)).toBe(true);
    // `old` holds generation 0 only and follows by trial ratchet
    expect(sealedTo('old')).toHaveLength(1);
    expect(await opens(sealedTo('old'), after)).toBe(true);
  });

  it('a joiner whose first vetting fails transiently is keyed at the next membership check with a generation that starts after their arrival', async () => {
    await callWithOccupant();
    const beforeArrival = await speak(1);

    await arriveWithFailingVet('x');
    expect(sealedTo('x')).toHaveLength(0);
    // Sent while they were in the call but not yet keyed: still the generation in use at their arrival
    const whileUnkeyed = await speak(2);

    await membershipCheck();
    await until(() => sealedTo('x').length === 1);
    await settle();
    const afterKeying = await speak(3);

    const [sealed] = sealedTo('x');
    expect(sealedTo('x')).toHaveLength(1);
    expect(sealed.keyId).toBe(1);
    expect(hex(installs[1].key)).toBe(hex(await ratchetVoiceKey(installs[0].key)));
    await expectClosedTo(sealed, beforeArrival, 0);
    await expectClosedTo(sealed, whileUnkeyed, 0);
    expect(await opens([sealed], afterKeying)).toBe(true);
    expect(sealedTo('old')).toHaveLength(1);
    expect(await opens(sealedTo('old'), afterKeying)).toBe(true);
  });

  it('a key request from a joiner not yet vetted is not answered, and once vetted they are keyed past their arrival exactly once', async () => {
    await callWithOccupant();
    const beforeArrival = await speak(1);
    await arriveWithFailingVet('x');

    handleKeyRequest(CH, 'x');
    await settle();
    expect(sealedTo('x')).toHaveLength(0);
    expect(installs.map((i) => i.keyId)).toEqual([0]);

    await membershipCheck();
    handleKeyRequest(CH, 'x');
    await until(() => sealedTo('x').length === 2);

    // The answer is the same post-arrival generation: no second ratchet
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    const sealed = sealedTo('x');
    expect(sealed.map((s) => s.keyId)).toEqual([1, 1]);
    expect(hex(sealed[1].key)).toBe(hex(sealed[0].key));
    await expectClosedTo(sealed[1], beforeArrival, 0);
  });

  it('of two joiners where only the second is vetted at arrival, the first is keyed later with a generation that still starts after their arrival', async () => {
    await callWithOccupant();
    const beforeArrivals = await speak(1);

    await arriveWithFailingVet('x');
    onParticipantJoined(CH, user('y'), { initialReplay: false });
    await until(() => sealedTo('y').length === 1);
    const betweenKeyings = await speak(2);

    await membershipCheck();
    await until(() => sealedTo('x').length === 1);
    const [sealedX] = sealedTo('x');
    const [sealedY] = sealedTo('y');

    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    expect(sealedY.keyId).toBe(1);
    expect(sealedX.keyId).toBe(1);
    await expectClosedTo(sealedX, beforeArrivals, 0);
    await expectClosedTo(sealedY, beforeArrivals, 0);
    // Sent after both had arrived: theirs to hear
    expect(await opens([sealedX], betweenKeyings)).toBe(true);
  });

  it('a burst of joiners announced together shares one ratchet, and members already present follow it without a new key', async () => {
    await callWithOccupant();
    const beforeArrivals = await speak(1);

    for (const id of ['x', 'y', 'z']) onParticipantJoined(CH, user(id), { initialReplay: false });
    await until(() => ['x', 'y', 'z'].every((id) => sealedTo(id).length === 1));
    const afterArrivals = await speak(2);

    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    for (const id of ['x', 'y', 'z']) {
      const [sealed] = sealedTo(id);
      expect(sealed.keyId).toBe(1);
      await expectClosedTo(sealed, beforeArrivals, 0);
      expect(await opens([sealed], afterArrivals)).toBe(true);
    }
    expect(sealedTo('old')).toHaveLength(1);
    expect(await opens(sealedTo('old'), afterArrivals)).toBe(true);
  });

  it('joiners whose vetting failed together are keyed with one ratchet at the next check', async () => {
    await callWithOccupant();
    const beforeArrivals = await speak(1);
    await arriveWithFailingVet('x');
    await arriveWithFailingVet('y');

    await membershipCheck();
    await until(() => sealedTo('x').length === 1 && sealedTo('y').length === 1);

    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    for (const id of ['x', 'y']) {
      const [sealed] = sealedTo(id);
      expect(sealed.keyId).toBe(1);
      await expectClosedTo(sealed, beforeArrivals, 0);
    }
  });

  it('a joiner who leaves before being keyed causes no ratchet later: their departure rotates fresh once, like any departure', async () => {
    await callWithOccupant();
    await arriveWithFailingVet('x');

    onParticipantLeft(CH, 'x');
    await until(() => installs.length === 2);
    await membershipCheck();
    await settle();

    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    // A fresh key, not a ratchet of the one before it
    expect(hex(installs[1].key)).not.toBe(hex(await ratchetVoiceKey(installs[0].key)));
    expect(sealedTo('x')).toHaveLength(0);
    expect(sealedTo('old').map((s) => s.keyId)).toEqual([0, 1]);
  });

  it('a fresh rotation between a joiner\'s arrival and their keying already starts after the arrival: they are sealed it without a ratchet', async () => {
    await callWithOccupant();
    const beforeArrival = await speak(1);
    await arriveWithFailingVet('x');

    // The sender counter nears its ceiling: a fresh rotation
    const counterLow = frameSession.onCounterLow.mock.calls[0][0] as () => void;
    counterLow();
    await until(() => installs.length === 2);
    await membershipCheck();
    await until(() => sealedTo('x').length === 1);
    const afterKeying = await speak(2);

    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    const [sealed] = sealedTo('x');
    expect(sealed.keyId).toBe(1);
    expect(hex(sealed.key)).toBe(hex(installs[1].key));
    await expectClosedTo(sealed, beforeArrival, 0);
    expect(await opens([sealed], afterKeying)).toBe(true);
  });

  it('a member who was keyed, left and came back is keyed again from their return', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    const whilePresent = await speak(1);

    onParticipantLeft(CH, 'x');
    await until(() => installs.length === 3);
    const whileAway = await speak(2);

    onParticipantJoined(CH, user('x', 'epoch-x-2'), { initialReplay: false });
    await until(() => sealedTo('x').length === 2);
    const afterReturn = await speak(3);

    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2, 3]);
    const returned = sealedTo('x')[1];
    expect(returned.keyId).toBe(3);
    await expectClosedTo(returned, whileAway, 2);
    await expectClosedTo(returned, whilePresent, 1);
    expect(await opens([returned], afterReturn)).toBe(true);
    // Their first key does not reach the generation sent while they were away
    expect(await opens([sealedTo('x')[0]], whileAway)).toBe(false);
  });

  it('a member re-announced with a new epoch, here from another device, is keyed as a departure and an arrival: the new key opens nothing sent before, the previous one nothing sent after', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    const firstDeviceKey = sealedTo('x')[0];
    const beforeSwitch = await speak(1);

    onParticipantJoined(CH, user('x', 'epoch-x-2', DEVICES.x[1]), { initialReplay: false });
    await until(() => sealedTo('x').length === 2);
    const afterSwitch = await speak(2);

    const secondDeviceKey = sealedTo('x')[1];
    expect(secondDeviceKey.deviceId).toBe(DEVICES.x[1]);
    // The previous session rotates fresh, as a departure does; that key is past the new arrival
    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2]);
    expect(hex(installs[2].key)).not.toBe(hex(await ratchetVoiceKey(installs[1].key)));
    expect(secondDeviceKey.keyId).toBe(2);
    // The previous key, trial ratchet included, opens nothing sent after
    expect(await opens([firstDeviceKey], afterSwitch)).toBe(false);
    // The new key opens what is sent from its arrival on, nothing before
    await expectClosedTo(secondDeviceKey, beforeSwitch, 1);
    expect(await opens([secondDeviceKey], afterSwitch)).toBe(true);
    // The member present throughout is sealed the fresh key
    expect(await opens(sealedTo('old'), afterSwitch)).toBe(true);
  });

  it('keys a joiner sent before their late vet are installed once they are vetted', async () => {
    await callWithOccupant();
    await arriveWithFailingVet('x');
    decryptFromDevice.mockResolvedValueOnce(buildVoiceKeyPlaintext({
      v: 1,
      scope: e2eVoiceScope(CH),
      senderUserId: 'x',
      senderDeviceId: DEVICES.x[0],
      epoch: 'epoch-x-1',
      recipientEpoch: myEpoch,
      seq: 0,
      keyId: 0,
      keyB64: 'A'.repeat(43),
      reason: 'initial',
    }));
    handleInboundKey(CH, 'x', DEVICES.x[0], ENV);
    await settle();
    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();

    await membershipCheck();
    await until(() => frameSession.setRemoteKey.mock.calls.length > 0);

    expect(frameSession.setRemoteKey).toHaveBeenCalledWith('x', 0, expect.any(Uint8Array));
  });
});

describe('a participant vetted at a later membership check', () => {
  const warned = (text: string) => warn.mock.calls.some((args) => String(args[0]).includes(text));

  it('a re-vet that fails transiently again is retried at the next check', async () => {
    await callWithOccupant();
    await arriveWithFailingVet('x');

    await membershipCheck({ stillFailing: true });
    await until(() => warned('Re-vetting x failed transiently — retried at the next membership check'));
    await settle();
    expect(sealedTo('x')).toHaveLength(0);

    await membershipCheck();
    await until(() => sealedTo('x').length === 1);
    expect(sealedTo('x')[0].keyId).toBe(1);
  });

  it('a seal that fails after a passed re-vet is not retried by the check; their key request reseals the same generation', async () => {
    await callWithOccupant();
    const beforeArrival = await speak(1);
    await arriveWithFailingVet('x');
    let sealFails = true;
    encryptToDevice.mockImplementation(async (userId: string) => {
      if (userId === 'x' && sealFails) throw new Error('Network Error');
      return ENV;
    });

    await membershipCheck();
    await until(() => warned('Keying x after a passed re-vet failed — not retried here; recovery comes from the key requests'));
    sealFails = false;
    const attempts = encryptToDevice.mock.calls.filter((call) => call[0] === 'x').length;
    await membershipCheck();
    await settle();
    expect(encryptToDevice.mock.calls.filter((call) => call[0] === 'x')).toHaveLength(attempts);

    handleKeyRequest(CH, 'x');
    await until(() => encryptToDevice.mock.calls.filter((call) => call[0] === 'x').length === attempts + 1);
    const resealed = sealedTo('x').at(-1)!;
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    expect(resealed.keyId).toBe(1);
    await expectClosedTo(resealed, beforeArrival, 0);
  });
});

describe('occupants present when we joined are not arrivals', () => {
  it('the occupants of the replay at our join are sealed our current key, with no ratchet', async () => {
    const session = await begin();
    onParticipantJoined(CH, user('old'), { initialReplay: true });
    onParticipantJoined(CH, user('y'), { initialReplay: true });
    await until(() => sealedTo('old').length === 1 && sealedTo('y').length === 1);
    session.frames.attachSender({} as RTCRtpSender);
    const first = await speak(1);

    expect(installs.map((i) => i.keyId)).toEqual([0]);
    for (const id of ['old', 'y']) {
      expect(sealedTo(id)[0]).toMatchObject({ keyId: 0, reason: 'initial' });
      expect(await opens(sealedTo(id), first)).toBe(true);
    }
    expect(frameSession.attachSender).toHaveBeenCalledTimes(1);
  });

  it('an occupant of the replay whose vetting failed transiently is keyed at the next check without a ratchet', async () => {
    const session = await begin();
    failingVets.add('old');
    onParticipantJoined(CH, user('old'), { initialReplay: true });
    await until(() => warn.mock.calls.some((args) => String(args[0]).includes('Vetting old failed transiently')));
    session.frames.attachSender({} as RTCRtpSender);
    const first = await speak(1);

    await membershipCheck();
    await until(() => sealedTo('old').length === 1);
    await settle();

    expect(installs.map((i) => i.keyId)).toEqual([0]);
    expect(sealedTo('old').map((s) => s.keyId)).toEqual([0]);
    expect(await opens(sealedTo('old'), first)).toBe(true);
  });

  it('anyone first announced after our frames started is keyed as an arrival', async () => {
    await callWithOccupant();
    const beforeAnnouncement = await speak(1);

    onParticipantJoined(CH, user('x'), { initialReplay: true });
    await until(() => sealedTo('x').length === 1);

    const [sealed] = sealedTo('x');
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    expect(sealed.keyId).toBe(1);
    await expectClosedTo(sealed, beforeAnnouncement, 0);
  });

  it('an occupant listed again after our frames started is not keyed again', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('old'), { initialReplay: true });
    await settle();

    expect(installs.map((i) => i.keyId)).toEqual([0]);
    expect(sealedTo('old')).toHaveLength(1);
  });
});

describe('our own key starts at our join', () => {
  it('a new session of ours starts on a key no frame of the previous session was sealed under', async () => {
    await callWithOccupant();
    const previousSession = await speak(1);
    endSecureVoiceSession(CH);

    // A reconnect: a new session, keyed to the occupant again from its own replay
    routeLocalKeysToCipher();
    encryptToDevice.mockClear();
    await callWithOccupant();

    const [sealed] = sealedTo('old');
    expect(sealed.keyId).toBe(0);
    await expectClosedTo(sealed, previousSession, 0);
    expect(await opens([sealed], await speak(2))).toBe(true);
  });
});
