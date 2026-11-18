// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildE2EEnvelope, buildMegolmEnvelope } from '@voxium/shared';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { E2EService, E2EDeletedParticipantError, E2EIdentityChangedError, E2EPeerNotReadyError, type E2EServiceOptions } from '../../services/e2e/e2eService';
import { isE2ESessionEnded } from '../../services/e2e/session';
import type { PickleKeyProvider } from '../../services/e2e/vault';

/**
 * The deleted-account placeholder (`deleted:{conversationId}`) never leaves
 * the client through the E2E service: every public method that takes a peer
 * user id refuses it at the boundary, before any request, vault write or
 * engine use. Here the service is never even started, and its client fails
 * the test on any call: a guard that let one through would show here.
 */

const PLACEHOLDER = 'deleted:conv-1';

let n = 0;
function makeService() {
  n++;
  const calls: string[] = [];
  const refuse = (verb: string) => (url: string) => {
    calls.push(`${verb} ${url}`);
    return Promise.reject(new Error(`unexpected ${verb} ${url}`));
  };
  const api = { get: refuse('GET'), post: refuse('POST'), put: refuse('PUT'), delete: refuse('DELETE') };
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
  const keyProvider = { load: async () => key, save: async () => {}, remove: async () => {} } as PickleKeyProvider;
  const service = new E2EService(`peer-guard-${n}`, {
    api: api as unknown as E2EServiceOptions['api'],
    keyProvider,
    vaultNamespace: `peer-guard-${n}`,
  });
  return { service, calls };
}

const services: E2EService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});
function fresh() {
  const made = makeService();
  services.push(made.service);
  return made;
}

describe('E2EDeletedParticipantError', () => {
  it('is its own error: not a session ending, not a changed identity, not a peer without devices', () => {
    const err = new E2EDeletedParticipantError();
    expect(err.name).toBe('E2EDeletedParticipantError');
    expect(isE2ESessionEnded(err)).toBe(false);
    expect(err).not.toBeInstanceOf(E2EIdentityChangedError);
    expect(err).not.toBeInstanceOf(E2EPeerNotReadyError);
  });
});

describe('the E2E service boundary refuses the deleted-account placeholder', () => {
  it('fetchDeviceList throws the typed error, asks the server nothing, and announces no device-list change', async () => {
    const { service, calls } = fresh();
    const changed = vi.fn();
    service.onDeviceListChanged(changed);
    await expect(service.fetchDeviceList(PLACEHOLDER)).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    await expect(service.fetchDeviceList(PLACEHOLDER, true)).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    expect(calls).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('acceptNewIdentity throws the typed error (it has its own GET of the list)', async () => {
    const { service, calls } = fresh();
    await expect(service.acceptNewIdentity(PLACEHOLDER)).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    expect(calls).toEqual([]);
  });

  it('encryptMessage throws the typed error: nothing is encrypted, and no key shared, to it', async () => {
    const { service, calls } = fresh();
    await expect(service.encryptMessage('conv-1', PLACEHOLDER, 'hello')).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    expect(calls).toEqual([]);
  });

  it('encryptToDevice throws the typed error: no session set up, no call signal or voice key sealed', async () => {
    const { service, calls } = fresh();
    await expect(service.encryptToDevice(PLACEHOLDER, 'device-x0000001', '{}')).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    expect(calls).toEqual([]);
  });

  it('decryptFromDevice answers null (its "cannot decrypt"), with no list fetched', async () => {
    const { service, calls } = fresh();
    await expect(service.decryptFromDevice(PLACEHOLDER, 'device-x0000001', buildE2EEnvelope(0, 'Ym9keQ'))).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('deviceListStatus answers the empty status without reading a recorded state', async () => {
    const { service } = fresh();
    await expect(service.deviceListStatus(PLACEHOLDER)).resolves.toEqual({
      version: 0, deviceIds: [], newDeviceIds: [], unsignedDeviceIds: [], changed: false,
    });
  });

  it('acknowledgeDeviceList and resetSession do nothing', async () => {
    const { service, calls } = fresh();
    await expect(service.acknowledgeDeviceList(PLACEHOLDER, ['device-x0000001'])).resolves.toBeUndefined();
    await expect(service.resetSession(PLACEHOLDER)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('no safety number: per device [], for the account null, the single view null, never verified', async () => {
    const { service, calls } = fresh();
    await expect(service.perDeviceSafetyNumbers(PLACEHOLDER)).resolves.toEqual([]);
    await expect(service.accountSafetyNumber(PLACEHOLDER)).resolves.toBeNull();
    await expect(service.safetyNumber(PLACEHOLDER)).resolves.toBeNull();
    await expect(service.isAccountVerified(PLACEHOLDER)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('nothing is marked verified for it: both marks throw the typed error (a claim about nobody)', async () => {
    const { service, calls } = fresh();
    await expect(service.markDeviceVerified(PLACEHOLDER, 'device-x0000001')).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    await expect(service.markIdentityVerified(PLACEHOLDER)).rejects.toBeInstanceOf(E2EDeletedParticipantError);
    expect(await service.isAccountVerified(PLACEHOLDER)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('decryptMessage of a row under the placeholder fails at once: no cache answer, no key-share claim', async () => {
    const { service, calls } = fresh();
    await service.cachePlaintext('m-1', 'conv-1', 'cached words', null, { authorId: PLACEHOLDER });
    const result = await service.decryptMessage({
      id: 'm-1', conversationId: 'conv-1', authorId: PLACEHOLDER, content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), editedAt: null,
    });
    expect(result).toEqual({ text: '', failed: true });
    expect(calls).toEqual([]);
  });

  it('a real id with the same username is not refused (the guard is the id prefix, never a name)', async () => {
    const { service, calls } = fresh();
    // reaches the server, which this client refuses here: the guard let it through
    await expect(service.fetchDeviceList('cmrealuser0000000000001')).rejects.toThrow('unexpected GET /e2e/devices/cmrealuser0000000000001');
    expect(calls).toEqual(['GET /e2e/devices/cmrealuser0000000000001']);
  });
});
