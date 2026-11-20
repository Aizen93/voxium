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
const markExcluded = vi.hoisted(() => vi.fn());
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ markSecureVoicePeerExcluded: markExcluded, clearSecureVoicePeerIssue: vi.fn() }) },
}));

import {
  beginSecureVoiceSession,
  endSecureVoiceSession,
  onParticipantJoined,
  onParticipantLeft,
  handleInboundKey,
  handleKeyRequest,
  confirmMembership,
  secureVoiceKeyChain,
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

/**
 * The channel device lists as the service answers them while `id`'s identity
 * change is not accepted: the default call fails on them, a collecting call
 * names them and lists everyone else.
 */
function listsWhileIdentityChanged(id: string) {
  return async (_channelId: string, opts?: { collectIdentityChanges?: boolean }) => {
    if (!opts?.collectIdentityChanges) throw new TestIdentityChangedError(id);
    return { ...ALL_MEMBERS, identityChangedUserIds: [id] };
  };
}

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

/**
 * Let the key chain finish whatever it was given: the chain of the session
 * under test and the sender cipher's installs (`senderReady`, which the
 * module's setLocalKey feeds here, outside the chain) both at rest twice in a
 * row. The turn between the two looks lets a step queued meanwhile, or a
 * notice or an import a step started without awaiting, land before the second.
 */
async function settle(): Promise<void> {
  for (let calm = 0; calm < 2; ) {
    const chain = secureVoiceKeyChain(CH);
    const ready = senderReady;
    await chain;
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    calm = secureVoiceKeyChain(CH) === chain && senderReady === ready ? calm + 1 : 0;
  }
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
  // An answer queued for a call that never came must not reach the next test
  for (const serviceMock of [fetchChannelDeviceLists, fetchDeviceList, encryptToDevice, decryptFromDevice]) serviceMock.mockReset();
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

describe('one member\'s unaccepted identity change does not hold back the others', () => {
  it('a joiner whose first vet failed transiently is keyed past their arrival at the next check', async () => {
    await callWithOccupant();
    const beforeArrival = await speak(1);
    await arriveWithFailingVet('x');
    // `z`, a member of the channel who is not in the call, has an identity change not accepted
    fetchChannelDeviceLists.mockImplementation(listsWhileIdentityChanged('z'));

    await membershipCheck();
    await until(() => sealedTo('x').length === 1);
    const afterKeying = await speak(2);

    const [sealed] = sealedTo('x');
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    expect(sealed.keyId).toBe(1);
    await expectClosedTo(sealed, beforeArrival, 0);
    expect(await opens([sealed], afterKeying)).toBe(true);
    expect(markExcluded).not.toHaveBeenCalled();
  });

  it('a joiner the list did not name yet, whose refetch names that change, is keyed past their arrival at once', async () => {
    // Our join's list does not name `x` yet
    fetchChannelDeviceLists.mockResolvedValueOnce({
      ...ALL_MEMBERS,
      members: ALL_MEMBERS.members.filter((m) => m.userId !== 'x'),
    });
    await callWithOccupant();
    const beforeArrival = await speak(1);
    fetchChannelDeviceLists.mockImplementation(listsWhileIdentityChanged('z'));

    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    const afterKeying = await speak(2);

    const [sealed] = sealedTo('x');
    expect(sealed.keyId).toBe(1);
    await expectClosedTo(sealed, beforeArrival, 0);
    expect(await opens([sealed], afterKeying)).toBe(true);
    expect(markExcluded).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((args) => String(args[0]).includes('Vetting x failed transiently'))).toBe(false);
  });

  it('a refetch that names a participant already keyed: the check that follows excludes them and rotates before the joiner is keyed', async () => {
    // Our join's list does not name `x` yet
    fetchChannelDeviceLists.mockResolvedValueOnce({
      ...ALL_MEMBERS,
      members: ALL_MEMBERS.members.filter((m) => m.userId !== 'x'),
    });
    await callWithOccupant();
    onParticipantJoined(CH, user('y'), { initialReplay: false });
    await until(() => sealedTo('y').length === 1);
    const heldByY = sealedTo('y');

    // From here on, one frame of ours is sealed under every generation the moment it is installed
    const recorded: Array<{ keyId: number; frame: Promise<ArrayBuffer | null> }> = [];
    frameSession.setLocalKey.mockImplementation((keyId: number, raw: Uint8Array) => {
      const key = raw.slice();
      installs.push({ keyId, key });
      let resolveFrame!: (frame: ArrayBuffer | null) => void;
      recorded.push({ keyId, frame: new Promise((resolve) => { resolveFrame = resolve; }) });
      senderReady = senderReady
        .then(() => sender.setKey(keyId, key))
        .then(async () => resolveFrame(await sender.encrypt(new Uint8Array([9, keyId, 9]).buffer)));
    });

    fetchChannelDeviceLists.mockImplementation(listsWhileIdentityChanged('y'));
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1 && markExcluded.mock.calls.some((call) => call[1] === 'y'));
    await settle();

    expect(markExcluded).toHaveBeenCalledWith(CH, 'y', 'identity-changed');
    expect(recorded.map((generation) => generation.keyId)).toEqual([2]);
    for (const generation of recorded) {
      const frame = await generation.frame;
      expect(frame).not.toBeNull();
      expect(await opens(heldByY, frame!)).toBe(false);
    }
    const last = await recorded[recorded.length - 1].frame;
    expect(await opens(sealedTo('x'), last!)).toBe(true);
  });

  it('a session starts while that change is not accepted, and keys everyone else', async () => {
    fetchChannelDeviceLists.mockImplementation(listsWhileIdentityChanged('z'));
    await callWithOccupant();
    const first = await speak(1);

    expect(sealedTo('old')).toHaveLength(1);
    expect(await opens(sealedTo('old'), first)).toBe(true);
    expect(markExcluded).not.toHaveBeenCalled();
  });

  it('a member excluded at the check is rotated away from before a retried vet is keyed: no generation installed in that check opens with the key they held', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('y'), { initialReplay: false });
    await until(() => sealedTo('y').length === 1);
    await arriveWithFailingVet('x');
    const heldByY = sealedTo('y');

    // From here on, one frame of ours is sealed under every generation the moment it is installed
    const recorded: Array<{ keyId: number; frame: Promise<ArrayBuffer | null> }> = [];
    frameSession.setLocalKey.mockImplementation((keyId: number, raw: Uint8Array) => {
      const key = raw.slice();
      installs.push({ keyId, key });
      let resolveFrame!: (frame: ArrayBuffer | null) => void;
      recorded.push({ keyId, frame: new Promise((resolve) => { resolveFrame = resolve; }) });
      senderReady = senderReady
        .then(() => sender.setKey(keyId, key))
        .then(async () => resolveFrame(await sender.encrypt(new Uint8Array([9, keyId, 9]).buffer)));
    });

    fetchChannelDeviceLists.mockImplementation(listsWhileIdentityChanged('y'));
    await membershipCheck();
    await until(() => sealedTo('x').length >= 1 && markExcluded.mock.calls.some((call) => call[1] === 'y'));
    await settle();

    expect(recorded.length).toBeGreaterThan(0);
    for (const generation of recorded) {
      const frame = await generation.frame;
      expect(frame).not.toBeNull();
      expect(await opens(heldByY, frame!)).toBe(false);
    }
    const last = await recorded[recorded.length - 1].frame;
    expect(await opens(sealedTo('x'), last!)).toBe(true);
  });
});

