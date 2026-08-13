import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCallSignalPlaintext, type E2ECallSignal } from '@voxium/shared';

/**
 * callCrypto is the binding layer between WebRTC signaling and the Olm
 * primitives (which have their own live-crypto tests). What must hold HERE:
 * device vetting before any session, plaintext binding fields, epoch/seq
 * bookkeeping, the legacy-signal hard cutover, and identity-error surfacing.
 */

const fetchDeviceList = vi.fn();
const encryptToDevice = vi.fn();
const decryptFromDevice = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({
      deviceId: 'device-me000001',
      fetchDeviceList,
      encryptToDevice,
      decryptFromDevice,
    }),
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me' } }) },
}));

const flagIdentityChanged = vi.fn();
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ flagIdentityChanged }) },
}));

import {
  beginCallSignaling,
  endCallSignaling,
  getCallPeerDevice,
  encryptCallSignal,
  decryptCallSignal,
  CallSecurityError,
  E2EIdentityChangedError,
} from '../../services/e2e/callCrypto';

const PEER = { userId: 'peer', deviceId: 'device-peer0001' };
const CONV = 'conv-1';
const OFFER: E2ECallSignal = { type: 'offer', sdp: 'v=0 fake-sdp a=fingerprint:sha-256 AA:BB' };

function peerPlaintext(over: Partial<Parameters<typeof buildCallSignalPlaintext>[0]> = {}): string {
  return buildCallSignalPlaintext({
    v: 1,
    conversationId: CONV,
    senderUserId: PEER.userId,
    senderDeviceId: PEER.deviceId,
    epoch: 'peerEpoch0001',
    seq: 0,
    signal: OFFER,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  endCallSignaling(CONV);
  fetchDeviceList.mockResolvedValue({
    devices: [{ deviceId: PEER.deviceId, curve25519Key: 'c', ed25519Key: 'e', verified: false, crossSigned: true }],
    servedDeviceCount: 1,
    listVersion: 1,
    masterKey: null,
  });
  encryptToDevice.mockResolvedValue('{"v":1,"e":"olm1","t":0,"b":"ZmFrZQ"}');
});

describe('encryptCallSignal', () => {
  it('vets the peer device ONCE, then seals plaintexts with correct binding fields and rising seq', async () => {
    beginCallSignaling(CONV, PEER);

    await encryptCallSignal(CONV, PEER, OFFER);
    await encryptCallSignal(CONV, PEER, { type: 'ice-candidate', candidate: { candidate: 'c1' } });

    expect(fetchDeviceList).toHaveBeenCalledTimes(1);
    expect(fetchDeviceList).toHaveBeenCalledWith(PEER.userId, true);

    const first = JSON.parse(encryptToDevice.mock.calls[0][2]);
    const second = JSON.parse(encryptToDevice.mock.calls[1][2]);
    expect(first).toMatchObject({
      v: 1,
      conversationId: CONV,
      senderUserId: 'me',
      senderDeviceId: 'device-me000001',
      seq: 0,
      signal: OFFER,
    });
    expect(second.seq).toBe(1);
    expect(second.epoch).toBe(first.epoch); // same signaling session
    expect(encryptToDevice).toHaveBeenCalledWith(PEER.userId, PEER.deviceId, expect.any(String));
  });

  it('re-pinning (device change) mints a FRESH epoch and resets seq', async () => {
    beginCallSignaling(CONV, PEER);
    await encryptCallSignal(CONV, PEER, OFFER);
    const epoch1 = JSON.parse(encryptToDevice.mock.calls[0][2]).epoch;

    const newDevice = { userId: PEER.userId, deviceId: 'device-peer0002' };
    fetchDeviceList.mockResolvedValue({
      devices: [{ deviceId: newDevice.deviceId, curve25519Key: 'c', ed25519Key: 'e', verified: false, crossSigned: true }],
      servedDeviceCount: 1, listVersion: 2, masterKey: null,
    });
    beginCallSignaling(CONV, newDevice);
    await encryptCallSignal(CONV, newDevice, OFFER);

    const second = JSON.parse(encryptToDevice.mock.calls[1][2]);
    expect(second.epoch).not.toBe(epoch1);
    expect(second.seq).toBe(0);
  });

  it("throws 'peer-not-e2e' when the peer has published nothing", async () => {
    fetchDeviceList.mockResolvedValue({ devices: [], servedDeviceCount: 0, listVersion: 0, masterKey: null });
    beginCallSignaling(CONV, PEER);

    await expect(encryptCallSignal(CONV, PEER, OFFER)).rejects.toMatchObject({ kind: 'peer-not-e2e' });
    expect(encryptToDevice).not.toHaveBeenCalled();
  });

  it("throws 'binding-mismatch' for a device id not in the verified list (server-invented device)", async () => {
    fetchDeviceList.mockResolvedValue({
      devices: [{ deviceId: 'device-other001', curve25519Key: 'c', ed25519Key: 'e', verified: false, crossSigned: false }],
      servedDeviceCount: 1, listVersion: 1, masterKey: null,
    });
    beginCallSignaling(CONV, PEER);

    await expect(encryptCallSignal(CONV, PEER, OFFER)).rejects.toMatchObject({ kind: 'binding-mismatch' });
    expect(encryptToDevice).not.toHaveBeenCalled();
  });

  it('flags AND rethrows identity changes — the call must abort, never degrade', async () => {
    beginCallSignaling(CONV, PEER);
    encryptToDevice.mockRejectedValue(new E2EIdentityChangedError(PEER.userId));

    await expect(encryptCallSignal(CONV, PEER, OFFER)).rejects.toBeInstanceOf(E2EIdentityChangedError);
    expect(flagIdentityChanged).toHaveBeenCalledWith(PEER.userId);
  });
});

describe('decryptCallSignal', () => {
  beforeEach(() => {
    beginCallSignaling(CONV, PEER);
  });

  it("HARD-REJECTS non-envelope signals as 'legacy-signal' (the cutover)", async () => {
    for (const legacy of [
      { type: 'offer', sdp: 'plaintext sdp' },          // old-client object
      '{"type":"offer","sdp":"x"}',                      // plaintext JSON string
      'random string', 42, null, undefined,
    ]) {
      await expect(decryptCallSignal(CONV, PEER, legacy)).rejects.toMatchObject({ kind: 'legacy-signal' });
    }
    expect(decryptFromDevice).not.toHaveBeenCalled();
  });

  it('accepts a bound signal and enforces strictly-increasing seq within an epoch', async () => {
    decryptFromDevice
      .mockResolvedValueOnce(peerPlaintext({ seq: 0 }))
      .mockResolvedValueOnce(peerPlaintext({ seq: 1 }))
      .mockResolvedValueOnce(peerPlaintext({ seq: 1 }))   // replayed
      .mockResolvedValueOnce(peerPlaintext({ seq: 0 }));  // stale reorder

    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    expect(await decryptCallSignal(CONV, PEER, env)).toEqual(OFFER);
    expect(await decryptCallSignal(CONV, PEER, env)).toEqual(OFFER);
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
    expect(decryptFromDevice).toHaveBeenCalledWith(PEER.userId, PEER.deviceId, env);
  });

  it('a NEW epoch resets the seq expectation (peer reconnect re-glare)', async () => {
    decryptFromDevice
      .mockResolvedValueOnce(peerPlaintext({ epoch: 'epochA0000001', seq: 5 }))
      .mockResolvedValueOnce(peerPlaintext({ epoch: 'epochB0000001', seq: 0 })) // fresh epoch, low seq — accepted
      .mockResolvedValueOnce(peerPlaintext({ epoch: 'epochB0000001', seq: 0 })); // replay within B — dropped

    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    expect(await decryptCallSignal(CONV, PEER, env)).toEqual(OFFER);
    expect(await decryptCallSignal(CONV, PEER, env)).toEqual(OFFER);
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
  });

  it('drops (null) on binding mismatches: conversation, sender user, sender device', async () => {
    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    for (const bad of [
      peerPlaintext({ conversationId: 'conv-OTHER' }),
      peerPlaintext({ senderUserId: 'mallory' }),
      peerPlaintext({ senderDeviceId: 'device-mallory1' }),
    ]) {
      decryptFromDevice.mockResolvedValueOnce(bad);
      expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
    }
  });

  it('drops (null) undecryptable envelopes and malformed plaintext', async () => {
    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    decryptFromDevice.mockResolvedValueOnce(null);
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
    decryptFromDevice.mockResolvedValueOnce('{"not":"a call signal"}');
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
  });

  it('drops signals for calls with no pin, or a pin that does not match expectedPeer', async () => {
    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    endCallSignaling(CONV);
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();

    beginCallSignaling(CONV, { userId: 'peer', deviceId: 'device-peer0002' });
    expect(await decryptCallSignal(CONV, PEER, env)).toBeNull();
    expect(decryptFromDevice).not.toHaveBeenCalled();
  });

  it('flags AND rethrows identity changes from the decrypt path', async () => {
    const env = '{"v":1,"e":"olm1","t":1,"b":"ZmFrZQ"}';
    decryptFromDevice.mockRejectedValueOnce(new E2EIdentityChangedError(PEER.userId));

    await expect(decryptCallSignal(CONV, PEER, env)).rejects.toBeInstanceOf(E2EIdentityChangedError);
    expect(flagIdentityChanged).toHaveBeenCalledWith(PEER.userId);
  });
});

describe('state lifecycle', () => {
  it('begin/get/end round-trip', () => {
    expect(getCallPeerDevice(CONV)).toBeNull();
    beginCallSignaling(CONV, PEER);
    expect(getCallPeerDevice(CONV)).toEqual(PEER);
    endCallSignaling(CONV);
    expect(getCallPeerDevice(CONV)).toBeNull();
  });
});
