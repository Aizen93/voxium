import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation, User } from '@voxium/shared';

// Assert on translation KEYS, not copy: the point of these tests is which
// branch of the badge's title chain wins, and pinning English strings would
// make every wording tweak look like a behaviour change.
//
// Only `useTranslation` is replaced — authStore imports `../i18n`, which calls
// `i18n.use(initReactI18next)` at module load, so the real export has to stay.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { E2EControls } from '../../components/dm/E2EControls';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';

// React 19 refuses to run `act` outside a declared test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The DM header badge is the ONLY place a user is told that their account key
// is in conflict, that this device was never approved, or that a device the
// account key does not vouch for is reading their messages. A wrong branch here
// does not throw — it silently downgrades a security warning to "all good", so
// every precedence level gets its own test.

const PEER_ID = 'peer-1';
const OTHER_PEER_ID = 'peer-2';

/** Pristine store snapshots, captured before any test mutates them. */
const E2E_INITIAL = useE2EStore.getState();
const AUTH_INITIAL = useAuthStore.getState();

const conversation = (peerId = PEER_ID): Conversation =>
  ({
    id: 'conv-1',
    user1Id: 'me',
    user2Id: peerId,
    participant: { id: peerId, username: 'peer', displayName: 'Peer', avatarUrl: null },
    lastMessage: null,
    // always set: conversations are born encrypted (plan §4.2)
    encryptedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Conversation;

let container: HTMLDivElement;
let root: Root;

function resetStores() {
  // `refreshDeviceList` fires from an effect on every encrypted render; stubbing
  // it keeps these tests off the real E2E service (and its IndexedDB vault).
  useE2EStore.setState({ ...E2E_INITIAL, refreshDeviceList: vi.fn() }, true);
  useAuthStore.setState({ ...AUTH_INITIAL, user: { id: 'me' } as User }, true);
}

beforeEach(() => {
  resetStores();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(conv: Conversation) {
  act(() => {
    root.render(<E2EControls conversation={conv} />);
  });
}

const badge = () => container.querySelector('button');
const title = () => badge()?.getAttribute('title');

/**
 * The icon and the button colour are both driven by the single `warning` OR —
 * reading them separately from the title catches a chain that picks the right
 * words while rendering a reassuring green lock (or the reverse).
 */
function iconState(): 'warning' | 'ok' {
  const svg = container.querySelector('svg');
  const cls = svg?.getAttribute('class') ?? '';
  const alert = cls.includes('lucide-shield-alert');
  const lock = cls.includes('lucide-lock');
  expect(alert || lock, `unexpected badge icon: "${cls}"`).toBe(true);
  // the colour must agree with the glyph, they come from the same boolean
  expect(badge()?.className.includes('text-vox-accent-warning')).toBe(alert);
  return alert ? 'warning' : 'ok';
}

describe('E2EControls badge state machine', () => {
  it('renders nothing until the E2E store is ready', () => {
    // Before initialize() resolves there is no vault and no device list, so any
    // badge we drew would be asserting a trust state we have not checked yet.
    useE2EStore.setState({ ready: false, identityWarnings: { [PEER_ID]: true } });
    render(conversation());
    expect(container.innerHTML).toBe('');
    expect(badge()).toBeNull();
  });

  it('has no "unencrypted" state left to show', () => {
    // Every DM is encrypted since the always-on cutover, so the badge must not
    // branch on encryptedAt at all — even a row that somehow arrives without
    // the field reads as encrypted, rather than inviting someone to turn on
    // something that is already on. Rendered from a shape the type no longer
    // permits precisely to prove the field is never consulted.
    useE2EStore.setState({ ready: true });
    const withoutTimestamp = conversation();
    delete (withoutTimestamp as Partial<Conversation>).encryptedAt;
    render(withoutTimestamp);
    expect(title()).toBe('e2e.badgeTitle');
    expect(iconState()).toBe('ok');
  });

  it('shows the plain encrypted badge when nothing is wrong', () => {
    useE2EStore.setState({ ready: true });
    render(conversation());
    expect(title()).toBe('e2e.badgeTitle');
    expect(iconState()).toBe('ok');
  });

  it('lets a master-key conflict outrank every device-list warning', () => {
    // An account key this device can neither prove nor replace blocks approving
    // any new device, so it has to be the message even when the list is also
    // full of unsigned/new devices — fixing those first fixes nothing.
    useE2EStore.setState({
      ready: true,
      masterKeyConflict: true,
      thisDeviceUnsigned: true,
      ownUnsignedDevices: ['dev-x'],
      unsignedDeviceWarnings: { [PEER_ID]: ['dev-p'] },
      ownDeviceWarnings: ['dev-y'],
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.masterConflictBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('puts the person you are talking to above your own account state', () => {
    // A changed identity key is the one warning that is about THIS
    // conversation and about a possible interceptor. Our own account troubles,
    // however urgent for approving devices, are not what to read first here.
    useE2EStore.setState({
      ready: true,
      identityWarnings: { [PEER_ID]: true },
      masterKeyConflict: true,
      thisDeviceUnsigned: true,
    });
    render(conversation());
    expect(title()).toBe('e2e.identityChangedBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('puts "this device is not approved" above any peer- or own-device notice', () => {
    // This device being unsigned is the one the user can act on right now (from
    // another device); the other flags are consequences other people see.
    useE2EStore.setState({
      ready: true,
      thisDeviceUnsigned: true,
      ownUnsignedDevices: ['dev-x'],
      unsignedDeviceWarnings: { [PEER_ID]: ['dev-p'] },
      ownDeviceWarnings: ['dev-y'],
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.thisDeviceUnsignedBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('reports an unsigned PEER device ahead of own-device and new-device notices', () => {
    // "Not signed by their account key" cannot be acknowledged away, unlike the
    // new-device notice it outranks — it stays until approved or revoked.
    useE2EStore.setState({
      ready: true,
      unsignedDeviceWarnings: { [PEER_ID]: ['dev-p'] },
      ownDeviceWarnings: ['dev-y'],
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.unsignedDeviceBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('reports an unsigned device on OUR OWN account with the same title', () => {
    // Same class of problem seen from the other side: a device of ours the
    // account key does not vouch for still receives every session key we fan out.
    useE2EStore.setState({
      ready: true,
      ownUnsignedDevices: ['dev-x'],
      ownDeviceWarnings: ['dev-y'],
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.unsignedDeviceBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('reports an unrecognised device on our account ahead of a peer new-device notice', () => {
    useE2EStore.setState({
      ready: true,
      ownDeviceWarnings: ['dev-y'],
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.ownDeviceBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('reports a peer new-device notice when nothing else is flagged', () => {
    useE2EStore.setState({ ready: true, newDeviceWarnings: { [PEER_ID]: ['dev-n'] } });
    render(conversation());
    expect(title()).toBe('e2e.newDeviceBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('names an identity change instead of captioning the alarm with reassurance', () => {
    // This is the strongest MITM signal in the whole design. It used to raise
    // the amber icon over the tooltip "End-to-end encrypted — view safety
    // number", so the one state that most deserves a second look read as
    // confirmation that everything was fine.
    useE2EStore.setState({ ready: true, identityWarnings: { [PEER_ID]: true } });
    render(conversation());
    expect(title()).toBe('e2e.identityChangedBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('reports the identity change rather than the new device it caused', () => {
    // A changed identity key makes the whole device list new, so "they added a
    // device" would describe a symptom and hide the cause.
    useE2EStore.setState({
      ready: true,
      identityWarnings: { [PEER_ID]: true },
      newDeviceWarnings: { [PEER_ID]: ['dev-n'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.identityChangedBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('does not light up this badge for warnings that belong to a DIFFERENT peer', () => {
    // Every per-peer map is keyed by the conversation participant. Leaking one
    // peer's warning onto another conversation would train users to ignore it.
    useE2EStore.setState({
      ready: true,
      identityWarnings: { [OTHER_PEER_ID]: true },
      newDeviceWarnings: { [OTHER_PEER_ID]: ['dev-n'] },
      unsignedDeviceWarnings: { [OTHER_PEER_ID]: ['dev-p'] },
    });
    render(conversation());
    expect(title()).toBe('e2e.badgeTitle');
    expect(iconState()).toBe('ok');
  });

  it('reports an account-wide problem on every conversation', () => {
    // Account-scoped flags used to be suppressed on plaintext DMs, because the
    // badge there was a "turn encryption on" button and warning about a device
    // would have captioned something the click could not act on. There is no
    // such button any more, so the warning belongs everywhere it applies.
    useE2EStore.setState({
      ready: true,
      ownDeviceWarnings: ['dev-y'],
      thisDeviceUnsigned: true,
      masterKeyConflict: true,
    });
    render(conversation());
    expect(title()).toBe('e2e.masterConflictBadgeTitle');
    expect(badge()?.getAttribute('aria-label')).toBe('e2e.masterConflictBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('gives assistive tech the same warning sighted users hover for', () => {
    // The aria-label used to be a fixed "encrypted"/"enable" string, so a
    // screen-reader user was told the conversation was encrypted while the
    // badge was amber over a conflict. An alert nobody can hover is not alert.
    useE2EStore.setState({ ready: true, masterKeyConflict: true });
    render(conversation());
    expect(badge()?.getAttribute('aria-label')).toBe('e2e.masterConflictBadgeTitle');
    expect(title()).toBe('e2e.masterConflictBadgeTitle');
    expect(iconState()).toBe('warning');
  });

  it('raises the alert icon for EVERY warning flag on its own', () => {
    // The icon comes from a seven-term OR, and the precedence tests above set
    // several flags at once — so dropping one term from that OR could still
    // leave them green. Each flag is therefore also exercised in isolation:
    // whichever branch wins the title, the badge must never look reassuring
    // while one of these is set.
    const cases: Array<[string, Partial<ReturnType<typeof useE2EStore.getState>>]> = [
      ['identityWarnings[peer]', { identityWarnings: { [PEER_ID]: true } }],
      ['newDeviceWarnings[peer]', { newDeviceWarnings: { [PEER_ID]: ['dev-n'] } }],
      ['ownDeviceWarnings', { ownDeviceWarnings: ['dev-y'] }],
      ['unsignedDeviceWarnings[peer]', { unsignedDeviceWarnings: { [PEER_ID]: ['dev-p'] } }],
      ['ownUnsignedDevices', { ownUnsignedDevices: ['dev-x'] }],
      ['thisDeviceUnsigned', { thisDeviceUnsigned: true }],
      ['masterKeyConflict', { masterKeyConflict: true }],
    ];

    for (const [label, patch] of cases) {
      resetStores();
      useE2EStore.setState({ ready: true });
      useE2EStore.setState(patch);
      render(conversation());
      expect(iconState(), `${label} left the badge looking safe`).toBe('warning');
    }
  });
});
