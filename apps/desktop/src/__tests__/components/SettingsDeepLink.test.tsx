import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation, User } from '@voxium/shared';

/**
 * Account-level E2E management moved out of the DM lock badge and into
 * Settings → Security (plan §4.5). Two things have to hold for that move to be
 * a move rather than a removal:
 *
 *  1. Something can point at the Security tab — `openSettings('security')` —
 *     and the request is spent once, so an ordinary "open settings" afterwards
 *     still lands on the default tab. A sticky request would silently turn
 *     every settings click into a security click.
 *  2. The DM safety-number modal hands off instead of hosting: the per-contact
 *     safety number stays where it is, and the device list is somewhere else.
 *     If that button kept rendering a device manager, account state would have
 *     two homes and the move would have bought nothing.
 */

// Translation KEYS, not copy — the assertions are about which tab is on screen,
// not this week's wording.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// No real crypto service (and no wasm engine or IndexedDB vault) behind a
// render test: the safety-number modal loads from it on mount, and the devices
// section reads this device's linking code from it.
vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({
      linkingCode: () => 'WXYZ-2345',
      accountSafetyNumber: async () => null,
      perDeviceSafetyNumbers: async () => [],
    }),
  };
});

import { SettingsModal } from '../../components/settings/SettingsModal';
import { E2EControls } from '../../components/dm/E2EControls';
import { useSettingsStore } from '../../stores/settingsStore';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER_ID = 'me';
const PEER_ID = 'peer-1';

const E2E_INITIAL = useE2EStore.getState();
const AUTH_INITIAL = useAuthStore.getState();

const conversation = (): Conversation =>
  ({
    id: 'conv-1',
    user1Id: USER_ID,
    user2Id: PEER_ID,
    participant: { id: PEER_ID, username: 'peer', displayName: 'Peer', avatarUrl: null },
    lastMessage: null,
    encryptedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Conversation;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useE2EStore.setState(
    {
      ...E2E_INITIAL,
      ready: true,
      refreshDeviceList: vi.fn(),
      loadOwnDevices: vi.fn<(userId: string) => Promise<void>>(async () => {}),
      loadKeyBackup: vi.fn<(userId: string) => Promise<void>>(async () => {}),
    },
    true
  );
  useAuthStore.setState({ ...AUTH_INITIAL, user: { id: USER_ID } as User }, true);
  useSettingsStore.setState({ isSettingsOpen: false, initialSettingsTab: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSettingsStore.setState({ isSettingsOpen: false, initialSettingsTab: null });
  vi.clearAllMocks();
});

const text = () => document.body.textContent ?? '';
const find = (selector: string) => document.body.querySelector(selector);

/** Mirrors MainLayout: the modal is mounted fresh whenever settings open. */
function SettingsHost() {
  const open = useSettingsStore((s) => s.isSettingsOpen);
  return open ? <SettingsModal /> : null;
}

function mountHost() {
  act(() => {
    root.render(<SettingsHost />);
  });
}

function open(tab?: Parameters<ReturnType<typeof useSettingsStore.getState>['openSettings']>[0]) {
  act(() => {
    useSettingsStore.getState().openSettings(tab);
  });
}

function close() {
  act(() => {
    useSettingsStore.getState().closeSettings();
  });
}

/** Which tab's content is on screen, asserted on what it renders. */
const showsSecurity = () =>
  text().includes('settings.security.changePassword') && !!find('[data-testid="e2e-devices-section"]');
const showsAccount = () => text().includes('settings.profile.displayName');

describe('settings deep link', () => {
  it('opens on the Security tab when one is requested', () => {
    mountHost();
    open('security');

    expect(showsSecurity(), 'openSettings("security") did not land on Security').toBe(true);
    expect(showsAccount()).toBe(false);
  });

  it('opens on the default tab with no argument, exactly as before', () => {
    mountHost();
    open();

    expect(showsAccount()).toBe(true);
    expect(find('[data-testid="e2e-devices-section"]')).toBeNull();
  });

  it('spends the request, so the NEXT plain open goes back to the default', () => {
    // The whole point of clearing it. A request left in the store would make
    // every later "open settings" re-open wherever the last shortcut pointed.
    mountHost();
    open('security');
    expect(showsSecurity()).toBe(true);
    expect(useSettingsStore.getState().initialSettingsTab, 'the request was not consumed').toBeNull();

    close();
    open();

    expect(showsAccount(), 'a plain openSettings() re-opened the deep-linked tab').toBe(true);
    expect(find('[data-testid="e2e-devices-section"]')).toBeNull();
  });

  it('honours a request that arrives while settings are already open', () => {
    mountHost();
    open();
    expect(showsAccount()).toBe(true);

    open('security');

    expect(showsSecurity()).toBe(true);
    expect(useSettingsStore.getState().initialSettingsTab).toBeNull();
  });
});

describe('the DM safety-number modal hands devices off to settings', () => {
  function openSafetyNumberModal() {
    act(() => {
      root.render(<E2EControls conversation={conversation()} />);
    });
    // The badge on an encrypted conversation opens the per-contact modal.
    act(() => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  const manageDevices = () =>
    [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'e2e.manageDevices'
    ) ?? null;

  it('opens settings on Security instead of stacking another modal', async () => {
    openSafetyNumberModal();
    const button = manageDevices();
    expect(button, 'no way to reach devices from the safety-number modal').not.toBeNull();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useSettingsStore.getState().isSettingsOpen).toBe(true);
    expect(useSettingsStore.getState().initialSettingsTab).toBe('security');
    // It hands off and gets out of the way rather than leaving itself behind.
    expect(text()).not.toContain('e2e.safetyNumberTitle');
  });

  it('renders no device manager of its own', async () => {
    // The regression this guards: account-level state having two homes again.
    openSafetyNumberModal();
    await act(async () => {
      manageDevices()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(find('[data-testid="e2e-devices-section"]')).toBeNull();
    expect(text()).not.toContain('e2e.deviceManagerExplainer');
    expect(find('[data-testid="e2e-device-linking"]')).toBeNull();
    expect(find('[data-testid="e2e-reset-identity"]')).toBeNull();
  });

  it('keeps the per-contact safety number in the DM, where it belongs', () => {
    // Verifying a contact is genuinely per contact — it did not move.
    openSafetyNumberModal();
    expect(text()).toContain('e2e.safetyNumberTitle');
    expect(text()).toContain('e2e.accountSafetyExplainer');
  });
});
