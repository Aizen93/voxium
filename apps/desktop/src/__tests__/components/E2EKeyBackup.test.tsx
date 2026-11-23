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
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));
vi.mock('../../stores/toastStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/toastStore')>();
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: toastError, info: toastInfo } };
});
// The section asks the service for this device's linking code (§4.3). Stubbed
// for the same reason everything else here is: no real crypto service, and no
// wasm engine, behind a render test. The code has its own tests. A test of the
// panel's load hands in the service's own judging instead (judgingService).
const serviceStub = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return { ...actual, getE2EService: () => serviceStub.current };
});

import { E2EDevicesSection, shouldOfferKeyBackupRestore } from '../../components/settings/E2EDevicesSection';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import {
  E2EKeyBackupUnavailableError,
  E2EKeyBackupUnconfirmedError,
  E2ERecoveryKeyFormatError,
  E2EService,
  E2EServiceDisposedError,
  type E2EKeyBackupReplaceOutcome,
  type E2EKeyBackupWriteCheck,
  type E2EOwnDevices,
} from '../../services/e2e/e2eService';
import { sha256Hex } from '../../utils/sha256';

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
let checkKeyBackupWrite: Mock<(userId: string) => Promise<E2EKeyBackupWriteCheck['outcome'] | null>>;
let dismissKeyBackupWrite: Mock<(userId: string) => Promise<void>>;

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
  serviceStub.current = { linkingCode: () => 'WXYZ-2345' };
  createKeyBackup = vi.fn<(userId: string) => Promise<string>>(async () => RECOVERY_KEY);
  deleteKeyBackup = vi.fn<(userId: string) => Promise<void>>(async () => {});
  restoreKeyBackup = vi.fn<(userId: string, recoveryKey: string) => Promise<void>>(async () => {});
  checkKeyBackupWrite = vi.fn<(userId: string) => Promise<E2EKeyBackupWriteCheck['outcome'] | null>>(
    async () => null
  );
  // as the real action: the notice goes once the service dropped its record
  dismissKeyBackupWrite = vi.fn<(userId: string) => Promise<void>>(async () => {
    useE2EStore.setState({ keyBackupAttempt: null });
  });
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
      checkKeyBackupWrite,
      dismissKeyBackupWrite,
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
    root.render(<E2EDevicesSection />);
  });
}

/**
 * The section renders inside a container attached to document.body, and the
 * recovery-key dialog still portals straight to it, so every query starts there.
 */
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

