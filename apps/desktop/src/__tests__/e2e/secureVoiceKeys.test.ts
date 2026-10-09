import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildVoiceKeyPlaintext, e2eVoiceScope } from '@voxium/shared';

/**
 * secureVoiceKeys is the binding layer between voice membership events and
 * media-key state (spec §21). What must hold HERE: authoritative-list +
 * device vetting before any key leaves, ratchet-on-arrival vs fresh-on-
 * departure, epoch/seq replay windows on inbound keys, the legacy-key hard
 * cutover, and identity-error exclusion. The cipher itself has its own tests.
 */

const fetchChannelDeviceLists = vi.fn();
const fetchDeviceList = vi.fn();
const encryptToDevice = vi.fn();
const decryptFromDevice = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({
      deviceId: 'device-me000001',
      fetchChannelDeviceLists,
      fetchDeviceList,
      encryptToDevice,
      decryptFromDevice,
    }),
  };
});

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
const supported = vi.hoisted(() => ({ value: true }));
vi.mock('../../services/e2e/voiceFrameTransform', () => ({
  isSecureVoiceSupported: () => supported.value,
  createFrameCryptoSession: vi.fn(() => frameSession),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me' } }) },
}));
const flagIdentityChanged = vi.fn();
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ flagIdentityChanged }) },
}));
const markExcluded = vi.fn();
const clearIssue = vi.fn();
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ markSecureVoicePeerExcluded: markExcluded, clearSecureVoicePeerIssue: clearIssue }) },
}));

import {
  beginSecureVoiceSession,
  endSecureVoiceSession,
  onParticipantJoined,
  onParticipantLeft,
  handleInboundKey,
  handleKeyRequest,
  confirmMembership,
  SecureVoiceError,
  E2EIdentityChangedError,
} from '../../services/e2e/secureVoiceKeys';

const CH = 'chan-1';
const PEER_DEVICE = 'device-peer0001';
const PEER_EPOCH = 'peerEpoch0001';
const KEY_B64 = 'A'.repeat(43);
/** OUR session epoch — peers must echo it back as recipientEpoch. */
let myEpoch = '';

const flush = async () => {
  // The session chain nests dynamic imports + async steps — settle generously
  // (a 2-round flush was observed to race under parallel-worker contention)
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function deviceListFor(deviceId: string) {
  return {
    devices: [{ deviceId, curve25519Key: 'c', ed25519Key: 'e', verified: false, crossSigned: true }],
    servedDeviceCount: 1,
    listVersion: 1,
    masterKey: null,
  };
}

function peerKeyPlaintext(over: Partial<Parameters<typeof buildVoiceKeyPlaintext>[0]> = {}): string {
  return buildVoiceKeyPlaintext({
    v: 1,
    scope: e2eVoiceScope(CH),
    senderUserId: 'peer',
    senderDeviceId: PEER_DEVICE,
    epoch: PEER_EPOCH,
    recipientEpoch: myEpoch,
    seq: 0,
    keyId: 0,
    keyB64: KEY_B64,
    reason: 'initial',
    ...over,
  });
}

const ENV = '{"v":1,"e":"olm1","t":0,"b":"Zg"}';

async function begunSession() {
  fetchChannelDeviceLists.mockResolvedValue({ members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }], lists: new Map(), unverifiableUserIds: [] });
  fetchDeviceList.mockResolvedValue(deviceListFor(PEER_DEVICE));
  encryptToDevice.mockResolvedValue(ENV);
  const session = await beginSecureVoiceSession(CH);
  myEpoch = session.epoch;
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  supported.value = true;
  endSecureVoiceSession(CH);
  vi.clearAllMocks(); // drop the teardown's destroy() call from the record
});

