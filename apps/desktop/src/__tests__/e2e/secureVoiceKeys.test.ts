import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildVoiceKeyPlaintext, e2eVoiceScope } from '@voxium/shared';
import { ratchetVoiceKey } from '../../services/e2e/voiceFrameCipher';

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

type ChannelDeviceLists = {
  members: Array<{ userId: string; isCreator: boolean }>;
  lists: Map<string, ReturnType<typeof deviceListFor>>;
  unverifiableUserIds: string[];
};

/**
 * The channel device lists as the service answers them while the identity
 * change of `changed` is not accepted: the default call fails on the first of
 * them, a collecting call names them and lists everyone else.
 */
function answerWithIdentityChanges(changed: string[], lists: ChannelDeviceLists) {
  return async (_channelId: string, opts?: { collectIdentityChanges?: boolean }) => {
    if (!opts?.collectIdentityChanges) throw new E2EIdentityChangedError(changed[0]);
    return {
      ...lists,
      lists: new Map([...lists.lists].filter(([userId]) => !changed.includes(userId))),
      identityChangedUserIds: changed,
    };
  };
}

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

  it('a newcomer whose membership refetch fails on another member\'s identity change stays unvetted, and is keyed at the next membership check', async () => {
    await begunSession();
    // The refetch for the newcomer: the list fails on the identity change of a member already known
    fetchChannelDeviceLists.mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onParticipantJoined(CH, { id: 'newcomer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false });
      await vi.waitFor(() =>
        expect(warn.mock.calls.some((args) => String(args[0]).includes('Vetting newcomer failed transiently'))).toBe(true));

      expect(markExcluded).not.toHaveBeenCalled();
      expect(encryptToDevice).not.toHaveBeenCalled();
      expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
      expect(flagIdentityChanged).not.toHaveBeenCalledWith('newcomer');

      fetchChannelDeviceLists.mockResolvedValue({
        members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'newcomer', isCreator: false }],
        lists: new Map(),
        unverifiableUserIds: [],
      });
      confirmMembership(CH);
      await vi.waitFor(() =>
        expect(encryptToDevice).toHaveBeenCalledWith('newcomer', PEER_DEVICE, expect.stringContaining('"reason":"ratchet"')));
      expect(markExcluded).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('at a later check, a participant the list no longer names leaves as a non-member, not for another member\'s identity change', async () => {
    await begunSession();
    const withNewcomer = {
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'newcomer', isCreator: false }],
      lists: new Map(),
      unverifiableUserIds: [],
    };
    // Listed by the refetch at their arrival, but their first vet fails transiently
    fetchChannelDeviceLists.mockResolvedValueOnce(withNewcomer);
    fetchDeviceList.mockRejectedValueOnce(new Error('Network Error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onParticipantJoined(CH, { id: 'newcomer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false });
      await vi.waitFor(() =>
        expect(warn.mock.calls.some((args) => String(args[0]).includes('Vetting newcomer failed transiently'))).toBe(true));

      // The check's list no longer names them, and the refetch fails on another member's identity change
      fetchChannelDeviceLists
        .mockResolvedValueOnce({ ...withNewcomer, members: withNewcomer.members.filter((m) => m.userId !== 'newcomer') })
        .mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
      frameSession.setLocalKey.mockClear();
      confirmMembership(CH);
      // Removed as a non-member: a fresh rotation, with no identity verdict on them
      await vi.waitFor(() => expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array)));

      expect(frameSession.removeRemote).toHaveBeenCalledWith('newcomer');
      expect(markExcluded).not.toHaveBeenCalledWith(CH, 'newcomer', 'identity-changed');
      expect(encryptToDevice).not.toHaveBeenCalledWith('newcomer', expect.anything(), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('a newcomer whose own identity change fails the membership refetch is excluded, and the change is flagged', async () => {
    await begunSession();
    fetchChannelDeviceLists.mockRejectedValueOnce(new E2EIdentityChangedError('newcomer'));
    onParticipantJoined(CH, { id: 'newcomer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false });
    await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'newcomer', 'identity-changed'));

    expect(flagIdentityChanged).toHaveBeenCalledWith('newcomer');
    expect(encryptToDevice).not.toHaveBeenCalled();
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

  it('an identity change found by the retry of a seal is flagged and excludes the peer, as one found by the first attempt', async () => {
    await begunSession();
    encryptToDevice
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockRejectedValueOnce(new E2EIdentityChangedError('peer'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
      await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed'));

      expect(encryptToDevice).toHaveBeenCalledTimes(2);
      expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
      expect(socketEmit).not.toHaveBeenCalledWith('voice:e2e:key', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('a key step the logout overtook ends quietly instead of reporting a key failure', async () => {
    await begunSession();
    const ended = new Error('E2E service disposed');
    ended.name = 'E2EServiceDisposedError';
    fetchChannelDeviceLists.mockRejectedValueOnce(ended);
    const error = vi.spyOn(console, 'error');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      confirmMembership(CH);
      await flush();
      expect(error.mock.calls.flat().map(String).join('\n')).not.toMatch(/Key chain step failed/);
      expect(debug).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      debug.mockRestore();
    }
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

  it('once a buffered payload excludes its sender, the rest of their buffer is not processed', async () => {
    await begunSession();
    decryptFromDevice.mockResolvedValue(peerKeyPlaintext({ seq: 0 }));
    // Both arrive before the participant event: a payload that is not an envelope, then a sealed key
    handleInboundKey(CH, 'peer', PEER_DEVICE, '{"keyB64":"plaintext-key"}');
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();

    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    // The exclusion rotates fresh; the step ends after it
    await vi.waitFor(() => expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array)));
    await flush();

    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'legacy-key');
    expect(decryptFromDevice).not.toHaveBeenCalled();
    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
  });

  it('a sender excluded by one of their buffered keys at a later vet: one rotation, and nothing of theirs installed', async () => {
    await begunSession();
    fetchDeviceList.mockRejectedValueOnce(new Error('Network Error'));
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    // Buffered while they are not vetted: the first fails its identity pin, the second is a valid key
    decryptFromDevice
      .mockRejectedValueOnce(new E2EIdentityChangedError('peer'))
      .mockResolvedValue(peerKeyPlaintext({ seq: 0 }));
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    handleInboundKey(CH, 'peer', PEER_DEVICE, ENV);
    await flush();
    frameSession.setLocalKey.mockClear();

    confirmMembership(CH);
    await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed'));
    await flush();

    expect(decryptFromDevice).toHaveBeenCalledTimes(1);
    expect(frameSession.setRemoteKey).not.toHaveBeenCalled();
    expect(frameSession.setLocalKey).toHaveBeenCalledTimes(1);
    expect(markExcluded).toHaveBeenCalledTimes(1);
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

  it('an identity change found by the periodic re-check excludes the participant and rotates fresh', async () => {
    await withVettedPeer();
    frameSession.setLocalKey.mockClear();
    fetchChannelDeviceLists.mockImplementationOnce(answerWithIdentityChanges(['peer'], {
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }],
      lists: new Map([['peer', deviceListFor(PEER_DEVICE)]]),
      unverifiableUserIds: [],
    }));

    confirmMembership(CH);
    await vi.waitFor(() => expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array)));

    expect(fetchChannelDeviceLists).toHaveBeenLastCalledWith(CH, { collectIdentityChanges: true });
    expect(flagIdentityChanged).toHaveBeenCalledWith('peer');
    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledTimes(1);
  });

  it('a member not in the call whose identity change is unaccepted does not stop the re-check: a revoked device is still excluded', async () => {
    await withVettedPeer();
    frameSession.setLocalKey.mockClear();
    // `absent` is a member of the channel who is not in the call
    fetchChannelDeviceLists.mockImplementation(answerWithIdentityChanges(['absent'], {
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'absent', isCreator: false }],
      lists: new Map([['peer', deviceListFor('device-replaced1')], ['absent', deviceListFor('device-absent01')]]),
      unverifiableUserIds: [],
    }));

    confirmMembership(CH);
    await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'device-revoked'));

    expect(flagIdentityChanged).toHaveBeenCalledWith('absent');
    expect(markExcluded).not.toHaveBeenCalledWith(CH, 'absent', expect.anything());
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.setLocalKey).toHaveBeenCalledWith(1, expect.any(Uint8Array));
  });

  it('in one re-check, a participant whose identity changed and one whose device was revoked are both excluded, each with its fresh rotation', async () => {
    await begunSession();
    const members = [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'other', isCreator: false }];
    fetchDeviceList.mockImplementation(async (userId: string) =>
      userId === 'other' ? deviceListFor('device-other001') : deviceListFor(PEER_DEVICE));
    fetchChannelDeviceLists.mockResolvedValue({ members, lists: new Map(), unverifiableUserIds: [] });
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    onParticipantJoined(CH, { id: 'other', deviceId: 'device-other001', epoch: PEER_EPOCH }, { initialReplay: true });
    await vi.waitFor(() => expect(encryptToDevice).toHaveBeenCalledTimes(2));
    frameSession.setLocalKey.mockClear();

    // One answer: peer's identity change is not accepted, and other's pinned device is no longer published
    fetchChannelDeviceLists.mockImplementationOnce(answerWithIdentityChanges(['peer'], {
      members,
      lists: new Map([['peer', deviceListFor(PEER_DEVICE)], ['other', deviceListFor('device-replaced1')]]),
      unverifiableUserIds: [],
    }));
    confirmMembership(CH);
    await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'other', 'device-revoked'));
    await flush();

    expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('peer');
    expect(frameSession.removeRemote).toHaveBeenCalledWith('other');
    expect(frameSession.setLocalKey.mock.calls.map((call) => call[0])).toEqual([1, 2]);
  });

  it('while another member\'s identity change stays unaccepted, a participant whose vet failed transiently is vetted and keyed at the re-check', async () => {
    await begunSession();
    fetchDeviceList.mockRejectedValueOnce(new Error('Network Error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
      await vi.waitFor(() =>
        expect(warn.mock.calls.some((args) => String(args[0]).includes('Vetting peer failed transiently'))).toBe(true));
      fetchChannelDeviceLists.mockImplementation(answerWithIdentityChanges(['absent'], {
        members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'absent', isCreator: false }],
        lists: new Map([['peer', deviceListFor(PEER_DEVICE)], ['absent', deviceListFor('device-absent01')]]),
        unverifiableUserIds: [],
      }));

      confirmMembership(CH);
      await vi.waitFor(() =>
        expect(encryptToDevice).toHaveBeenCalledWith('peer', PEER_DEVICE, expect.stringContaining('"reason":"fresh"')));
      expect(markExcluded).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

  it('an identity change that stays unaccepted leaves every later re-check running for the others', async () => {
    await begunSession();
    fetchDeviceList.mockImplementation(async (userId: string) =>
      userId === 'other' ? deviceListFor('device-other001') : deviceListFor(PEER_DEVICE));
    fetchChannelDeviceLists.mockResolvedValue({
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'other', isCreator: false }],
      lists: new Map(),
      unverifiableUserIds: [],
    });
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    onParticipantJoined(CH, { id: 'other', deviceId: 'device-other001', epoch: PEER_EPOCH }, { initialReplay: true });
    await vi.waitFor(() => expect(encryptToDevice).toHaveBeenCalledTimes(2));

    // Peer's identity change is not accepted, on this tick or the next
    const everyone = {
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'other', isCreator: false }],
      lists: new Map([['peer', deviceListFor(PEER_DEVICE)], ['other', deviceListFor('device-other001')]]),
      unverifiableUserIds: [],
    };
    fetchChannelDeviceLists.mockImplementation(answerWithIdentityChanges(['peer'], everyone));
    confirmMembership(CH);
    await vi.waitFor(() => expect(markExcluded).toHaveBeenCalledWith(CH, 'peer', 'identity-changed'));

    // The next tick no longer lists `other`: their removal is still noticed
    fetchChannelDeviceLists.mockImplementation(answerWithIdentityChanges(['peer'], {
      ...everyone,
      members: everyone.members.filter((m) => m.userId !== 'other'),
    }));
    frameSession.setLocalKey.mockClear();
    confirmMembership(CH);
    await vi.waitFor(() => expect(frameSession.removeRemote).toHaveBeenCalledWith('other'));
    await vi.waitFor(() => expect(frameSession.setLocalKey).toHaveBeenCalledTimes(1));
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

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * What the frame worker is handed, captured at hand-over. The worker gets a
 * structured clone of the bytes; the module keeps its own array and zero-fills
 * it at teardown, so the bytes are copied here and the array is kept to look at.
 */
