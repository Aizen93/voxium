import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { User } from '@voxium/shared';

// Translation KEYS, not copy — same reasoning as E2EControls.test.tsx: what
// matters here is which branch renders, not how it is worded this week.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// hoisted: vi.mock factories run before module-level consts exist
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../stores/toastStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/toastStore')>();
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: toastError } };
});

import { DeviceManagerModal, shouldOfferKeyBackupRestore } from '../../components/dm/E2EControls';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { E2ERecoveryKeyFormatError, type E2EOwnDevices } from '../../services/e2e/e2eService';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Account recovery (spec §15) is the difference between "lost every device" and
// "lost every device AND every contact has to verify me again". Both of its
// failure modes are silent: a recovery key dismissed before it was written down
// looks exactly like a backup that works, and a restore that failed looks like
// one that succeeded unless the UI insists otherwise. Neither throws.

const USER_ID = 'me';
// A genuine key (its checksum verifies): the restore box checks the checksum
// before calling anything, so a made-up string would only ever exercise the
// "that is not a recovery key" branch and never the paths these tests cover.
// Hardcoded rather than generated so this stays a component test with no wasm.
const RECOVERY_KEY = 'AEBA-GBAF-AYDQ-QCIK-BMGA-2DQP-CAIR-EEYU-CULB-OGAZ-DINR-YHI6-D4QA-2';

const E2E_INITIAL = useE2EStore.getState();
const AUTH_INITIAL = useAuthStore.getState();

let container: HTMLDivElement;
let root: Root;
let createKeyBackup: Mock<(userId: string) => Promise<string>>;
let deleteKeyBackup: Mock<(userId: string) => Promise<void>>;
let restoreKeyBackup: Mock<(userId: string, recoveryKey: string) => Promise<void>>;

/** Devices exactly as the server reports them for an unapproved fresh install. */
const ownDevices = (overrides: Partial<E2EOwnDevices> = {}): E2EOwnDevices => ({
  currentDeviceId: 'this-device',
  devices: [
    {
      deviceId: 'this-device',
      curve25519Key: 'c',
      ed25519Key: 'e',
      deviceSignature: 's',
      masterSignature: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      crossSigned: false,
    },
  ],
  listVersion: 1,
  masterKey: 'M',
  canApprove: false,
  capabilityServed: true,
  ...overrides,
});