describe('beginSecureVoiceSession', () => {
  it('fetches the authoritative list, creates the frame session, installs key 0', async () => {
    const { deviceId } = await begunSession();
    expect(deviceId).toBe('device-me000001');
    expect(fetchChannelDeviceLists).toHaveBeenCalledWith(CH);
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(0, expect.any(Uint8Array));
  });

  it('throws unsupported-platform when transforms are unavailable — the join must abort', async () => {
    supported.value = false;
    await expect(beginSecureVoiceSession(CH)).rejects.toMatchObject({ kind: 'unsupported-platform' });
  });
});

describe('participant lifecycle', () => {
  it('initial replay: vets the peer and seals the CURRENT key (no ratchet)', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(fetchDeviceList).toHaveBeenCalledWith('peer', true);
    expect(encryptToDevice).toHaveBeenCalledWith('peer', PEER_DEVICE, expect.stringContaining('"reason":"initial"'));
    expect(socketEmit).toHaveBeenCalledWith('voice:e2e:key', { to: 'peer', envelope: ENV });
    // No ratchet for occupants seen during our own join
    expect(frameSession.setLocalKey).toHaveBeenCalledTimes(1);
  });

  it('genuine ARRIVAL ratchets our key and seals the post-ratchet key to the joiner', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false });
    await flush();

    expect(frameSession.setLocalKey).toHaveBeenLastCalledWith(1, expect.any(Uint8Array));
    const sealed = encryptToDevice.mock.calls[0][2] as string;
    expect(sealed).toContain('"reason":"ratchet"');
    expect(sealed).toContain('"keyId":1');
  });

  it('DEPARTURE mints a fresh key, seals to the REMAINING peers, then switches frames', async () => {
    await begunSession();
    fetchChannelDeviceLists.mockResolvedValue({
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'other', isCreator: false }],
      lists: new Map(),
      unverifiableUserIds: [],
    });
    fetchDeviceList.mockImplementation(async (userId: string) =>
      userId === 'other' ? deviceListFor('device-other001') : deviceListFor(PEER_DEVICE));
    onParticipantJoined(CH, { id: 'other', deviceId: 'device-other001', epoch: PEER_EPOCH }, { initialReplay: true });
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    encryptToDevice.mockClear();
    frameSession.setLocalKey.mockClear();

    onParticipantLeft(CH, 'peer');
    await flush();

    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    // Fresh key sealed ONLY to the survivor
    expect(encryptToDevice).toHaveBeenCalledTimes(1);
    expect(encryptToDevice).toHaveBeenCalledWith('other', 'device-other001', expect.stringContaining('"reason":"fresh"'));
    // Frames switch AFTER the seal (call order)
    const sealOrder = encryptToDevice.mock.invocationCallOrder[0];
    const switchOrder = frameSession.setLocalKey.mock.invocationCallOrder[0];
    expect(switchOrder).toBeGreaterThan(sealOrder);
  });

  it('a participant missing from the AUTHORITATIVE list is excluded (refetch once, fail closed)', async () => {
    await begunSession();
    fetchChannelDeviceLists.mockResolvedValue({ members: [{ userId: 'me', isCreator: true }], lists: new Map(), unverifiableUserIds: [] });
    onParticipantJoined(CH, { id: 'stranger', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(encryptToDevice).not.toHaveBeenCalled();
    expect(markExcluded).toHaveBeenCalledWith(CH, 'stranger', 'binding-mismatch');
  });

  it('a device outside the verified list is excluded (server-invented device)', async () => {
    await begunSession();
    fetchDeviceList.mockResolvedValue(deviceListFor('device-genuine1'));
    onParticipantJoined(CH, { id: 'peer', deviceId: 'device-imposter', epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(encryptToDevice).not.toHaveBeenCalled();
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'binding-mismatch');
  });

  it('an identity change while sealing flags the warning UX and excludes the peer', async () => {
    await begunSession();
    fetchDeviceList.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');
    expect(encryptToDevice).not.toHaveBeenCalled();
  });

  it('confirmMembership removes peers the endpoint no longer lists and rotates fresh', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    frameSession.setLocalKey.mockClear();

    fetchChannelDeviceLists.mockResolvedValue({ members: [{ userId: 'me', isCreator: true }], lists: new Map(), unverifiableUserIds: [] });
    confirmMembership(CH);
    await flush();

    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array));
  });
});