describe('a membership check decides every exclusion before a retried vet is keyed', () => {
  /**
   * `y` keyed, `x` waiting on a retried vet, and a check whose answer excludes
   * `y`: no generation installed during that check opens with the keys `y`
   * held, and `x` is keyed with the last of them.
   */
  async function checkExcludingKeyedMemberBesideRetriedVet(answer: typeof ALL_MEMBERS): Promise<void> {
    await callWithOccupant();
    onParticipantJoined(CH, user('y'), { initialReplay: false });
    await until(() => sealedTo('y').length === 1);
    await arriveWithFailingVet('x');
    const heldByY = sealedTo('y');

    const recorded: Array<{ keyId: number; frame: Promise<ArrayBuffer | null> }> = [];
    frameSession.setLocalKey.mockImplementation((keyId: number, raw: Uint8Array) => {
      const key = raw.slice();
      installs.push({ keyId, key });
      let resolveFrame!: (frame: ArrayBuffer | null) => void;
      recorded.push({ keyId, frame: new Promise((resolve) => { resolveFrame = resolve; }) });
      senderReady = senderReady
        .then(() => sender.setKey(keyId, key))
        .then(async () => resolveFrame(await sender.encrypt(new Uint8Array([9, keyId, 9]).buffer)));
    });

    fetchChannelDeviceLists.mockResolvedValue(answer);
    await membershipCheck();
    await until(() => sealedTo('x').length >= 1 && frameSession.removeRemote.mock.calls.some((call) => call[0] === 'y'));
    await settle();

    // One fresh rotation for y's exclusion, then x keyed with it: no ratchet of a key y held
    expect(recorded.map((generation) => generation.keyId)).toEqual([2]);
    for (const generation of recorded) {
      const frame = await generation.frame;
      expect(frame).not.toBeNull();
      expect(await opens(heldByY, frame!)).toBe(false);
    }
    const last = await recorded[recorded.length - 1].frame;
    expect(await opens(sealedTo('x'), last!)).toBe(true);
  }

  it('a pinned device revoked in the same check', async () => {
    await checkExcludingKeyedMemberBesideRetriedVet({ ...ALL_MEMBERS, lists: new Map([['y', deviceListFor('z')]]) });
    expect(markExcluded).toHaveBeenCalledWith(CH, 'y', 'device-revoked');
  });

  it('a removal from the channel in the same check', async () => {
    await checkExcludingKeyedMemberBesideRetriedVet({
      ...ALL_MEMBERS,
      members: ALL_MEMBERS.members.filter((m) => m.userId !== 'y'),
    });
    // Removed without a notice, as before
    expect(markExcluded).not.toHaveBeenCalledWith(CH, 'y', expect.anything());
  });
});

