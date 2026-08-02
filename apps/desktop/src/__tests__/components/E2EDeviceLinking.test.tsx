import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { User } from '@voxium/shared';

/**
 * Translation KEYS, not copy — but interpolation is kept, because half of what
 * this flow has to prove is that the confirmation NAMES the device it is about
 * to approve. A `t` that dropped its variables would let "Approve this device?"
 * with no id at all pass every assertion below.
 */
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) =>
        vars
          ? `${key} ${Object.entries(vars)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' ')}`
          : key,
    }),
  };
});

// hoisted: vi.mock factories run before module-level consts exist
const { toastSuccess, toastError, linkingCode } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  linkingCode: vi.fn<() => string>(() => 'WXYZ-2345'),
}));
vi.mock('../../stores/toastStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/toastStore')>();
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: toastError } };
});
// The component asks the service for THIS device's own code. Stubbing the
// accessor keeps the real crypto service (and its wasm engine + IndexedDB
// vault) out of a render test; the derivation itself is covered in the
// service's own tests.
vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return { ...actual, getE2EService: () => ({ linkingCode }) };
});

import { E2EDevicesSection, deviceLinkingMode } from '../../components/settings/E2EDevicesSection';
import {
  useE2EStore,
  E2ELinkingCodeUnknownError,
  type E2ELinkableDevice,
} from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { E2ELinkingCodeAmbiguousError, type E2EOwnDevices } from '../../services/e2e/e2eService';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Device linking (docs/e2e-always-on-plan.md §4.3) replaces "find the strange
 * device in a list and press Approve" with "type the code your new device is
 * showing". The code itself grants nothing — approving still needs this device
 * to hold the account key and its user to act — so the risk that remains is
 * PHISHING: someone talked into typing a code that is not theirs. The only
 * mitigation is that this device says what it is about to approve, and waits.
 * Every test here is either about that pause existing, or about the user being
 * able to tell a mistyped code from a broken lookup.
 */

const USER_ID = 'me';
/** The code the user types: a device of theirs, in another room, is showing it. */
const CODE = 'ABCD-2345';
const LINKED: E2ELinkableDevice = {
  deviceId: 'new-laptop-device-id',
  createdAt: '2026-07-30T09:15:00.000Z',
};

const E2E_INITIAL = useE2EStore.getState();
const AUTH_INITIAL = useAuthStore.getState();

let container: HTMLDivElement;
let root: Root;
let linkDevice: Mock<(userId: string, code: string) => Promise<E2ELinkableDevice>>;
let approveLinkedDevice: Mock<(userId: string, deviceId: string) => Promise<void>>;
let approveDevice: Mock<(userId: string, deviceId: string) => Promise<void>>;

const device = (overrides: Partial<E2EOwnDevices['devices'][number]> = {}) => ({
  deviceId: 'this-device',
  curve25519Key: 'c',
  ed25519Key: 'e',
  deviceSignature: 's',
  masterSignature: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  crossSigned: false,
  ...overrides,
});

const ownDevices = (overrides: Partial<E2EOwnDevices> = {}): E2EOwnDevices => ({
  currentDeviceId: 'this-device',
  devices: [device()],
  listVersion: 1,
  masterKey: 'M',
  canApprove: false,
  capabilityServed: true,
  ...overrides,
});

/** A fresh install: registered, unsigned, unable to read anything yet. */
const unapprovedDevice = () => {
  useE2EStore.setState({
    canApprove: false,
    thisDeviceUnsigned: true,
    ownDevices: ownDevices(),
    keyBackup: { exists: false, updatedAt: null },
  });
};

/** A device that already holds the account key: the one that does the approving. */
const approvedDevice = () => {
  useE2EStore.setState({
    canApprove: true,
    thisDeviceUnsigned: false,
    ownDevices: ownDevices({
      canApprove: true,
      devices: [
        device({ crossSigned: true, masterSignature: 'm' }),
        device({ deviceId: LINKED.deviceId, createdAt: LINKED.createdAt }),
      ],
    }),
    keyBackup: { exists: false, updatedAt: null },
  });
};