describe('inbound keys', () => {
  async function withVettedPeer() {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    frameSession.setRemoteKey.mockClear();
  }

  it('installs a bound key and enforces epoch/seq replay windows', async () => {
    await withVettedPeer();
    decryptFromDevice
      .mockResolvedValueOnce(peerKeyPlaintext({ seq: 0 }))
      .mockResolvedValueOnce(peerKeyPlaintext({ seq: 1, keyId: 1 }))
      .mockResolvedValueOnce(peerKeyPlaintext({ seq: 1, keyId: 1 }))   // replay
      .mockResolvedValueOnce(peerKeyPlaintext({ seq: 0 }));            // regression

    for (let i = 0; i < 4; i++) handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledTimes(2);
    expect(frameSession.setRemoteKey).toHaveBeenNthCalledWith(1, 'peer', 0, expect.any(Uint8Array));
    expect(frameSession.setRemoteKey).toHaveBeenNthCalledWith(2, 'peer', 1, expect.any(Uint8Array));
  });

  it('a key whose epoch is not the one the peer ANNOUNCED is dropped', async () => {
    await withVettedPeer();
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'otherEpoch01', seq: 0 }));

    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
  });

  it('a SUPERSEDED epoch never returns AFTER the peer restarts (history is session-scoped)', async () => {
    // The mirror of the recipientEpoch guard: a peer reconnect rebuilds their
    // PeerState, and if the epoch history went with it, an envelope withheld
    // from their PREVIOUS session would install a dead generation afterwards.
    await withVettedPeer();
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ epoch: PEER_EPOCH, seq: 0 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    expect(frameSession.setRemoteKey).toHaveBeenCalledTimes(1);

    // The peer reconnects: left + joined with a FRESH epoch
    onParticipantLeft(CH, 'peer');
    await flush();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: 'peerEpoch0002' }, { initialReplay: true });
    await flush();
    frameSession.setRemoteKey.mockClear();

    // Their new session's key installs...
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'peerEpoch0002', seq: 0, keyId: 1 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    expect(frameSession.setRemoteKey).toHaveBeenCalledTimes(1);

    // ...but the withheld envelope from the DEAD session never does
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ epoch: PEER_EPOCH, seq: 9, keyId: 7 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    expect(frameSession.setRemoteKey).toHaveBeenCalledTimes(1);
  });

  it('a re-announcement with a NEW epoch re-pins the peer instead of being ignored', async () => {
    await withVettedPeer();
    // No user_left in between (a reordered/duplicated event): the peer must
    // still be re-pinned, or their new session keys would fail the binding
    // for the rest of the call.
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: 'peerEpoch0003' }, { initialReplay: true });
    await flush();

    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'peerEpoch0003', seq: 0 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledWith('peer', 0, expect.any(Uint8Array));
  });

  it('drops keys with mismatched binding fields (scope, sender, device)', async () => {
    await withVettedPeer();
    for (const bad of [
      peerKeyPlaintext({ scope: e2eVoiceScope('other-channel') }),
      peerKeyPlaintext({ senderUserId: 'mallory' }),
      peerKeyPlaintext({ senderDeviceId: 'device-mallory1' }),
    ]) {
      decryptFromDevice.mockResolvedValueOnce(bad);
      handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    }
    await flush();

    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
  });

  it('HARD-REJECTS non-envelope key payloads: the sender is excluded (legacy-key)', async () => {
    await withVettedPeer();
    handleInboundKey(CH, 'peer', PEER_DEVICE, '{"keyB64":"plaintext-key"}');
    await flush();

    expect(decryptFromDevice).not.toHaveBeenCalled();
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'legacy-key');
  });

  it('BUFFERS keys from not-yet-vetted senders without touching Olm', async () => {
    await begunSession();
    handleInboundKey(CH, 'nobody', PEER_DEVICE, ENV);
    await flush();

    expect(decryptFromDevice).not.toHaveBeenCalled();
    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
  });

  it('a key that BEATS the participant event installs after the vet completes (delivery race)', async () => {
    await begunSession();
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ seq: 0 }));

    // The sealed key arrives FIRST — the joined event is still in flight
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();

    // The participant event lands, the vet passes, the buffer drains
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledWith('peer', 0, expect.any(Uint8Array));
  });

  it('key_request re-seals the current key to the requester', async () => {
    await withVettedPeer();
    encryptToDevice.mockClear();
    socketEmit.mockClear();

    handleKeyRequest(CH, 'peer');
    await flush();

    expect(encryptToDevice).toHaveBeenCalledWith('peer', PEER_DEVICE, expect.stringContaining('"reason":"fresh"'));
    expect(socketEmit).toHaveBeenCalledWith('voice:e2e:key', { to: 'peer', envelope: ENV });
  });
});