describe('a member excluded during a call stays excluded until they start a new session', () => {
  const refusals = (id: string) =>
    warn.mock.calls.filter((args) => String(args[0]).includes(`${id} was excluded in this session`)).length;
  const sealCount = (id: string) => encryptToDevice.mock.calls.filter((call) => call[0] === id).length;

  /** Every way a participant can be named again without a new epoch, and what must not follow. */
  async function expectNotKeyedAgain(id: string, epoch: string, deviceId: string): Promise<void> {
    const seals = sealCount(id);
    const installed = installs.length;
    const refused = refusals(id);
    // An occupant list naming them again
    onParticipantJoined(CH, { id, deviceId, epoch }, { initialReplay: true });
    // A plain re-announcement of the same session
    onParticipantJoined(CH, { id, deviceId, epoch }, { initialReplay: false });
    // An announcement with no epoch at all
    onParticipantJoined(CH, { id, deviceId }, { initialReplay: false });
    // Settled once all three are refused, or once any of them was keyed
    await until(() => refusals(id) === refused + 3 || sealCount(id) > seals);
    // ...and their key requests
    handleKeyRequest(CH, id);
    await membershipCheck();
    await settle();
    expect(sealCount(id)).toBe(seals);
    expect(installs.length).toBe(installed);
  }

  it('excluded at their first vet, before our first frame: named again by an occupant list before and after it, they are not keyed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const session = await begin();
      onParticipantJoined(CH, user('old'), { initialReplay: true });
      // Listed on a device their verified list does not hold: excluded
      onParticipantJoined(CH, user('x', 'epoch-x-1', 'device-unlisted1'), { initialReplay: true });
      await until(() => sealedTo('old').length === 1 && error.mock.calls.some((args) => String(args[0]).includes('Vetting x failed')));

      // Before our first frame
      await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
      session.frames.attachSender({} as RTCRtpSender);
      // After it
      await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
    } finally {
      error.mockRestore();
    }
  });

  it('excluded for a key payload that is not an envelope: the exclusion rotates fresh, and they are not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);

    handleInboundKey(CH, 'x', DEVICES.x[0], '{"keyB64":"not-an-envelope"}');
    await until(() => installs.length === 3);
    expect(hex(installs[2].key)).not.toBe(hex(await ratchetVoiceKey(installs[1].key)));

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('excluded for an identity change found by the membership check: not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);

    fetchChannelDeviceLists.mockImplementationOnce(listsWhileIdentityChanged('x'));
    confirmMembership(CH);
    await until(() => installs.length === 3);

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('excluded for a revoked device: not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);

    // Their pinned device is no longer published
    fetchChannelDeviceLists.mockResolvedValueOnce({ ...ALL_MEMBERS, lists: new Map([['x', deviceListFor('y')]]) });
    confirmMembership(CH);
    await until(() => installs.length === 3);

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  const excludedAs = (id: string, kind: string) =>
    markExcluded.mock.calls.some((call) => call[0] === CH && call[1] === id && call[2] === kind);

  it('excluded for a failed vet at the membership check: not keyed again under the same epoch', async () => {
    await callWithOccupant();
    await arriveWithFailingVet('x');
    // At the check, their verified list does not hold the device they announced
    fetchDeviceList.mockResolvedValueOnce(deviceListFor('y'));

    await membershipCheck();
    await until(() => excludedAs('x', 'binding-mismatch'));

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('excluded for an identity change found while sealing their first key: no rotation, and not keyed again under the same epoch', async () => {
    await callWithOccupant();
    encryptToDevice.mockImplementationOnce(async () => {
      throw new TestIdentityChangedError('x');
    });

    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => excludedAs('x', 'identity-changed'));
    await settle();
    // The arrival ratchet only: their first key never reached them
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('excluded for an identity change found while resealing at their key request: one fresh rotation, and not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    encryptToDevice.mockImplementationOnce(async () => {
      throw new TestIdentityChangedError('x');
    });

    handleKeyRequest(CH, 'x');
    await until(() => excludedAs('x', 'identity-changed') && installs.length === 3);
    await settle();

    // A fresh key, not a ratchet of the one they held, sealed to the member who stays
    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2]);
    expect(hex(installs[2].key)).not.toBe(hex(await ratchetVoiceKey(installs[1].key)));
    expect(sealedTo('old').at(-1)).toMatchObject({ keyId: 2, reason: 'fresh' });
    // Their first key and the reseal that failed; the fresh key is not theirs
    expect(sealedTo('x').map((s) => s.keyId)).toEqual([1, 1]);

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('excluded for an identity change found while sealing a fresh rotation: no further rotation, and not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    onParticipantJoined(CH, user('y'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1 && sealedTo('y').length === 1);
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    encryptToDevice.mockImplementation(async (userId: string) => {
      if (userId === 'y') throw new TestIdentityChangedError('y');
      return ENV;
    });

    // `old` leaves: a fresh rotation for x and y
    onParticipantLeft(CH, 'old');
    await until(() => excludedAs('y', 'identity-changed'));
    await settle();
    const afterRotation = await speak(1);

    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2]);
    expect(sealedTo('x').at(-1)).toMatchObject({ keyId: 2, reason: 'fresh' });
    expect(await opens([sealedTo('x').at(-1)!], afterRotation)).toBe(true);
    // The rotation's key never reached y, and their earlier key opens nothing after it
    expect(await opens([sealedTo('y')[0]], afterRotation)).toBe(false);

    encryptToDevice.mockResolvedValue(ENV);
    await expectNotKeyedAgain('y', 'epoch-y-1', DEVICES.y[0]);
  });

  it('excluded for an identity change on an inbound key: the exclusion rotates fresh, and they are not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    decryptFromDevice.mockRejectedValueOnce(new TestIdentityChangedError('x'));

    handleInboundKey(CH, 'x', DEVICES.x[0], ENV);
    await until(() => installs.length === 3);

    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('removed from the channel: the removal rotates fresh, and they are not keyed again under the same epoch', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    fetchChannelDeviceLists.mockResolvedValueOnce({
      ...ALL_MEMBERS,
      members: ALL_MEMBERS.members.filter((m) => m.userId !== 'x'),
    });

    confirmMembership(CH);
    await until(() => installs.length === 3);

    // Listed as a member again, but under the session that was removed
    await expectNotKeyedAgain('x', 'epoch-x-1', DEVICES.x[0]);
  });

  it('announced with a new epoch, an excluded participant is vetted again and keyed past their arrival generation', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    handleInboundKey(CH, 'x', DEVICES.x[0], '{"keyB64":"not-an-envelope"}');
    await until(() => installs.length === 3);
    const beforeNewSession = await speak(1);

    onParticipantJoined(CH, user('x', 'epoch-x-2'), { initialReplay: false });
    await until(() => sealedTo('x').length === 2);
    const afterNewSession = await speak(2);

    expect(fetchDeviceList.mock.calls.filter((call) => call[0] === 'x')).toHaveLength(2);
    const sealed = sealedTo('x')[1];
    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2, 3]);
    expect(sealed.keyId).toBe(3);
    await expectClosedTo(sealed, beforeNewSession, 2);
    expect(await opens([sealed], afterNewSession)).toBe(true);
  });

  it('excluded for an identity change at the membership check, then announced with a new epoch whose first vet fails transiently: vetted and keyed at a later check', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    fetchChannelDeviceLists.mockImplementationOnce(listsWhileIdentityChanged('x'));
    confirmMembership(CH);
    await until(() => installs.length === 3);
    const beforeNewSession = await speak(1);

    await arriveWithFailingVet('x', 'epoch-x-2');
    await membershipCheck();
    await until(() => sealedTo('x').length === 2);
    const afterKeying = await speak(2);

    const sealed = sealedTo('x')[1];
    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2, 3]);
    expect(sealed.keyId).toBe(3);
    await expectClosedTo(sealed, beforeNewSession, 2);
    expect(await opens([sealed], afterKeying)).toBe(true);
  });

  it('a participant who left, with no exclusion, is keyed again when announced again', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    onParticipantLeft(CH, 'x');
    await until(() => installs.length === 3);
    const whileAway = await speak(1);

    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 2);

    expect(refusals('x')).toBe(0);
    const sealed = sealedTo('x')[1];
    expect(sealed.keyId).toBe(3);
    await expectClosedTo(sealed, whileAway, 2);
  });
});