function recordInstalls() {
  const installs: Array<{ keyId: number; hex: string; raw: Uint8Array }> = [];
  frameSession.setLocalKey.mockImplementation((keyId: number, raw: Uint8Array) => {
    installs.push({ keyId, hex: toHex(raw), raw });
  });
  return installs;
}

/** The sealed key plaintexts handed to Olm, in order. */
function sealedKeys(): Array<{ keyId: number; keyB64: string; reason: string }> {
  return encryptToDevice.mock.calls.map((call) => JSON.parse(call[2] as string));
}

describe('every key the session installs is new (the frame cipher restarts its IV counter on each)', () => {
  afterEach(() => {
    frameSession.setLocalKey.mockReset();
  });

  it('arrival, departure and counter exhaustion each install a new key under the next keyId', async () => {
    const installs = recordInstalls();
    await begunSession();
    fetchChannelDeviceLists.mockResolvedValue({
      members: [{ userId: 'me', isCreator: true }, { userId: 'peer', isCreator: false }, { userId: 'other', isCreator: false }],
      lists: new Map(),
      unverifiableUserIds: [],
    });
    fetchDeviceList.mockImplementation(async (userId: string) =>
      userId === 'other' ? deviceListFor('device-other001') : deviceListFor(PEER_DEVICE));

    onParticipantJoined(CH, { id: 'other', deviceId: 'device-other001', epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false }); // ratchet
    await flush();
    onParticipantLeft(CH, 'peer'); // fresh
    await flush();
    const counterLow = frameSession.onCounterLow.mock.calls[0][0] as () => void;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      counterLow(); // fresh
      await flush();
    } finally {
      log.mockRestore();
    }
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false }); // ratchet
    await flush();

    expect(installs.map((i) => i.keyId)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(installs.map((i) => i.hex)).size).toBe(5);
    // An arrival installs exactly the ratchet of the key before it...
    expect(installs[1].hex).toBe(toHex(await ratchetVoiceKey(fromHex(installs[0].hex))));
    expect(installs[4].hex).toBe(toHex(await ratchetVoiceKey(fromHex(installs[3].hex))));
    // ...and a departure or an exhausted counter a key unrelated to it
    expect(installs[2].hex).not.toBe(toHex(await ratchetVoiceKey(fromHex(installs[1].hex))));
    expect(installs[3].hex).not.toBe(toHex(await ratchetVoiceKey(fromHex(installs[2].hex))));
  });

  it('an exhausted counter rotates to a fresh key, sealed to every peer before frames switch', async () => {
    const installs = recordInstalls();
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: true });
    await flush();
    encryptToDevice.mockClear();
    frameSession.setLocalKey.mockClear();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      (frameSession.onCounterLow.mock.calls[0][0] as () => void)();
      await flush();
    } finally {
      log.mockRestore();
    }

    const sealed = sealedKeys();
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ keyId: 1, reason: 'fresh' });
    expect(installs.at(-1)).toMatchObject({ keyId: 1 });
    expect(installs.at(-1)!.hex).not.toBe(installs[0].hex);
    expect(frameSession.setLocalKey.mock.invocationCallOrder[0]).toBeGreaterThan(encryptToDevice.mock.invocationCallOrder[0]);
  });

  it('a session restart installs a key unlike any of the last session, and teardown wipes the current key', async () => {
    const installs = recordInstalls();
    await begunSession();
    onParticipantJoined(CH, { id: 'peer', deviceId: PEER_DEVICE, epoch: PEER_EPOCH }, { initialReplay: false });
    await flush();
    expect(installs.map((i) => i.keyId)).toEqual([0, 1]);
    const current = installs[1].raw;

    endSecureVoiceSession(CH);
    expect(current.every((b) => b === 0)).toBe(true);

    await begunSession();
    const restarted = installs.at(-1)!;
    expect(restarted.keyId).toBe(0);
    expect(installs.slice(0, 2).map((i) => i.hex)).not.toContain(restarted.hex);
  });
});