describe('cross-session and exclusion hardening', () => {
  async function withVettedPeer() {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    frameSession.setRemoteKey.mockClear();
  }

  it('REJECTS a key sealed to a previous session of ours (withheld-envelope replay)', async () => {
    await withVettedPeer();
    // Same peer, same device, unseen epoch, fresh seq — everything a stale
    // envelope from our last session would carry, EXCEPT our current epoch.
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ recipientEpoch: 'staleEpoch01', keyId: 7, seq: 9 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
  });

  it('seals our key with the RECIPIENT epoch each peer announced', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(encryptToDevice.mock.calls[0][2]).toContain(`"recipientEpoch":"${PEER_EPOCH}"`);
  });

  it('identity change on an inbound key ROTATES — the untrusted device loses future audio', async () => {
    await withVettedPeer();
    frameSession.setLocalKey.mockClear();
    decryptFromDevice.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));

    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array));
  });

  it('a REVOKED pinned device is excluded and triggers a fresh rotation', async () => {
    await withVettedPeer();
    frameSession.setLocalKey.mockClear();
    // Still a member, but the device we pinned is gone from their list
    fetchChannelDeviceLists.mockResolvedValue({
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }],
      lists: new Map([['peer', deviceListFor('device-replaced1')]]),
      unverifiableUserIds: [],
    });

    confirmMembership(CH);
    await flush();

    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'device-revoked');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array));
  });

  it('per-sender pending slots: a flooder cannot displace an honest sender key', async () => {
    await begunSession();
    // Well past the old FLAT 16-slot cap, so this fails if the buffer is
    // shared again rather than keyed per sender.
    for (let i = 0; i < 40; i++) handleInboundKey(CH, 'flooder', 'device-flood001', ENV);
    // The honest sender's key arrives after the flood
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ seq: 0 }));

    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledWith('peer', 0, expect.any(Uint8Array));
  });

  it('an identity change during the periodic re-check excludes + rotates instead of wedging', async () => {
    // fetchChannelDeviceLists verifies EVERY member, so one changed identity
    // throws for the whole call. Swallowing that would silently disable
    // membership AND revocation checking for the rest of the session.
    await withVettedPeer();
    frameSession.setLocalKey.mockClear();
    fetchChannelDeviceLists.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));

    confirmMembership(CH);
    await flush();

    expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array));
  });

  it('a departing member stops being reported as un-hearable', async () => {
    await withVettedPeer();
    onParticipantLeft(CH, 'peer');
    await flush();

    expect(clearIssue).toHaveBeenCalledWith(CH, 'peer');
  });

  it('an ALREADY-EXCLUDED member also stops being reported when they leave', async () => {
    await begunSession();
    fetchDeviceList.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    clearIssue.mockClear();

    // They are no longer in `peers`, so the badge must be cleared before the
    // "was this peer known?" early return.
    onParticipantLeft(CH, 'peer');
    await flush();

    expect(clearIssue).toHaveBeenCalledWith(CH, 'peer');
  });

  it('a TRANSIENT vet failure does not exclude — the next membership tick re-vets and keys them', async () => {
    await begunSession();
    // A 429/5xx/network blip must not be treated as a security verdict:
    // an excluded peer is never re-vetted, never sealed to, and their
    // key_requests are ignored — the pair goes mutually deaf for the call.
    fetchDeviceList.mockRejectedValueOnce(new Error('Network Error'));
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(markExcluded).not.toHaveBeenCalled();
    expect(encryptToDevice).not.toHaveBeenCalled();

    // The 60s poll retries the un-vetted peer and seals to them
    fetchDeviceList.mockResolvedValue(deviceListFor(PEER_DEVICE));
    confirmMembership(CH);
    await flush();

    expect(encryptToDevice).toHaveBeenCalledWith('peer', PEER_DEVICE, expect.stringContaining('"reason":"fresh"'));
  });

  it('an identity conflict does not wedge the poll for everyone, every tick', async () => {
    await withVettedPeer();
    fetchChannelDeviceLists.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
    confirmMembership(CH);
    await flush();
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');

    // The NEXT tick must run the membership/revocation body rather than dying
    // on the same member again.
    fetchChannelDeviceLists.mockResolvedValue({
      members: [{ userId: 'me', isCreator: true }, { userId: 'other', isCreator: false }],
      lists: new Map(),
      unverifiableUserIds: [],
    });
    confirmMembership(CH);
    await flush();

    expect(fetchChannelDeviceLists).toHaveBeenCalledTimes(3); // begin + 2 ticks
  });

  it('a peer joining without an epoch is never keyed (un-updated client)', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE }, { initialReplay: true });
    await flush();

    expect(encryptToDevice).not.toHaveBeenCalled();
  });
});

