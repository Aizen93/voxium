import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The store between the crypto service and the badge. Everything here is state
// the user reads as a security signal, and most of it is computed at moments
// the service does NOT emit an event for — so the bugs are races and
// missing recomputations, not arithmetic.

const listeners = new Set<(userId: string) => void>();

/** Shaped like the real thing (spec §15.2) so a leak is recognisable in a dump. */
const RECOVERY_KEY = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723';

/** A stand-in for E2EService: every flag is settable, every call recorded. */
interface DeviceListStatus {
  version: number;
  deviceIds: string[];
  newDeviceIds: string[];
  unsignedDeviceIds: string[];
  changed: boolean;
}

function makeService(userId: string) {
  let status: DeviceListStatus = {
    version: 1,
    deviceIds: [],
    newDeviceIds: [],
    unsignedDeviceIds: [],
    changed: false,
  };
  return {
    deviceId: 'this-device',
    userId,
    _masterSecret: false,
    _canApprove: false,
    _conflict: false,
    setStatus(next: Partial<DeviceListStatus>) {
      status = { ...status, ...next };
    },
    hasMasterSecret() {
      return this._masterSecret;
    },
    canApproveDevices() {
      return this._canApprove;
    },
    hasMasterKeyConflict() {
      return this._conflict;
    },
    initialize: vi.fn(async () => {}),
    onDeviceListChanged(listener: (id: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deviceListStatus: vi.fn(async () => status),
    claimMasterTransfers: vi.fn(async () => false),
    fetchDeviceList: vi.fn(async () => ({ devices: [], listVersion: 1, masterKey: null })),
    isAccountVerified: vi.fn(async () => false),
    acceptNewIdentity: vi.fn(async () => {}),
    acknowledgeDeviceList: vi.fn(async () => {}),
    markIdentityVerified: vi.fn(async () => {}),
    listOwnDevices: vi.fn(async () => ({
      currentDeviceId: 'this-device',
      devices: [],
      listVersion: 1,
      masterKey: null,
      canApprove: false,
      capabilityServed: true,
    })),
    revokeDevice: vi.fn(async () => {}),
    approveDevice: vi.fn(async () => {}),
    findLinkableDevice: vi.fn(
      async (_code: string) => null as { deviceId: string; createdAt: string } | null
    ),
    resetAccountIdentity: vi.fn(async () => {}),
    keyBackupInfo: vi.fn(async () => ({ exists: false, updatedAt: null as string | null })),
    createKeyBackup: vi.fn(async () => RECOVERY_KEY),
    deleteKeyBackup: vi.fn(async () => {}),
    restoreKeyBackup: vi.fn(async (_recoveryKey: string) => {}),
  };
}

let service: ReturnType<typeof makeService>;

vi.mock('../../services/e2e/e2eService', async () => {
  const actual = await vi.importActual<typeof import('../../services/e2e/e2eService')>(
    '../../services/e2e/e2eService'
  );
  return {
    ...actual,
    getE2EService: () => service,
    disposeE2EService: () => {},
  };
});

import { useE2EStore, stopE2EDeviceListWatch, E2ELinkingCodeUnknownError } from '../../stores/e2eStore';
import { E2EIdentityChangedError } from '../../services/e2e/e2eService';

const USER = 'alice';
const PEER = 'bob';

/** Let the fire-and-forget promises inside initialize() settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const pristine = useE2EStore.getState();

beforeEach(() => {
  listeners.clear();
  service = makeService(USER);
  useE2EStore.setState(pristine, true);
});

afterEach(() => {
  stopE2EDeviceListWatch();
});

describe('e2eStore.initialize', () => {
  it('publishes the service flags once ready', async () => {
    service._masterSecret = true;
    service._canApprove = true;
    await useE2EStore.getState().initialize(USER);

    expect(useE2EStore.getState().ready).toBe(true);
    expect(useE2EStore.getState().initializing).toBe(false);
    expect(useE2EStore.getState().masterReady).toBe(true);
    expect(useE2EStore.getState().canApprove).toBe(true);
  });

  it('records a failure instead of claiming to be ready', async () => {
    service.initialize.mockRejectedValueOnce(new Error('vault locked'));
    await useE2EStore.getState().initialize(USER);

    const state = useE2EStore.getState();
    expect(state.ready).toBe(false);
    expect(state.initializing).toBe(false);
    expect(state.error).toBe('vault locked');
  });

  it('is idempotent — a second call while ready does not re-run initialize', async () => {
    await useE2EStore.getState().initialize(USER);
    await useE2EStore.getState().initialize(USER);
    expect(service.initialize).toHaveBeenCalledTimes(1);
  });

  it('picks up a master secret that arrived AFTER initialize resolved', async () => {
    // The service claims pending transfers fire-and-forget, so a device that
    // was just approved holds the key a tick later than the store first looks.
    // Reading the flags only when the claim reports an import would miss the
    // case where the service's own claim won the race — and the user would be
    // told "this device cannot approve others" for the rest of the session.
    service.claimMasterTransfers.mockImplementationOnce(async () => {
      service._masterSecret = true;
      service._canApprove = true;
      return false; // nothing left to import: the internal claim got there first
    });
    // Isolate the claim path: the own-status read would otherwise refresh the
    // same flags and hide a regression here.
    service.deviceListStatus.mockRejectedValue(new Error('offline'));

    await useE2EStore.getState().initialize(USER);
    await settle();

    expect(useE2EStore.getState().masterReady).toBe(true);
    expect(useE2EStore.getState().canApprove).toBe(true);
  });

  it('warns about an unapproved device on a fresh install, with no list change to trigger it', async () => {
    // Own-device warnings are otherwise only recomputed when the device list
    // CHANGES. On a device installed and never approved nothing ever changes,
    // so without the explicit post-init read the badge stays green for the
    // whole session on precisely the device the account key does not vouch for.
    service.setStatus({
      version: 1,
      deviceIds: ['this-device', 'other'],
      newDeviceIds: [],
      unsignedDeviceIds: ['this-device'],
      changed: false,
    });

    await useE2EStore.getState().initialize(USER);
    await settle();

    expect(useE2EStore.getState().thisDeviceUnsigned).toBe(true);
    // …and it is reported as THIS device, not as a device to go review
    expect(useE2EStore.getState().ownUnsignedDevices).toEqual([]);
  });

  it('surfaces an account-key conflict', async () => {
    service._conflict = true;
    await useE2EStore.getState().initialize(USER);
    expect(useE2EStore.getState().masterKeyConflict).toBe(true);
  });

  it('survives a post-init status read that fails', async () => {
    service.deviceListStatus.mockRejectedValue(new Error('offline'));
    await useE2EStore.getState().initialize(USER);
    await settle();
    expect(useE2EStore.getState().ready).toBe(true);
  });
});

describe('e2eStore device-list subscription', () => {
  it('routes our OWN list to the own-device fields', async () => {
    await useE2EStore.getState().initialize(USER);
    service.setStatus({
      version: 2,
      deviceIds: ['this-device', 'laptop'],
      newDeviceIds: ['laptop'],
      unsignedDeviceIds: ['laptop'],
      changed: true,
    });
    service._canApprove = true;

    for (const listener of listeners) listener(USER);
    await settle();

    const state = useE2EStore.getState();
    expect(state.ownDeviceWarnings).toEqual(['laptop']);
    expect(state.ownUnsignedDevices).toEqual(['laptop']);
    expect(state.thisDeviceUnsigned).toBe(false);
    expect(state.canApprove).toBe(true);
    // a peer bucket must not be touched by our own list
    expect(state.newDeviceWarnings).toEqual({});
  });

  it('routes a PEER list to that peer, and clears it when they settle', async () => {
    await useE2EStore.getState().initialize(USER);
    service.setStatus({
      version: 2,
      deviceIds: ['p1', 'p2'],
      newDeviceIds: ['p2'],
      unsignedDeviceIds: ['p2'],
      changed: true,
    });
    for (const listener of listeners) listener(PEER);
    await settle();

    expect(useE2EStore.getState().newDeviceWarnings[PEER]).toEqual(['p2']);
    expect(useE2EStore.getState().unsignedDeviceWarnings[PEER]).toEqual(['p2']);

    // the peer approves the device: both warnings must disappear on their own
    service.setStatus({
      version: 3,
      deviceIds: ['p1', 'p2'],
      newDeviceIds: [],
      unsignedDeviceIds: [],
      changed: false,
    });
    for (const listener of listeners) listener(PEER);
    await settle();

    expect(useE2EStore.getState().newDeviceWarnings[PEER]).toBeUndefined();
    expect(useE2EStore.getState().unsignedDeviceWarnings[PEER]).toBeUndefined();
  });

  it('does not leave a stale subscription behind after a re-login', async () => {
    await useE2EStore.getState().initialize(USER);
    expect(listeners.size).toBe(1);

    useE2EStore.setState({ ready: false, initializing: false });
    await useE2EStore.getState().initialize(USER);
    expect(listeners.size).toBe(1);
  });
});

describe('e2eStore peer actions', () => {
  it('flags an identity change rather than throwing out of the refresh', async () => {
    service.fetchDeviceList.mockRejectedValueOnce(new E2EIdentityChangedError(PEER));
    await useE2EStore.getState().refreshDeviceList(USER, PEER);
    expect(useE2EStore.getState().identityWarnings[PEER]).toBe(true);
  });

  it('swallows an ordinary refresh failure without flagging an identity change', async () => {
    // A network blip must not be rendered as "this contact's identity changed"
    // — that is the one prompt users have to take seriously.
    service.fetchDeviceList.mockRejectedValueOnce(new Error('offline'));
    await useE2EStore.getState().refreshDeviceList(USER, PEER);
    expect(useE2EStore.getState().identityWarnings[PEER]).toBeUndefined();
  });

  it('clears the identity, new-device AND verification state when a new identity is accepted', async () => {
    useE2EStore.setState({
      identityWarnings: { [PEER]: true },
      newDeviceWarnings: { [PEER]: ['x'] },
      accountVerified: { [PEER]: true },
    });

    await useE2EStore.getState().acceptNewIdentity(USER, PEER);

    const state = useE2EStore.getState();
    expect(state.identityWarnings[PEER]).toBeUndefined();
    expect(state.newDeviceWarnings[PEER]).toBeUndefined();
    // the comparison was against the OLD key, so it cannot carry over
    expect(state.accountVerified[PEER]).toBeUndefined();
  });

  it('records an account comparison only for the peer it was made against', async () => {
    await useE2EStore.getState().markAccountVerified(USER, PEER);
    expect(useE2EStore.getState().accountVerified[PEER]).toBe(true);
    expect(useE2EStore.getState().accountVerified['someone-else']).toBeUndefined();
    expect(service.markIdentityVerified).toHaveBeenCalledWith(PEER);
  });
});

describe('e2eStore own-device actions', () => {
  const withStatus = (unsigned: string[], newIds: string[], changed: boolean) => {
    service.setStatus({
      version: 9,
      deviceIds: ['this-device', 'laptop'],
      newDeviceIds: newIds,
      unsignedDeviceIds: unsigned,
      changed,
    });
  };

  it('recomputes own state after approving, so the warning clears itself', async () => {
    withStatus([], [], false);
    await useE2EStore.getState().approveDevice(USER, 'laptop');

    expect(service.approveDevice).toHaveBeenCalledWith('laptop');
    expect(useE2EStore.getState().ownUnsignedDevices).toEqual([]);
    expect(useE2EStore.getState().ownDeviceWarnings).toEqual([]);
  });

  it('recomputes own state after revoking', async () => {
    withStatus([], [], false);
    useE2EStore.setState({ ownUnsignedDevices: ['laptop'], ownDeviceWarnings: ['laptop'] });

    await useE2EStore.getState().revokeDevice(USER, 'laptop');

    expect(service.revokeDevice).toHaveBeenCalledWith('laptop');
    expect(useE2EStore.getState().ownUnsignedDevices).toEqual([]);
  });

  it('keeps flagging an unsigned device after the user says they have seen it', async () => {
    // Acknowledgement clears "a device was added"; it must NOT clear "the
    // account key does not vouch for this device". Clicking a button cannot
    // manufacture a signature.
    withStatus(['laptop'], [], false);
    await useE2EStore.getState().acknowledgeOwnDevices(USER, ['this-device', 'laptop']);

    expect(useE2EStore.getState().ownDeviceWarnings).toEqual([]);
    expect(useE2EStore.getState().ownUnsignedDevices).toEqual(['laptop']);
  });

  it('refreshes state after an identity reset', async () => {
    withStatus([], [], false);
    service.resetAccountIdentity.mockImplementationOnce(async () => {
      service._masterSecret = true;
      service._canApprove = true;
    });

    await useE2EStore.getState().resetAccountIdentity(USER);

    expect(service.resetAccountIdentity).toHaveBeenCalled();
    expect(useE2EStore.getState().canApprove).toBe(true);
    expect(useE2EStore.getState().masterKeyConflict).toBe(false);
  });

  it('does not swallow a failed reset — the caller has to be able to report it', async () => {
    service.resetAccountIdentity.mockRejectedValueOnce(new Error('publish failed'));
    await expect(useE2EStore.getState().resetAccountIdentity(USER)).rejects.toThrow('publish failed');
  });

  it('leaves the device list loaded flag false when loading fails', async () => {
    service.listOwnDevices.mockRejectedValueOnce(new Error('offline'));
    await useE2EStore.getState().loadOwnDevices(USER);
    expect(useE2EStore.getState().ownDevicesLoading).toBe(false);
  });
});

describe('e2eStore device linking (plan §4.3)', () => {
  const LINKED = { deviceId: 'laptop', createdAt: '2026-07-30T09:15:00.000Z' };

  it('resolves a code to a device and stops there', async () => {
    // The lookup and the approval are two actions on purpose. The code is not
    // a capability — knowing it grants nothing — so what is left to defend
    // against is a user typing an ATTACKER's code, and the only defence is
    // that they get shown what is about to be approved while they can still
    // say no. A lookup that approved on the way past would delete that moment.
    service.findLinkableDevice.mockResolvedValueOnce(LINKED);

    const match = await useE2EStore.getState().linkDevice(USER, 'ABCD-2345');

    expect(match).toEqual(LINKED);
    expect(service.findLinkableDevice).toHaveBeenCalledWith('ABCD-2345');
    expect(service.approveDevice, 'the lookup approved a device by itself').not.toHaveBeenCalled();
  });

  it('reports a code nobody is showing as its own kind of failure', async () => {
    service.findLinkableDevice.mockResolvedValueOnce(null);

    await expect(useE2EStore.getState().linkDevice(USER, 'ZZZZ-9999')).rejects.toBeInstanceOf(
      E2ELinkingCodeUnknownError
    );
    expect(service.approveDevice).not.toHaveBeenCalled();
  });

  it('lets a failed lookup through as itself rather than as an unknown code', async () => {
    // "No device is showing that code" and "we could not ask" send the user to
    // different places: retype it, versus try again. Collapsing them makes an
    // offline client accuse the user of a typo they did not make.
    service.findLinkableDevice.mockRejectedValueOnce(new Error('offline'));

    const failure = await useE2EStore
      .getState()
      .linkDevice(USER, 'ABCD-2345')
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(E2ELinkingCodeUnknownError);
    expect((failure as Error).message).toBe('offline');
  });

  it('approves exactly the device it was given, and recomputes own state', async () => {
    // Same end state as approving from the list: a device linked by code must
    // not be left half-trusted, still flagged on every peer's badge.
    service.setStatus({
      version: 9,
      deviceIds: ['this-device', 'laptop'],
      newDeviceIds: [],
      unsignedDeviceIds: [],
      changed: false,
    });
    useE2EStore.setState({ ownUnsignedDevices: ['laptop'], ownDeviceWarnings: ['laptop'] });

    await useE2EStore.getState().approveLinkedDevice(USER, LINKED.deviceId);

    expect(service.approveDevice).toHaveBeenCalledWith('laptop');
    expect(service.listOwnDevices).toHaveBeenCalled();
    expect(useE2EStore.getState().ownUnsignedDevices).toEqual([]);
    expect(useE2EStore.getState().ownDeviceWarnings).toEqual([]);
  });

  it('does not swallow a failed approval — nothing was linked', async () => {
    service.approveDevice.mockRejectedValueOnce(new Error('rate limited'));
    await expect(
      useE2EStore.getState().approveLinkedDevice(USER, LINKED.deviceId)
    ).rejects.toThrow('rate limited');
  });
});

describe('e2eStore key backup (spec §15)', () => {
  it('starts out not knowing whether a backup exists', () => {
    // `null` is load-bearing: the UI must not offer to create (which replaces an
    // existing blob and voids its recovery key) or to restore (from a blob that
    // may not exist) on a guess.
    expect(useE2EStore.getState().keyBackup).toBeNull();
  });

  it('records what the server says', async () => {
    service.keyBackupInfo.mockResolvedValueOnce({ exists: true, updatedAt: '2026-07-01T00:00:00.000Z' });
    await useE2EStore.getState().loadKeyBackup(USER);
    expect(useE2EStore.getState().keyBackup).toEqual({
      exists: true,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('keeps the last known answer when the read fails', async () => {
    // Overwriting with "no backup" would put a "Set up recovery" button in front
    // of a user who already has one — and taking it invalidates the recovery key
    // they wrote down.
    useE2EStore.setState({ keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' } });
    service.keyBackupInfo.mockRejectedValueOnce(new Error('offline'));

    await useE2EStore.getState().loadKeyBackup(USER);

    expect(useE2EStore.getState().keyBackup).toEqual({
      exists: true,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('hands the recovery key to the caller and NEVER keeps a copy', async () => {
    // The key is the entire security of the backup: the server holds the blob.
    // Store state outlives the dialog, survives in devtools and rides along in
    // any state dump, so it has to leave here and go nowhere else.
    const key = await useE2EStore.getState().createKeyBackup(USER);

    expect(key).toBe(RECOVERY_KEY);
    expect(JSON.stringify(useE2EStore.getState())).not.toContain(RECOVERY_KEY);
    expect(JSON.stringify(useE2EStore.getState())).not.toContain('ABCD');
  });

  it('shows the backup as existing even if the confirming read fails', async () => {
    // The blob IS on the server once create resolves. Reporting "no recovery
    // set up" in the same breath as showing a recovery key reads as failure and
    // invites a second create.
    service.keyBackupInfo.mockRejectedValueOnce(new Error('offline'));
    await useE2EStore.getState().createKeyBackup(USER);
    expect(useE2EStore.getState().keyBackup?.exists).toBe(true);
  });

  it('does not swallow a failed create — no key, no success', async () => {
    service.createKeyBackup.mockRejectedValueOnce(new Error('device does not hold the account key'));
    await expect(useE2EStore.getState().createKeyBackup(USER)).rejects.toThrow(
      'device does not hold the account key'
    );
    expect(useE2EStore.getState().keyBackup).toBeNull();
  });

  it('clears the backup state when the backup is deleted', async () => {
    useE2EStore.setState({ keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' } });
    await useE2EStore.getState().deleteKeyBackup(USER);
    expect(useE2EStore.getState().keyBackup).toEqual({ exists: false, updatedAt: null });
  });

  it('does not swallow a failed delete — the blob may still be there', async () => {
    useE2EStore.setState({ keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' } });
    service.deleteKeyBackup.mockRejectedValueOnce(new Error('offline'));

    await expect(useE2EStore.getState().deleteKeyBackup(USER)).rejects.toThrow('offline');
    expect(useE2EStore.getState().keyBackup?.exists).toBe(true);
  });

  it('recomputes own-device state after a restore, so the device stops looking unapproved', async () => {
    service.setStatus({
      version: 9,
      deviceIds: ['this-device'],
      newDeviceIds: [],
      unsignedDeviceIds: [],
      changed: false,
    });
    useE2EStore.setState({ thisDeviceUnsigned: true });
    service.restoreKeyBackup.mockImplementationOnce(async () => {
      service._masterSecret = true;
      service._canApprove = true;
      service._conflict = false;
    });

    await useE2EStore.getState().restoreKeyBackup(USER, RECOVERY_KEY);

    expect(service.restoreKeyBackup).toHaveBeenCalledWith(RECOVERY_KEY);
    const state = useE2EStore.getState();
    expect(state.canApprove).toBe(true);
    expect(state.masterReady).toBe(true);
    expect(state.thisDeviceUnsigned).toBe(false);
  });

  it('does not swallow a wrong recovery key', async () => {
    // A restore that failed must reach the caller as a failure: the panel says
    // "restored — this device can approve others now", and saying that about a
    // device that recovered nothing is the worst outcome in this whole flow.
    service.restoreKeyBackup.mockRejectedValueOnce(new Error('does not open this backup'));

    await expect(useE2EStore.getState().restoreKeyBackup(USER, 'AAAA-BBBB')).rejects.toThrow(
      'does not open this backup'
    );
    expect(useE2EStore.getState().canApprove).toBe(false);
  });

  it('re-reads the backup after an identity reset that dropped it', async () => {
    // A reset that MINTS a new key deletes the blob server-side (§15.5) — it
    // could only ever fail to open now. Left stale, the panel would keep
    // promising a recovery key that is noise.
    useE2EStore.setState({ keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' } });
    service.keyBackupInfo.mockResolvedValueOnce({ exists: false, updatedAt: null });

    await useE2EStore.getState().resetAccountIdentity(USER);

    expect(service.keyBackupInfo).toHaveBeenCalled();
    expect(useE2EStore.getState().keyBackup).toEqual({ exists: false, updatedAt: null });
  });
});

describe('e2eStore logout hygiene', () => {
  it('wipes every security signal on logout', async () => {
    // These fields are the UI's memory of who is trusted. Left behind on a
    // shared machine they would tell the NEXT person that a stranger's contact
    // was verified, or hide a warning that belongs to them.
    const { resetAccountStores } = await import('../../stores/resetStores');

    useE2EStore.setState({
      ready: true,
      masterReady: true,
      canApprove: true,
      thisDeviceUnsigned: true,
      masterKeyConflict: true,
      ownUnsignedDevices: ['laptop'],
      ownDeviceWarnings: ['laptop'],
      identityWarnings: { [PEER]: true },
      accountVerified: { [PEER]: true },
      newDeviceWarnings: { [PEER]: ['x'] },
      unsignedDeviceWarnings: { [PEER]: ['x'] },
      ownDevices: {
        currentDeviceId: 'this-device',
        devices: [],
        listVersion: 1,
        masterKey: 'M',
        canApprove: true,
        capabilityServed: true,
      },
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });

    resetAccountStores();

    const state = useE2EStore.getState();
    expect(state.ready).toBe(false);
    expect(state.masterReady).toBe(false);
    expect(state.canApprove).toBe(false);
    expect(state.thisDeviceUnsigned).toBe(false);
    expect(state.masterKeyConflict).toBe(false);
    expect(state.ownUnsignedDevices).toEqual([]);
    expect(state.ownDeviceWarnings).toEqual([]);
    expect(state.identityWarnings).toEqual({});
    expect(state.accountVerified).toEqual({});
    expect(state.newDeviceWarnings).toEqual({});
    expect(state.unsignedDeviceWarnings).toEqual({});
    expect(state.ownDevices).toBeNull();
    // Whether the PREVIOUS account had a recovery key is that account's
    // business, and offering the next user a "restore" box for it is worse.
    expect(state.keyBackup).toBeNull();
  });
});