describe('E2EDevicesSection — setting up account recovery', () => {
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
    expect(find('[data-testid="e2e-restore-key-input"]')).toBeNull();
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

describe('E2EDevicesSection — an existing backup', () => {
  const withBackup = () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
      // the panel's load judged the backup
      keyBackupJudged: true,
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

describe('E2EDevicesSection — a backup write nobody confirmed (spec §15.7)', () => {
  const STORED = { exists: true, updatedAt: '2026-11-22T10:00:00.000Z' };
  const holder = (exists: boolean) => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: exists ? { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' } : { exists: false, updatedAt: null },
      keyBackupJudged: true,
    });
  };
  const notice = () => find('[data-testid="e2e-backup-unconfirmed"]');
  const outcome = () => notice()?.getAttribute('data-outcome') ?? null;
  const politeText = () => notice()?.querySelector('[role="status"]')?.textContent ?? null;
  const alertText = () => notice()?.querySelector('[role="alert"]')?.textContent ?? null;

  /**
   * The write's answer lost, and the read after it finding `found`: the store
   * records the notice and the backup it read, as the real action does.
   */
  function failNextWrite(found: E2EKeyBackupReplaceOutcome, firstSetup: boolean, stored: typeof STORED | { exists: false; updatedAt: null } | null) {
    createKeyBackup.mockImplementationOnce(async () => {
      useE2EStore.setState(stored ? { keyBackupAttempt: { outcome: found, firstSetup }, keyBackup: stored } : { keyBackupAttempt: { outcome: found, firstSetup } });
      throw new E2EKeyBackupUnconfirmedError(found, firstSetup, stored);
    });
  }
  /** What the next check finds, recorded in the store as the real action records it. */
  function nextCheck(found: E2EKeyBackupWriteCheck['outcome'], firstSetup = false) {
    checkKeyBackupWrite.mockImplementationOnce(async () => {
      useE2EStore.setState({ keyBackupAttempt: found === 'settled' ? null : { outcome: found, firstSetup } });
      return found;
    });
  }
  const replace = async () => {
    await click(button('e2e.backupReplaceAction'));
    await click(button('e2e.backupReplaceAction'));
  };

  it("says what was found on 'unchanged', politely, with Check again and no promise that the key works", async () => {
    holder(true);
    render();
    // the polite region is there before its text appears, or nothing announces it
    expect(notice()?.querySelector('[role="status"]')).not.toBeNull();
    expect(politeText()).toBe('');
    expect(outcome()).toBeNull();

    failNextWrite('unchanged', false, STORED);
    await replace();

    expect(outcome()).toBe('unchanged');
    expect(politeText()).toBe('e2e.backupReplaceUnchanged');
    expect(alertText()).toBeNull();
    expect(button('e2e.backupCheckAgain')).not.toBeNull();
    expect(button('e2e.backupMakeNewKey')).not.toBeNull();
    // no key shown, no generic failure on top, and the confirmation is closed
    expect(find('[data-testid="e2e-recovery-key"]')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(text()).not.toContain('e2e.backupReplaceConfirm');
  });

  it("says the earlier recovery key no longer works on 'changed', and makes a new one on request", async () => {
    holder(true);
    render();
    failNextWrite('changed', false, STORED);
    await replace();

    expect(outcome()).toBe('changed');
    expect(alertText()).toBe('e2e.backupReplaceChanged');
    expect(button('e2e.backupCheckAgain')).toBeNull();
    expect(find('[data-testid="e2e-recovery-key"]')).toBeNull();

    createKeyBackup.mockImplementationOnce(async () => {
      useE2EStore.setState({ keyBackupAttempt: null });
      return RECOVERY_KEY;
    });
    await click(button('e2e.backupMakeNewKey'));

    expect(createKeyBackup).toHaveBeenCalledTimes(2);
    expect(find('[data-testid="e2e-recovery-key"]')?.textContent).toBe(RECOVERY_KEY);
    expect(outcome()).toBeNull();
  });

  it("does not speak of a key that opens a backup that is gone", async () => {
    holder(true);
    render();
    failNextWrite('changed', false, { exists: false, updatedAt: null });
    await replace();

    expect(alertText()).toBe('e2e.backupReplaceGone');
  });

  it("says the outcome is unknown when the read failed, and offers to check again", async () => {
    holder(true);
    render();
    failNextWrite('unknown', false, null);
    await replace();

    expect(outcome()).toBe('unknown');
    expect(alertText()).toBe('e2e.backupReplaceUnknown');
    expect(button('e2e.backupCheckAgain')).not.toBeNull();
    expect(button('e2e.backupMakeNewKey')).not.toBeNull();
  });

  it.each([
    ['unchanged', { exists: false, updatedAt: null }, 'e2e.backupSetupUnchanged', politeText],
    ['changed', STORED, 'e2e.backupSetupChanged', alertText],
    ['unknown', null, 'e2e.backupSetupUnknown', alertText],
  ] as const)("on a first setup, says what '%s' means without an earlier key", async (found, stored, key, read) => {
    holder(false);
    render();
    failNextWrite(found, true, stored);

    await click(button('e2e.backupCreateAction'));

    expect(outcome()).toBe(found);
    expect(read()).toBe(key);
    expect(text()).not.toMatch(/e2e[.]backupReplace(Unchanged|Changed|Gone|Unknown)/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('turns an unknown outcome into the one the check found', async () => {
    holder(true);
    render();
    failNextWrite('unknown', false, null);
    await replace();

    nextCheck('changed');
    await click(button('e2e.backupCheckAgain'));

    expect(checkKeyBackupWrite).toHaveBeenCalledWith(USER_ID);
    expect(outcome()).toBe('changed');
    expect(alertText()).toBe('e2e.backupReplaceChanged');
  });

  it("answers a check that finds 'unchanged' again, since the notice reads as before", async () => {
    holder(true);
    render();
    failNextWrite('unchanged', false, STORED);
    await replace();

    nextCheck('unchanged');
    await click(button('e2e.backupCheckAgain'));

    expect(toastInfo).toHaveBeenCalledWith('e2e.backupCheckNoChange');
    expect(outcome()).toBe('unchanged');
  });

  it('says to keep the earlier key once a check settles a replace, and drops the notice', async () => {
    holder(true);
    render();
    failNextWrite('unchanged', false, STORED);
    await replace();

    nextCheck('settled');
    await click(button('e2e.backupCheckAgain'));

    expect(toastSuccess).toHaveBeenCalledWith('e2e.backupCheckSettled');
    expect(outcome()).toBeNull();
  });

  it('reports a first setup that settled as not set up', async () => {
    holder(false);
    render();
    failNextWrite('unchanged', true, { exists: false, updatedAt: null });
    await click(button('e2e.backupCreateAction'));

    nextCheck('settled', true);
    await click(button('e2e.backupCheckAgain'));

    expect(toastError).toHaveBeenCalledWith('e2e.backupCreateFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(outcome()).toBeNull();
  });

  it.each([
    ['answers unknown', () => nextCheck('unknown')],
    ['fails', () => checkKeyBackupWrite.mockRejectedValueOnce(new Error('the vault failed'))],
  ])('says the check failed when it %s, and keeps the notice', async (_, arrange) => {
    holder(true);
    render();
    failNextWrite('unknown', false, null);
    await replace();

    arrange();
    await click(button('e2e.backupCheckAgain'));

    expect(toastError).toHaveBeenCalledWith('e2e.backupCheckFailed');
    expect(outcome()).toBe('unknown');
  });

  it('shows nothing when the session ends during a check', async () => {
    holder(true);
    render();
    failNextWrite('unknown', false, null);
    await replace();

    checkKeyBackupWrite.mockRejectedValueOnce(new E2EServiceDisposedError());
    await click(button('e2e.backupCheckAgain'));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('runs one action at a time from the notice', async () => {
    holder(true);
    render();
    failNextWrite('unknown', false, null);
    await replace();

    let finish!: (value: null) => void;
    checkKeyBackupWrite.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await click(button('e2e.backupCheckAgain'));

    // while the check runs, both controls are disabled and a click starts nothing
    const check = notice()!.querySelectorAll('button')[0] as HTMLButtonElement;
    const makeNew = button('e2e.backupMakeNewKey')!;
    expect(check.disabled).toBe(true);
    expect(check.textContent).toBe('common.loading');
    expect(makeNew.disabled).toBe(true);
    await click(check);
    await click(makeNew);
    expect(checkKeyBackupWrite).toHaveBeenCalledTimes(1);
    expect(createKeyBackup).toHaveBeenCalledTimes(1);

    await act(async () => finish(null));
    expect(button('e2e.backupMakeNewKey')!.disabled).toBe(false);
  });

  it('keeps the notice across closing and opening the panel, read again at each open', async () => {
    holder(true);
    useE2EStore.setState({ keyBackupAttempt: { outcome: 'changed', firstSetup: false } });
    render();
    expect(outcome()).toBe('changed');

    act(() => root.unmount());
    root = createRoot(container);
    render();

    expect(outcome()).toBe('changed');
    expect(useE2EStore.getState().loadKeyBackup).toHaveBeenCalledTimes(2);
  });

  it('shows the notice even when the backup could not be read', async () => {
    // offline when the panel opened: no backup state, a write still unknown
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: null,
      keyBackupAttempt: { outcome: 'unknown', firstSetup: false },
    });
    render();

    expect(outcome()).toBe('unknown');
    expect(alertText()).toBe('e2e.backupReplaceUnknown');
    expect(text()).not.toContain('e2e.backupSetUp');
  });

  /** A notice already in the store, as a check or an earlier attempt left it. */
  const withNotice = (attempt: { outcome: E2EKeyBackupReplaceOutcome; firstSetup: boolean }, exists = true) => {
    holder(exists);
    useE2EStore.setState({ keyBackupAttempt: attempt });
  };

  it.each(['changed', 'unknown', 'elsewhere'] as const)("claims nothing about the stored backup under '%s': no success line, the date and buttons stay", async (found) => {
    withNotice({ outcome: found, firstSetup: false });
    render();

    expect(text()).not.toContain('e2e.backupSetUp');
    expect(find('[data-testid="e2e-key-backup"] .text-vox-accent-success')).toBeNull();
    expect(text()).toContain('e2e.backupUpdatedAt');
    expect(button('e2e.backupReplaceAction')).not.toBeNull();
    expect(button('e2e.backupDeleteAction')).not.toBeNull();
  });

  it("still says recovery is set up under 'unchanged'", async () => {
    withNotice({ outcome: 'unchanged', firstSetup: false });
    render();
    expect(text()).toContain('e2e.backupSetUp');
  });

  it.each(['unchanged', 'unknown', 'elsewhere'] as const)(
    "asks before a new recovery key replaces a backup a saved key may still open ('%s')",
    async (found) => {
      withNotice({ outcome: found, firstSetup: false });
      render();

      await click(button('e2e.backupMakeNewKey'));

      expect(createKeyBackup).not.toHaveBeenCalled();
      expect(text()).toContain('e2e.backupReplaceConfirm');
      await click(button('e2e.backupReplaceAction'));
      expect(createKeyBackup).toHaveBeenCalledWith(USER_ID);
    }
  );

  it("asks first on a first setup under 'elsewhere': a key another device showed may open it", async () => {
    withNotice({ outcome: 'elsewhere', firstSetup: true });
    render();

    await click(button('e2e.backupMakeNewKey'));

    expect(createKeyBackup).not.toHaveBeenCalled();
    expect(text()).toContain('e2e.backupReplaceConfirm');
  });

  it('asks first even when the backup could not be read', async () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: null,
      keyBackupAttempt: { outcome: 'unknown', firstSetup: false },
    });
    render();

    await click(button('e2e.backupMakeNewKey'));

    expect(text()).toContain('e2e.backupReplaceConfirm');
    expect(createKeyBackup).not.toHaveBeenCalled();
  });

  it.each([
    ['changed, a backup stored', { outcome: 'changed', firstSetup: false }, true],
    ['changed, nothing stored', { outcome: 'changed', firstSetup: false }, false],
    ['a first setup, unchanged', { outcome: 'unchanged', firstSetup: true }, false],
    ['a first setup, unknown', { outcome: 'unknown', firstSetup: true }, false],
    ['a first setup, changed', { outcome: 'changed', firstSetup: true }, true],
  ] as const)('makes a new recovery key at once for %s: no saved key opens what is stored', async (_, attempt, exists) => {
    withNotice(attempt, exists);
    render();

    await click(button('e2e.backupMakeNewKey'));

    expect(createKeyBackup).toHaveBeenCalledWith(USER_ID);
    expect(text()).not.toContain('e2e.backupReplaceConfirm');
  });

  it("says this device's recent attempts did not write the backup, politely, and offers to check, replace or dismiss", async () => {
    withNotice({ outcome: 'elsewhere', firstSetup: false });
    render();

    expect(outcome()).toBe('elsewhere');
    expect(politeText()).toBe('e2e.backupStoredElsewhere');
    expect(alertText()).toBeNull();
    expect(text()).not.toContain('e2e.backupSetUp');
    expect(button('e2e.backupCheckAgain')).not.toBeNull();
    expect(button('e2e.backupMakeNewKey')).not.toBeNull();

    await click(button('e2e.backupDismiss'));

    expect(dismissKeyBackupWrite).toHaveBeenCalledWith(USER_ID);
    expect(outcome()).toBeNull();
  });

  it('keeps the notice and says so when a dismiss fails', async () => {
    withNotice({ outcome: 'elsewhere', firstSetup: false });
    dismissKeyBackupWrite.mockRejectedValueOnce(new Error('the vault failed'));
    render();

    await click(button('e2e.backupDismiss'));

    expect(toastError).toHaveBeenCalledWith('e2e.backupDismissFailed');
    expect(outcome()).toBe('elsewhere');
  });

  it('lets a notice about a backup that is gone be dismissed', async () => {
    withNotice({ outcome: 'changed', firstSetup: false }, false);
    render();

    expect(alertText()).toBe('e2e.backupReplaceGone');
    expect(button('e2e.backupDismiss')).not.toBeNull();
  });

  it("offers no dismiss for this device's own write that landed, which a new key ends", () => {
    withNotice({ outcome: 'changed', firstSetup: false });
    render();
    expect(button('e2e.backupDismiss')).toBeNull();
  });

  const cannotMakeKey = [
    ['does not hold the account key', { canApprove: false, masterKeyConflict: false }],
    ['holds a key the account does not publish', { canApprove: true, masterKeyConflict: true }],
  ] as const;

  it.each(cannotMakeKey)(
    "says a device that %s cannot make a new recovery key, and keeps a landing of this device's own: no dismiss",
    (_, flags) => {
      withNotice({ outcome: 'changed', firstSetup: false });
      useE2EStore.setState(flags);
      render();

      expect(find('[data-testid="e2e-backup-cannot-make"]')?.textContent).toBe('e2e.backupCannotMakeKey');
      expect(button('e2e.backupMakeNewKey')).toBeNull();
      // a backup is stored that no key shown opens: the warning is true, and stays
      expect(button('e2e.backupDismiss')).toBeNull();
      expect(text()).not.toContain('e2e.backupSetUp');
    }
  );

  it.each(cannotMakeKey)("lets a notice that is not a landing of this device's own be dismissed on a device that %s", (_, flags) => {
    withNotice({ outcome: 'unchanged', firstSetup: false });
    useE2EStore.setState(flags);
    render();

    expect(button('e2e.backupDismiss')).not.toBeNull();
  });

  it('says so instead of a generic failure when making the key turns out impossible here', async () => {
    withNotice({ outcome: 'changed', firstSetup: false });
    createKeyBackup.mockRejectedValueOnce(new E2EKeyBackupUnavailableError('This device does not hold the account key'));
    render();

    await click(button('e2e.backupMakeNewKey'));

    expect(toastError).not.toHaveBeenCalled();
    expect(find('[data-testid="e2e-backup-cannot-make"]')).not.toBeNull();
    expect(button('e2e.backupMakeNewKey')).toBeNull();
    expect(button('e2e.backupDismiss')).toBeNull();
  });

  it.each([
    ['masterKeyConflict', true, false],
    ['canApprove', false, true],
  ] as const)('offers a new recovery key again once %s changes after a refusal', async (flag, first, then) => {
    withNotice({ outcome: 'changed', firstSetup: false });
    createKeyBackup.mockRejectedValueOnce(new E2EKeyBackupUnavailableError('This account publishes a different key'));
    render();
    await click(button('e2e.backupMakeNewKey'));
    expect(button('e2e.backupMakeNewKey')).toBeNull();

    // what the device holds is read again (a restore, an approval, the conflict resolved)
    act(() => useE2EStore.setState({ [flag]: first }));
    act(() => useE2EStore.setState({ [flag]: then }));

    expect(button('e2e.backupMakeNewKey')).not.toBeNull();
  });

  it('says recovery is set up when a check ends with nothing pending and a backup stored', async () => {
    withNotice({ outcome: 'unchanged', firstSetup: false });
    // the stored backup is the one whose key this device showed: the record goes
    checkKeyBackupWrite.mockImplementationOnce(async () => {
      useE2EStore.setState({ keyBackupAttempt: null, keyBackupJudged: true });
      return null;
    });
    render();

    await click(button('e2e.backupCheckAgain'));

    expect(toastSuccess).toHaveBeenCalledWith('e2e.backupSetUp');
    expect(outcome()).toBeNull();
  });

  it('says nothing is set up when a check ends with nothing pending and no backup stored', async () => {
    withNotice({ outcome: 'unchanged', firstSetup: true }, false);
    checkKeyBackupWrite.mockImplementationOnce(async () => {
      useE2EStore.setState({ keyBackupAttempt: null, keyBackupJudged: true });
      return null;
    });
    render();

    await click(button('e2e.backupCheckAgain'));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(outcome()).toBeNull();
  });

  it.each([
    ['shows a notice', { keyBackupAttempt: { outcome: 'changed' as const, firstSetup: false }, keyBackupJudged: true }],
    ['is not judged', { keyBackupAttempt: null, keyBackupJudged: false }],
  ])('says nothing when a check ends with nothing pending but the panel %s', async (_what, shown) => {
    withNotice({ outcome: 'unchanged', firstSetup: false });
    // a later load was asked meanwhile, and the panel shows what it found
    checkKeyBackupWrite.mockImplementationOnce(async () => {
      useE2EStore.setState(shown);
      return null;
    });
    render();

    await click(button('e2e.backupCheckAgain'));

    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("mounts the polite region before its text when the notice is there as the panel opens", () => {
    withNotice({ outcome: 'unchanged', firstSetup: false });
    const observer = new MutationObserver(() => undefined);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    render();
    const records = observer.takeRecords();
    observer.disconnect();

    const region = notice()?.querySelector('[role="status"]');
    expect(region?.textContent).toBe('e2e.backupReplaceUnchanged');
    // the text arrived in the region after the region was in the page
    expect(records.some((r) => r.target === region && r.addedNodes.length > 0)).toBe(true);
  });

  it('shows nothing when the session ended during the attempt', async () => {
    holder(true);
    render();
    createKeyBackup.mockRejectedValueOnce(new E2EServiceDisposedError());

    await replace();

    expect(toastError).not.toHaveBeenCalled();
    expect(outcome()).toBeNull();
    expect(find('[data-testid="e2e-recovery-key"]')).toBeNull();
  });
});

describe('E2EDevicesSection — the panel load, over the service\'s own judging (spec §15.7)', () => {
  const OWN_BLOB = 'blob-sealed-by-this-device-in-a-write-never-confirmed';
  const OTHER_BLOB = 'blob-whose-recovery-key-was-shown';
  const notice = () => find('[data-testid="e2e-backup-unconfirmed"]');
  const outcome = () => notice()?.getAttribute('data-outcome') ?? null;

  /**
   * The service's own resolveKeyBackupWrite and keyBackupInfo, run over a vault
   * value and a backup route of the test's: the real judging, with no wasm and
   * no IndexedDB. The reads that judge carry a deadline signal; keyBackupInfo's
   * does not, so a test fails or holds the judging's read alone.
   */
  function judgingService(opts: {
    writes?: unknown;
    stored: string | null;
    judgingRead?: 'fails' | 'hangs';
    queue?: Promise<unknown>;
    /** keyBackupInfo's read is answered once this settles. */
    infoRead?: Promise<unknown>;
  }) {
    let writes = opts.writes;
    const vault = {
      getKeyBackupWrites: async () => writes,
      putKeyBackupWrites: async (value: unknown) => {
        writes = value;
      },
    };
    const get = vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      if (signal && opts.judgingRead === 'fails') {
        throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
      }
      if (signal && opts.judgingRead === 'hangs') {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
        });
      }
      if (!signal) await opts.infoRead;
      const data =
        opts.stored === null
          ? { exists: false, updatedAt: null }
          : { exists: true, blob: opts.stored, updatedAt: '2026-11-22T10:00:00.000Z' };
      return { data: { success: true, data } };
    });
    const service = Object.assign(Object.create(E2EService.prototype) as object, {
      linkingCode: () => 'WXYZ-2345',
      api: { get },
      vault,
      liveVault: vault,
      keyBackupConfirmedThisSession: null,
      keyBackupReadTimeoutMs: 20,
      enqueue: <T,>(fn: () => Promise<T>) => (opts.queue ?? Promise.resolve()).then(fn),
    });
    return { service, get };
  }

  /** Opens the panel over that service with the store's real load, and answers the load's promise. */
  function openPanel(service: object): Promise<void> {
    serviceStub.current = service;
    let loading: Promise<void> = Promise.resolve();
    useE2EStore.setState({
      loadKeyBackup: (userId: string) => (loading = E2E_INITIAL.loadKeyBackup(userId)),
    });
    render();
    return loading;
  }

  const holder = (state: Partial<ReturnType<typeof useE2EStore.getState>> = {}) => {
    useE2EStore.setState({ canApprove: true, ownDevices: ownDevices({ canApprove: true }), ...state });
  };

  it("keeps a 'changed' notice and says nothing is set up when the panel loads again and the judging's read fails", async () => {
    // a landing of this device's own with no record left, shown by an earlier load
    holder({
      keyBackup: { exists: true, updatedAt: '2026-11-22T10:00:00.000Z' },
      keyBackupAttempt: { outcome: 'changed', firstSetup: false },
      keyBackupJudged: true,
    });
    const { service } = judgingService({
      writes: { unconfirmed: [sha256Hex(OWN_BLOB)] },
      stored: OWN_BLOB,
      judgingRead: 'fails',
    });

    const loading = openPanel(service);
    await act(async () => {
      await loading;
    });

    expect(text()).not.toContain('e2e.backupSetUp');
    expect(outcome()).toBe('changed');
  });

  it.each(['fails', 'hangs'] as const)(
    "says nothing is set up on a fresh open when the judging's read %s, a backup stored",
    async (judgingRead) => {
      holder();
      const { service } = judgingService({
        writes: { unconfirmed: [sha256Hex(OWN_BLOB)] },
        stored: OTHER_BLOB,
        judgingRead,
      });

      const loading = openPanel(service);
      await act(async () => {
        await loading;
      });

      // the backup state shows, and nothing claims it is set up
      expect(text()).toContain('e2e.backupUpdatedAt');
      expect(text()).not.toContain('e2e.backupSetUp');
      // no outcome is made up for a check that found nothing out
      expect(outcome()).toBeNull();
    }
  );

  it('says nothing is set up while the judging of a record waits on the queue, and what it found once it answers', async () => {
    holder();
    let release!: () => void;
    const queue = new Promise<void>((resolve) => (release = resolve));
    const { service } = judgingService({
      writes: { pending: { baseline: sha256Hex(OTHER_BLOB) }, unconfirmed: [sha256Hex(OWN_BLOB)] },
      stored: OTHER_BLOB,
      queue,
    });

    const loading = openPanel(service);
    await act(async () => {
      await vi.waitFor(() => expect(useE2EStore.getState().keyBackup).not.toBeNull(), { timeout: 10_000 });
    });

    expect(text()).toContain('e2e.backupUpdatedAt');
    expect(text()).not.toContain('e2e.backupSetUp');

    release();
    await act(async () => {
      await loading;
    });
    expect(outcome()).toBe('unchanged');
    expect(text()).toContain('e2e.backupSetUp');
  });

  it.each([
    ['nothing pending and nothing sealed: no request beyond the backup state', undefined, 1],
    ['only digests left, none of them stored', { unconfirmed: [sha256Hex(OWN_BLOB)] }, 2],
  ] as const)('says recovery is set up once the load is judged, with %s', async (_, writes, requests) => {
    holder();
    const { service, get } = judgingService({ writes, stored: OTHER_BLOB });

    const loading = openPanel(service);
    await act(async () => {
      await loading;
    });

    expect(text()).toContain('e2e.backupSetUp');
    expect(outcome()).toBeNull();
    expect(get).toHaveBeenCalledTimes(requests);
  });

  it('on a reopen with nothing pending, leaves the line out until this load read the backup, then says it again', async () => {
    // an earlier load judged the backup and said recovery is set up
    holder({ keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' }, keyBackupJudged: true });
    let answer!: () => void;
    const infoRead = new Promise<void>((resolve) => (answer = resolve));
    const { service, get } = judgingService({ stored: OTHER_BLOB, infoRead });

    const loading = openPanel(service);
    await act(async () => {
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    });

    // the read of this load is not answered: the earlier verdict is not shown as this one's
    expect(text()).toContain('e2e.backupUpdatedAt');
    expect(text()).not.toContain('e2e.backupSetUp');

    answer();
    await act(async () => {
      await loading;
    });
    expect(text()).toContain('e2e.backupSetUp');
    // the judging asked nothing of the server
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('E2EDevicesSection — restoring from a recovery key', () => {
  /** A device that cannot approve: the only one with anything to restore. */
  const stranded = (exists: boolean) => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices(),
      keyBackup: { exists, updatedAt: exists ? '2026-07-01T00:00:00.000Z' : null },
      keyBackupJudged: true,
    });
  };

  it('offers a restore when a backup exists and this device cannot approve', () => {
    stranded(true);
    render();
    expect(find('[data-testid="e2e-restore-key-input"]')).not.toBeNull();
    expect(text()).toContain('e2e.backupRestoreExplainer');
  });

  it('says there is nothing to restore rather than showing an empty box', () => {
    stranded(false);
    render();
    expect(find('[data-testid="e2e-restore-key-input"]')).toBeNull();
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

    expect(find('[data-testid="e2e-restore-key-input"]')).not.toBeNull();
    expect(text()).toContain('e2e.backupRestoreExplainer');
  });

  it('does not offer a restore to a device that already holds the account key', () => {
    useE2EStore.setState({
      canApprove: true,
      ownDevices: ownDevices({ canApprove: true }),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
    render();
    expect(find('[data-testid="e2e-restore-key-input"]')).toBeNull();
    expect(text()).not.toContain('e2e.backupRestoreExplainer');
  });

  it('shows an error on a wrong key and does NOT claim success', async () => {
    restoreKeyBackup.mockRejectedValueOnce(new Error('does not open this backup'));
    stranded(true);
    render();

    await type(find('[data-testid="e2e-restore-key-input"]') as HTMLInputElement, 'AAAA-BBBB-CCCC');
    await click(button('e2e.backupRestoreAction'));

    expect(text()).toContain('e2e.backupRestoreFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
    // and the offer stays put, because nothing was recovered
    expect(find('[data-testid="e2e-restore-key-input"]')).not.toBeNull();
  });

  it('tells a typo apart from a key that simply is not yours', async () => {
    // The checksum on a recovery key exists for exactly this: "check it for
    // typos" is honest when the key never left the device, and misleading when
    // it did and did not open the account's backup — that one means this key
    // belongs to a different account identity, and retyping it will not help.
    restoreKeyBackup.mockRejectedValueOnce(new E2ERecoveryKeyFormatError());
    stranded(true);
    render();

    await type(find('[data-testid="e2e-restore-key-input"]') as HTMLInputElement, 'AAAA-BBBB');
    await click(button('e2e.backupRestoreAction'));

    expect(text()).toContain('e2e.backupRestoreMalformed');
    expect(text()).not.toContain('e2e.backupRestoreFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('clears the error as soon as the key is edited', async () => {
    restoreKeyBackup.mockRejectedValueOnce(new Error('does not open this backup'));
    stranded(true);
    render();

    const input = find('[data-testid="e2e-restore-key-input"]') as HTMLInputElement;
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

    await type(find('[data-testid="e2e-restore-key-input"]') as HTMLInputElement, RECOVERY_KEY);
    await click(button('e2e.backupRestoreAction'));

    expect(restoreKeyBackup).toHaveBeenCalledWith(USER_ID, RECOVERY_KEY);
    expect(toastSuccess).toHaveBeenCalledWith('e2e.backupRestoreSuccess');
    // the panel has flipped to the "you hold the account key" side…
    expect(find('[data-testid="e2e-restore-key-input"]')).toBeNull();
    expect(text()).toContain('e2e.backupSetUp');
    // …and the "you cannot approve devices" explainer is gone
    expect(text()).not.toContain('e2e.cannotApproveExplainer');
  });
});

describe('E2EDevicesSection — recovery before the last resort', () => {
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