beforeEach(() => {
  linkDevice = vi.fn<(userId: string, code: string) => Promise<E2ELinkableDevice>>(async () => LINKED);
  approveLinkedDevice = vi.fn<(userId: string, deviceId: string) => Promise<void>>(async () => {});
  approveDevice = vi.fn<(userId: string, deviceId: string) => Promise<void>>(async () => {});
  linkingCode.mockReturnValue('WXYZ-2345');
  useE2EStore.setState(
    {
      ...E2E_INITIAL,
      ready: true,
      loadOwnDevices: vi.fn<(userId: string) => Promise<void>>(async () => {}),
      loadKeyBackup: vi.fn<(userId: string) => Promise<void>>(async () => {}),
      linkDevice,
      approveLinkedDevice,
      approveDevice,
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
const input = () => find('[data-testid="e2e-link-code-input"]') as HTMLInputElement | null;

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

/** Walk the whole flow up to (but not through) the confirmation. */
async function enterCode(code = CODE) {
  await type(input()!, code);
  await click(button('e2e.linkAction'));
}

describe('deviceLinkingMode', () => {
  it('says the panel is not ready instead of showing an empty device list', () => {
    // The DM badge used to be the only way in, and it renders nothing until
    // the store is ready. In Settings the tab is always reachable, so without
    // this the heading sits over an empty list — which reads as "you have no
    // devices" rather than "ask again in a moment".
    useE2EStore.setState({ ready: false, ownDevices: null });
    render();

    expect(text()).toContain('e2e.devicesNotReady');
    // …and none of the account-level actions are offered in that state
    expect(text()).not.toContain('e2e.linkTitle');
    expect(text()).not.toContain('e2e.resetIdentityAction');
  });

  it('shows a code on a device that is not approved yet', () => {
    expect(deviceLinkingMode({ thisDeviceUnsigned: true, canApprove: false })).toBe('show');
  });

  it('asks for a code on a device that holds the account key', () => {
    expect(deviceLinkingMode({ thisDeviceUnsigned: false, canApprove: true })).toBe('enter');
  });

  it('says nothing on a device that is approved and has nothing to link', () => {
    // Not "no opinion": rendering an empty linking box on the ordinary healthy
    // state is how a security screen turns into noise people scroll past.
    expect(deviceLinkingMode({ thisDeviceUnsigned: false, canApprove: false })).toBeNull();
  });

  it('lets a device that can approve act rather than wait', () => {
    // Holding the account key beats being unsigned: showing this device a code
    // to be approved WITH would ask it to wait for permission it already has.
    expect(deviceLinkingMode({ thisDeviceUnsigned: true, canApprove: true })).toBe('enter');
  });
});

describe('E2EDevicesSection — the device being linked', () => {
  it('shows this device its own linking code', () => {
    unapprovedDevice();
    render();

    const code = find('[data-testid="e2e-linking-code"]');
    expect(code?.textContent).toBe('WXYZ-2345');
    // Read off a screen and typed on another machine, or copied: both have to
    // work, and a half-selected code matches no device at all.
    expect(code?.className).toContain('font-mono');
    expect(code?.className).toContain('select-all');
    expect(button('common.copy'), 'no way to copy the code').not.toBeNull();
    // …and it says what to DO with it, or the code is a riddle.
    expect(text()).toContain('e2e.linkCodeExplainer');
  });

  it('does not show a linking code once this device is approved', () => {
    // The code names an UNAPPROVED device. Displaying one here would invite the
    // user to type their own approved device's code somewhere and be told,
    // correctly but uselessly, that no device is showing it.
    approvedDevice();
    render();

    expect(find('[data-testid="e2e-linking-code"]')).toBeNull();
    expect(text()).not.toContain('e2e.linkCodeExplainer');
    expect(input(), 'the approved device is the one that takes a code').not.toBeNull();
  });

  it('offers no linking box at all on an approved device with nothing pending', () => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: false,
      ownDevices: ownDevices({ devices: [device({ crossSigned: true, masterSignature: 'm' })] }),
      keyBackup: { exists: false, updatedAt: null },
    });
    render();

    expect(find('[data-testid="e2e-device-linking"]')).toBeNull();
  });

  it('falls back to the old explainer when no code can be derived', () => {
    // The vault may not have account keys loaded. A placeholder code would be
    // read out, rejected, and blamed on the user — so nothing is shown, and the
    // sentence that still tells them how this device gets approved comes back.
    linkingCode.mockImplementation(() => {
      throw new Error('account not loaded');
    });
    unapprovedDevice();
    render();

    expect(find('[data-testid="e2e-device-linking"]')).toBeNull();
    expect(text()).toContain('e2e.cannotApproveExplainer');
  });
});

describe('E2EDevicesSection — approving by code', () => {
  it('looks a code up and stops, naming the device before anything happens', async () => {
    approvedDevice();
    render();

    await enterCode();

    expect(linkDevice).toHaveBeenCalledWith(USER_ID, CODE);
    expect(
      approveLinkedDevice,
      'a typed code approved a device with no confirmation — this is the phishing step'
    ).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();

    // What the user gets to check against the machine in front of them —
    // scoped to the confirmation itself, since the device list further down
    // names the same device and would satisfy a document-wide search.
    const confirm = find('[data-testid="e2e-link-confirm"]');
    expect(confirm).not.toBeNull();
    const confirmText = confirm!.textContent ?? '';
    expect(confirmText).toContain('e2e.linkConfirmTitle');
    expect(confirmText, 'the confirmation does not say WHICH device').toContain('new-la…e-id');
    expect(confirmText, 'the confirmation does not say when it registered').toContain(
      new Date(LINKED.createdAt).toLocaleString()
    );
    expect(confirmText).toContain('e2e.linkConfirmExplainer');
  });

  it('approves exactly the device the lookup returned, and only on confirm', async () => {
    approvedDevice();
    render();
    await enterCode();

    await click(button('e2e.linkConfirmAction'));

    expect(approveLinkedDevice).toHaveBeenCalledTimes(1);
    expect(approveLinkedDevice).toHaveBeenCalledWith(USER_ID, LINKED.deviceId);
    expect(toastSuccess).toHaveBeenCalledWith('e2e.approveDeviceSuccess');
    // and the flow resets rather than leaving a spent code in the box
    expect(find('[data-testid="e2e-link-confirm"]')).toBeNull();
    expect(input()?.value).toBe('');
  });

  it('approves nothing when the confirmation is declined', async () => {
    approvedDevice();
    render();
    await enterCode();

    await click(button('common.cancel'));

    expect(approveLinkedDevice).not.toHaveBeenCalled();
    expect(find('[data-testid="e2e-link-confirm"]')).toBeNull();
    // the code survives: backing out of a confirmation is not a typo
    expect(input()?.value).toBe(CODE);
  });

  it('reports a failed approval instead of claiming the device is linked', async () => {
    approveLinkedDevice.mockRejectedValueOnce(new Error('rate limited'));
    approvedDevice();
    render();
    await enterCode();

    await click(button('e2e.linkConfirmAction'));

    expect(toastError).toHaveBeenCalledWith('e2e.approveDeviceFailed');
    expect(toastSuccess).not.toHaveBeenCalled();
    // still on the confirmation, so the user can try the same device again
    expect(find('[data-testid="e2e-link-confirm"]')).not.toBeNull();
  });

  it('will not look up an empty code', () => {
    approvedDevice();
    render();
    expect(button('e2e.linkAction')!.disabled).toBe(true);
  });

  it('lets Enter run the lookup, and still refuses to approve without a confirm', async () => {
    // Enter is safe here only because the lookup is inert. If it ever reached
    // the approval, the confirmation step would be one keystroke of muscle
    // memory away from never being read.
    approvedDevice();
    render();

    await type(input()!, CODE);
    await act(async () => {
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(linkDevice).toHaveBeenCalledWith(USER_ID, CODE);
    expect(find('[data-testid="e2e-link-confirm"]')).not.toBeNull();
    expect(approveLinkedDevice).not.toHaveBeenCalled();
  });
});

describe('E2EDevicesSection — a code that names nothing', () => {
  it('says so specifically, approves nothing, and leaves the code alone', async () => {
    linkDevice.mockRejectedValueOnce(new E2ELinkingCodeUnknownError(CODE));
    approvedDevice();
    render();

    await enterCode();

    expect(text()).toContain('e2e.linkUnknownCode');
    expect(text()).not.toContain('e2e.linkLookupFailed');
    expect(find('[data-testid="e2e-link-confirm"]')).toBeNull();
    expect(approveLinkedDevice).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // One wrong character should cost one keystroke, not a walk back to the
    // other device to re-read the whole code.
    expect(input()?.value).toBe(CODE);
  });

  it('tells a code nobody is showing apart from a lookup that failed', async () => {
    // Different answers: retype the code, versus try again in a minute. Saying
    // "no device is showing that code" to someone who is offline sends them
    // hunting for a mistake that is not theirs.
    linkDevice.mockRejectedValueOnce(new Error('network error'));
    approvedDevice();
    render();

    await enterCode();

    expect(text()).toContain('e2e.linkLookupFailed');
    expect(text()).not.toContain('e2e.linkUnknownCode');
    expect(approveLinkedDevice).not.toHaveBeenCalled();
  });

  it('refuses a code two devices answer to, and says why (not "try again")', async () => {
    // At 80 bits a collision is not an accident, so this is an attack shape:
    // something registered a device to sit next to the real one in the list.
    // Rendering it as a generic failure would invite the user to retry until
    // one of them happened to come back alone.
    linkDevice.mockRejectedValueOnce(new E2ELinkingCodeAmbiguousError());
    approvedDevice();
    render();

    await enterCode();

    expect(text()).toContain('e2e.linkAmbiguousCode');
    expect(text()).not.toContain('e2e.linkLookupFailed');
    expect(text()).not.toContain('e2e.linkUnknownCode');
    expect(find('[data-testid="e2e-link-confirm"]')).toBeNull();
    expect(approveLinkedDevice).not.toHaveBeenCalled();
  });

  it('clears the complaint as soon as the code is edited', async () => {
    linkDevice.mockRejectedValueOnce(new E2ELinkingCodeUnknownError(CODE));
    approvedDevice();
    render();
    await enterCode();
    expect(text()).toContain('e2e.linkUnknownCode');

    await type(input()!, 'ABCD-2346');

    expect(text()).not.toContain('e2e.linkUnknownCode');
  });
});

describe('E2EDevicesSection — linking comes before the recovery paths', () => {
  /**
   * Order is the message. On an unapproved device all three sections offer a
   * way forward, and they are not equal: linking costs nothing and needs only
   * the other device; restoring needs a recovery key the user may never have
   * made; the reset mints a new account key and makes every contact verify
   * this account again. A user reading top to bottom must meet them in that
   * order, so this is asserted on document position rather than on styling —
   * a `mb-3` or an `order-` class cannot be trusted to say what came first.
   */
  const strandedWithBackup = () => {
    useE2EStore.setState({
      canApprove: false,
      thisDeviceUnsigned: true,
      ownDevices: ownDevices(),
      keyBackup: { exists: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
  };

  it('puts the linking code above both the restore and the identity reset', () => {
    strandedWithBackup();
    render();

    const linking = find('[data-testid="e2e-device-linking"]');
    const restore = find('[data-testid="e2e-key-backup"]');
    const reset = find('[data-testid="e2e-reset-identity"]');
    expect(linking, 'no linking code offered on an unapproved device').not.toBeNull();
    expect(restore, 'the recovery-key restore must stay available').not.toBeNull();
    expect(reset, 'the last-resort reset must stay available').not.toBeNull();

    expect(
      linking!.compareDocumentPosition(restore!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the recovery-key restore is presented before the linking code that needs no key at all'
    ).toBeTruthy();
    expect(
      linking!.compareDocumentPosition(reset!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the destructive identity reset is presented before the linking code'
    ).toBeTruthy();
  });

  it('does not repeat "approve it from another device" next to the code', () => {
    // The code IS that instruction, with something to act on. The older
    // sentence beside it is the same advice with nothing attached.
    unapprovedDevice();
    render();

    expect(find('[data-testid="e2e-linking-code"]')).not.toBeNull();
    expect(text()).not.toContain('e2e.cannotApproveExplainer');
  });
});