beforeEach(() => {
  createKeyBackup = vi.fn<(userId: string) => Promise<string>>(async () => RECOVERY_KEY);
  deleteKeyBackup = vi.fn<(userId: string) => Promise<void>>(async () => {});
  restoreKeyBackup = vi.fn<(userId: string, recoveryKey: string) => Promise<void>>(async () => {});
  // Store actions are stubbed rather than mocking the module: the components
  // reach them through useE2EStore.getState(), and this keeps the real crypto
  // service (and its IndexedDB vault) out of a render test.
  useE2EStore.setState(
    {
      ...E2E_INITIAL,
      ready: true,
      loadOwnDevices: vi.fn<(userId: string) => Promise<void>>(async () => {}),
      loadKeyBackup: vi.fn<(userId: string) => Promise<void>>(async () => {}),
      createKeyBackup,
      deleteKeyBackup,
      restoreKeyBackup,
      resetAccountIdentity: vi.fn<(userId: string) => Promise<void>>(async () => {}),
    },
    true
  );
  useAuthStore.setState({ ...AUTH_INITIAL, user: { id: USER_ID } as User }, true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render() {
  act(() => {
    root.render(<DeviceManagerModal onClose={() => {}} />);
  });
}

/** The modal is portalled to document.body, so every query starts there. */
const find = (selector: string) => document.body.querySelector(selector);
const text = () => document.body.textContent ?? '';

function button(labelKey: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(labelKey)) ??
    null
  );
}

async function click(el: Element | null) {
  expect(el, 'tried to click something that is not rendered').not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** React tracks input values, so the native setter has to be used to fire onChange. */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('shouldOfferKeyBackupRestore', () => {
  it('offers a restore only to a device that cannot approve, when a backup exists', () => {
    expect(shouldOfferKeyBackupRestore({ keyBackup: { exists: true }, canApprove: false })).toBe(true);
    // Already holds the account key: there is nothing to recover.
    expect(shouldOfferKeyBackupRestore({ keyBackup: { exists: true }, canApprove: true })).toBe(false);
    expect(shouldOfferKeyBackupRestore({ keyBackup: { exists: false }, canApprove: false })).toBe(false);
  });

  it('treats an unread backup state as "do not offer"', () => {
    // `null` is "not read yet". Guessing "yes" sends a user who has just lost
    // every device hunting for a recovery key that was never created.
    expect(shouldOfferKeyBackupRestore({ keyBackup: null, canApprove: false })).toBe(false);
  });
});

describe('DeviceManagerModal — setting up account recovery', () => {
  it('says nothing about recovery until the backup state has been read', () => {
    useE2EStore.setState({ canApprove: true, ownDevices: ownDevices(), keyBackup: null });
    render();
    expect(find('[data-testid="e2e-key-backup"]')).toBeNull();
  });

  it('offers to set recovery up on the device that holds the account key', () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    expect(button('e2e.backupCreateAction')).not.toBeNull();
    expect(text()).toContain('e2e.backupExplainer');
    // nothing to restore from, and this device could not use it anyway
    expect(find('input[type="text"]')).toBeNull();
  });

  it('shows the recovery key and refuses to let it go until it is acknowledged', async () => {
    // It is shown once and cannot be re-derived by anyone, us included. A dialog
    // that closes on a stray click leaves the user believing they have a backup.
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    await click(button('e2e.backupCreateAction'));

    expect(createKeyBackup).toHaveBeenCalledWith(USER_ID);
    expect(find('[data-testid="e2e-recovery-key"]')?.textContent).toBe(RECOVERY_KEY);
    expect(text()).toContain('e2e.backupKeyWarning');

    const done = button('e2e.backupKeyDone')!;
    expect(done.disabled, 'the key could be dismissed without acknowledging it').toBe(true);

    // The backdrop is inert on purpose — clicking it must not dismiss the key.
    await click(find('[data-testid="e2e-recovery-key-dialog"]'));
    expect(find('[data-testid="e2e-recovery-key"]')).not.toBeNull();

    const acknowledgement = find('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => acknowledgement.click());
    expect(button('e2e.backupKeyDone')!.disabled).toBe(false);

    await click(button('e2e.backupKeyDone'));
    expect(find('[data-testid="e2e-recovery-key"]')).toBeNull();
    expect(text()).not.toContain(RECOVERY_KEY);
  });

  it('never leaves the recovery key in the store', async () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();
    await click(button('e2e.backupCreateAction'));

    // The dialog is showing it, so it exists somewhere — just not in state that
    // outlives the dialog, gets dumped by devtools or rides along in a bug report.
    expect(find('[data-testid="e2e-recovery-key"]')?.textContent).toBe(RECOVERY_KEY);
    expect(JSON.stringify(useE2EStore.getState())).not.toContain(RECOVERY_KEY);
  });

  it('reports a failed create instead of pretending there is a backup', async () => {
    createKeyBackup.mockRejectedValueOnce(new Error('this device does not hold the account key'));
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    await click(button('e2e.backupCreateAction'));

    expect(find('[data-testid="e2e-recovery-key"]')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('e2e.backupCreateFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('DeviceManagerModal — an existing backup', () => {
  const withBackup = () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
  };

  it('reports that recovery is set up, with the date', () => {
    withBackup();
    render();
    expect(text()).toContain('e2e.backupSetUp');
    expect(text()).toContain('e2e.backupUpdatedAt');
    expect(button('e2e.backupCreateAction')).toBeNull();
  });

  it('warns that replacing kills the current recovery key BEFORE replacing it', async () => {
    // There is one blob per account: the moment a new key is minted, the one the
    // user wrote down is noise. That has to be said while it is still true.
    withBackup();
    render();

    await click(button('e2e.backupReplaceAction'));
    expect(text()).toContain('e2e.backupReplaceConfirm');
    expect(createKeyBackup, 'replaced before the user confirmed').not.toHaveBeenCalled();

    await click(button('e2e.backupReplaceAction'));
    expect(createKeyBackup).toHaveBeenCalledWith(USER_ID);
    expect(find('[data-testid="e2e-recovery-key"]')?.textContent).toBe(RECOVERY_KEY);
  });

  it('asks before turning recovery off', async () => {
    withBackup();
    render();

    await click(button('e2e.backupDeleteAction'));
    expect(text()).toContain('e2e.backupDeleteConfirm');
    expect(deleteKeyBackup).not.toHaveBeenCalled();

    await click(button('common.confirm'));
    expect(deleteKeyBackup).toHaveBeenCalledWith(USER_ID);
    expect(toastSuccess).toHaveBeenCalledWith('e2e.backupDeleted');
  });
});

describe('DeviceManagerModal — restoring from a recovery key', () => {
  /** A device that cannot approve: the only one with anything to restore. */
  const stranded = (exists: boolean) => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices(),
      keyBackup: { exists, updatedAt: exists ? '2026-07-01T00:00:00.000Z' : null },
    });
  };

  it('offers a restore when a backup exists and this device cannot approve', () => {
    stranded(true);
    render();
    expect(find('input[type="text"]')).not.toBeNull();
    expect(text()).toContain('e2e.backupRestoreExplainer');
  });

  it('says there is nothing to restore rather than showing an empty box', () => {
    stranded(false);
    render();
    expect(find('input[type="text"]')).toBeNull();
    // rendered next to the reset, as the reason it is the only way out
    expect(find('[data-testid="e2e-reset-identity"]')).not.toBeNull();
    expect(text()).toContain('e2e.backupNone');
  });

  it('stays quiet on a second device that another device can simply approve', () => {
    // The most common state in the whole flow. There is no backup and nothing
    // is wrong: the answer is "approve it from your other device", so a notice
    // about a missing recovery key is noise that reads as a problem.
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices({
        devices: [
          ...ownDevices().devices,
          {
            deviceId: 'laptop',
            curve25519Key: 'c',
            ed25519Key: 'e',
            deviceSignature: 's',
            masterSignature: 'm',
            createdAt: '2026-01-01T00:00:00.000Z',
            crossSigned: true,
          },
        ],
      }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    expect(find('[data-testid="e2e-reset-identity"]'), 'reset offered during ordinary setup').toBeNull();
    expect(find('[data-testid="e2e-key-backup"]')).toBeNull();
    expect(text()).not.toContain('e2e.backupNone');
  });

  it('still offers a restore on that same second device when a backup exists', () => {
    // Having another device that could approve does not make the recovery key
    // useless — it is the self-service path for someone not sitting at it.
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices({
        devices: [
          ...ownDevices().devices,
          {
            deviceId: 'laptop',
            curve25519Key: 'c',
            ed25519Key: 'e',
            deviceSignature: 's',
            masterSignature: 'm',
            createdAt: '2026-01-01T00:00:00.000Z',
            crossSigned: true,
          },
        ],
      }),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
    render();

    expect(find('input[type="text"]')).not.toBeNull();
    expect(text()).toContain('e2e.backupRestoreExplainer');
  });

  it('does not offer a restore to a device that already holds the account key', () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
    render();
    expect(find('input[type="text"]')).toBeNull();
    expect(text()).not.toContain('e2e.backupRestoreExplainer');
  });

  it('shows an error on a wrong key and does NOT claim success', async () => {
    restoreKeyBackup.mockRejectedValueOnce(new Error('does not open this backup'));
    stranded(true);
    render();

    await type(find('input[type="text"]') as HTMLInputElement, 'AAAA-BBBB-CCCC');
    await click(button('e2e.backupRestoreAction'));

    expect(text()).toContain('e2e.backupRestoreFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
    // and the offer stays put, because nothing was recovered
    expect(find('input[type="text"]')).not.toBeNull();
  });

  it('tells a typo apart from a key that simply is not yours', async () => {
    // The checksum on a recovery key exists for exactly this: "check it for
    // typos" is honest when the key never left the device, and misleading when
    // it did and did not open the account's backup — that one means this key
    // belongs to a different account identity, and retyping it will not help.
    restoreKeyBackup.mockRejectedValueOnce(new E2ERecoveryKeyFormatError());
    stranded(true);
    render();

    await type(find('input[type="text"]') as HTMLInputElement, 'AAAA-BBBB');
    await click(button('e2e.backupRestoreAction'));

    expect(text()).toContain('e2e.backupRestoreMalformed');
    expect(text()).not.toContain('e2e.backupRestoreFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('clears the error as soon as the key is edited', async () => {
    restoreKeyBackup.mockRejectedValueOnce(new Error('does not open this backup'));
    stranded(true);
    render();

    const input = find('input[type="text"]') as HTMLInputElement;
    await type(input, 'AAAA');
    await click(button('e2e.backupRestoreAction'));
    expect(text()).toContain('e2e.backupRestoreFailed');

    await type(input, 'AAAB');
    expect(text()).not.toContain('e2e.backupRestoreFailed');
  });

  it('will not send an empty recovery key', () => {
    stranded(true);
    render();
    expect(button('e2e.backupRestoreAction')!.disabled).toBe(true);
  });

  it('reflects that this device can approve others once the restore lands', async () => {
    restoreKeyBackup.mockImplementationOnce(async () => {
      // What the real action does: re-reads own-device status from the service.
      useE2EStore.setState({ canApprove: true, masterReady: true, thisDeviceUnsigned: false });
    });
    stranded(true);
    render();

    await type(find('input[type="text"]') as HTMLInputElement, RECOVERY_KEY);
    await click(button('e2e.backupRestoreAction'));

    expect(restoreKeyBackup).toHaveBeenCalledWith(USER_ID, RECOVERY_KEY);
    expect(toastSuccess).toHaveBeenCalledWith('e2e.backupRestoreSuccess');
    // the panel has flipped to the "you hold the account key" side…
    expect(find('input[type="text"]')).toBeNull();
    expect(text()).toContain('e2e.backupSetUp');
    // …and the "you cannot approve devices" explainer is gone
    expect(text()).not.toContain('e2e.cannotApproveExplainer');
  });
});

describe('DeviceManagerModal — recovery before the last resort', () => {
  /**
   * Ordering is the whole point. Reset mints a NEW account key: every contact
   * sees the safety number change and has to verify again, and it deletes the
   * backup on the way out. Restore costs nobody anything. A user who reads the
   * screen top to bottom must meet the cheap exit first.
   */
  const strandedWithBackup = () => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices(),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
  };

  it('presents the restore above the identity reset', () => {
    strandedWithBackup();
    render();

    const restore = find('[data-testid="e2e-key-backup"]');
    const reset = find('[data-testid="e2e-reset-identity"]');
    expect(restore, 'no restore offered next to the reset').not.toBeNull();
    expect(reset, 'the last-resort reset must stay available').not.toBeNull();
    expect(
      restore!.compareDocumentPosition(reset!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the destructive reset is presented before the restore that costs nobody a re-verification'
    ).toBeTruthy();
  });

  it('keeps the reset available and points at the restore first', () => {
    strandedWithBackup();
    render();

    expect(button('e2e.resetIdentityAction'), 'the reset must not disappear').not.toBeNull();
    expect(text()).toContain('e2e.backupPreferRestore');
  });

  it('does not push the restore-first line when there is nothing to restore', () => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices(),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    expect(button('e2e.resetIdentityAction')).not.toBeNull();
    expect(text()).not.toContain('e2e.backupPreferRestore');
  });
});