describe('a departure naming the epoch of the session that left', () => {
  const keyOfX = (epoch: string, seq: number) => buildVoiceKeyPlaintext({
    v: 1,
    scope: e2eVoiceScope(CH),
    senderUserId: 'x',
    senderDeviceId: DEVICES.x[0],
    epoch,
    recipientEpoch: myEpoch,
    seq,
    keyId: 0,
    keyB64: 'A'.repeat(43),
    reason: 'initial',
  });

  /** `x` keyed in a first session, then announced again in a second one. */
  async function xInSecondSession(): Promise<void> {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    onParticipantJoined(CH, user('x', 'epoch-x-2'), { initialReplay: false });
    await until(() => sealedTo('x').length === 2);
    await settle();
  }

  it('a late departure of their previous session keeps the new one: no rotation, and their new keys still install', async () => {
    await xInSecondSession();
    const installed = installs.length;
    const removals = frameSession.removeRemote.mock.calls.length;

    onParticipantLeft(CH, 'x', 'epoch-x-1');
    await settle();

    expect(installs.length).toBe(installed);
    expect(frameSession.removeRemote.mock.calls.length).toBe(removals);
    decryptFromDevice.mockResolvedValueOnce(keyOfX('epoch-x-2', 0));
    handleInboundKey(CH, 'x', DEVICES.x[0], ENV);
    await until(() => frameSession.setRemoteKey.mock.calls.some((call) => call[0] === 'x'));
    // ...and their key request is answered with the generation they hold
    const seals = sealedTo('x').length;
    handleKeyRequest(CH, 'x');
    await until(() => sealedTo('x').length === seals + 1);
    expect(sealedTo('x').at(-1)!.keyId).toBe(sealedTo('x')[1].keyId);
  });

  it('a departure queued behind the announcement of their new session is judged against the new one', async () => {
    await callWithOccupant();
    onParticipantJoined(CH, user('x'), { initialReplay: false });
    await until(() => sealedTo('x').length === 1);
    const removals = frameSession.removeRemote.mock.calls.length;

    // Both reach the session before either step runs
    onParticipantJoined(CH, user('x', 'epoch-x-2'), { initialReplay: false });
    onParticipantLeft(CH, 'x', 'epoch-x-1');
    await until(() => sealedTo('x').length === 2);
    await settle();

    // The re-announcement's own departure of the first session only: x stays, in the new session
    expect(frameSession.removeRemote.mock.calls.length).toBe(removals + 1);
    decryptFromDevice.mockResolvedValueOnce(keyOfX('epoch-x-2', 0));
    handleInboundKey(CH, 'x', DEVICES.x[0], ENV);
    await until(() => frameSession.setRemoteKey.mock.calls.some((call) => call[0] === 'x'));
  });

  it('a departure of the session held removes them and rotates fresh, as one without an epoch does', async () => {
    await xInSecondSession();
    const installed = installs.length;

    onParticipantLeft(CH, 'x', 'epoch-x-2');
    await until(() => installs.length === installed + 1);
    await settle();

    expect(hex(installs.at(-1)!.key)).not.toBe(hex(await ratchetVoiceKey(installs.at(-2)!.key)));
    expect(sealedTo('x').some((sealed) => sealed.keyId === installs.at(-1)!.keyId)).toBe(false);
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
