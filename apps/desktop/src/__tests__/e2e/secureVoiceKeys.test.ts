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

  it('a SUPERSEDED epoch never returns', async () => {
    await withVettedPeer();
    decryptFromDevice
      .mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'epochA0000001', seq: 0 }))
      .mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'epochB0000001', seq: 0, keyId: 1 }))
      .mockResolvedValueOnce(peerKeyPlaintext({ epoch: 'epochA0000001', seq: 5, keyId: 2 }));

    for (let i = 0; i < 3; i++) handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledTimes(2);
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
    // A co-present member floods well-formed envelopes before anyone is vetted
    for (let i = 0; i < 12; i++) handleInboundKey(CH, 'flooder', 'device-flood001', ENV);
    // The honest sender's key arrives after the flood
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    decryptFromDevice.mockResolvedValueOnce(peerKeyPlaintext({ seq: 0 }));

    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();

    expect(frameSession.setRemoteKey).toHaveBeenCalledWith('peer', 0, expect.any(Uint8Array));
  });

  it('a peer joining without an epoch is never keyed (un-updated client)', async () => {
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE }, { initialReplay: true });
    await flush();

    expect(encryptToDevice).not.toHaveBeenCalled();
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