describe('decrypt watchdog (spec §21.4 lost-key healing)', () => {
  /** The callback beginSecureVoiceSession hands the frame worker. */
  function stallCb(): (senderUserId: string, stalled: boolean) => void {
    return frameSession.onDecryptStalled.mock.calls[0][0];
  }

  async function withVettedPeer() {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    socketEmit.mockClear();
  }

  it('a sustained stall asks the sender for a re-seal, then throttles', async () => {
    await withVettedPeer();
    const onStalled = stallCb();

    onStalled('peer', true);
    expect(socketEmit).toHaveBeenCalledWith('voice:e2e:key_request', { to: 'peer' });

    // A second report inside the cooldown must not re-ask
    socketEmit.mockClear();
    onStalled('peer', true);
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('a heal cancels the warning; an un-healed stall raises it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withVettedPeer();
      const onStalled = stallCb();

      // Healed before the grace period: no warning, and any existing one goes
      onStalled('peer', true);
      onStalled('peer', false);
      await flush();
      expect(clearIssue).toHaveBeenCalledWith(CH, 'peer');
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(markExcluded).not.toHaveBeenCalledWith(CH, 'peer', 'no-key');

      // Never healed: the member is surfaced as one we cannot hear
      onStalled('peer', true);
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'no-key');
    } finally {
      vi.useRealTimers();
    }
  });

  it('teardown disarms the watchdog timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withVettedPeer();
      stallCb()('peer', true);
      endSecureVoiceSession(CH);
      markExcluded.mockClear();

      vi.advanceTimersByTime(60_000);
      await flush();
      expect(markExcluded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('teardown', () => {
  it('endSecureVoiceSession destroys the frame session and silences the module', async () => {
    await begunSession();
    endSecureVoiceSession(CH);
    expect(frameSession.destroy).toHaveBeenCalled();

    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    expect(encryptToDevice).not.toHaveBeenCalled();
  });

  it('SecureVoiceError carries its kind', () => {
    expect(new SecureVoiceError('legacy-key', 'x').kind).toBe('legacy-key');
  });
});
