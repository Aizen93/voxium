import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Conversation, UserStatus, VoiceUser } from '@voxium/shared';

/**
 * The spaces strip: the navigation along the top, in two captioned zones.
 *
 * The contract that keeps it a strip, not a rail: it never lists every
 * server. At most MAX_TABS are visible in stable store order, the active
 * space is an expanded named tab, the long tail collapses into "+N" (with
 * aggregated unread), and a space with people in voice carries a live mark
 * wherever it is. Everything else is one click away in the spaces menu.
 *
 * Issue 6 (docs/local/spaces-dm-navigation-plan.html, Concept E): the way to
 * Direct Messages is a LABELLED tab in both contexts with the three most
 * recent people next to it; "New space" is a labelled tab after the tab row;
 * and the whole strip can fold into a notch that slides out a chamfered panel
 * on hover, shortcut, focus or tap (`settingsStore.spacesStripMode`).
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const { setActiveServer, clearActiveConversation, setActiveConversation, togglePinServer, setShowFriendsView, setShowSupportView, setSpacesStripMode, serverSetState } =
  vi.hoisted(() => ({
    setActiveServer: vi.fn(),
    clearActiveConversation: vi.fn(),
    setActiveConversation: vi.fn(),
    togglePinServer: vi.fn(),
    setShowFriendsView: vi.fn(),
    setShowSupportView: vi.fn(),
    setSpacesStripMode: vi.fn(),
    serverSetState: vi.fn(),
  }));

let servers: Array<{ id: string; name: string; iconUrl?: string | null }> = [];
let activeServerId: string | null = null;
let unread: Record<string, number> = {};
let dmUnread: Record<string, number> = {};
let conversations: Conversation[] = [];
let participantStatuses: Record<string, UserStatus> = {};
let activeConversationId: string | null = null;
let channelUsers = new Map<string, VoiceUser[]>();
let channelServers = new Map<string, string>();
let pinnedServerIds: string[] = [];
let stripMode: 'pinned' | 'auto' = 'pinned';

vi.mock('../../stores/serverStore', () => {
  const state = () => ({ servers, activeServerId, setActiveServer, serverUnreadCounts: unread, pinnedServerIds, togglePinServer });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
  useServerStore.setState = serverSetState;
  return { useServerStore };
});
vi.mock('../../stores/dmStore', () => {
  const state = () => ({
    dmUnreadCounts: dmUnread,
    conversations,
    participantStatuses,
    activeConversationId,
    clearActiveConversation,
    setActiveConversation,
  });
  const useDMStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useDMStore.getState = state;
  return { useDMStore };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ activeVoiceServerId: null, channelUsers, channelServers });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useVoiceStore.getState = state;
  return { useVoiceStore };
});
vi.mock('../../stores/settingsStore', () => {
  const state = () => ({ spacesStripMode: stripMode, setSpacesStripMode });
  const useSettingsStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useSettingsStore.getState = state;
  return { useSettingsStore };
});
vi.mock('../../stores/friendStore', () => ({
  useFriendStore: { getState: () => ({ setShowFriendsView }) },
}));
vi.mock('../../stores/supportStore', () => ({
  useSupportStore: { getState: () => ({ setShowSupportView }) },
}));
vi.mock('../../components/server/CreateServerModal', () => ({
  CreateServerModal: () => <div data-testid="create-modal" />,
}));
vi.mock('../../components/server/ServerSwitcher', () => ({
  ServerSwitcher: ({ onExplore }: { onExplore?: () => void }) => (
    <div data-testid="switcher-open-marker"><button data-testid="switcher-explore" onClick={onExplore} /></div>
  ),
}));
vi.mock('../../components/discovery/DiscoveryModal', () => ({
  DiscoveryModal: () => <div data-testid="explore-open-marker" />,
}));

import {
  SpacesStrip,
  computeMaxTabs,
  STRIP_CLIP_PATH,
  STRIP_HIDE_DELAY_MS,
  STRIP_NAV_FOLD_DELAY_MS,
  STRIP_REVEAL_DELAY_MS,
} from '../../components/server/SpacesStrip';

const voiceUser = (id: string): VoiceUser =>
  ({ id, username: id, displayName: id, avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false }) as VoiceUser;

const conv = (id: string, userId: string, displayName: string): Conversation =>
  ({
    id,
    user1Id: 'me',
    user2Id: userId,
    participant: { id: userId, username: displayName.toLowerCase(), displayName, avatarUrl: null },
    lastMessage: null,
    encryptedAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
  }) as unknown as Conversation;

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<SpacesStrip />);
  });
}
const strip = () => document.body.querySelector('[data-testid="spaces-strip"]')!;
const tabByName = (name: string) =>
  strip().querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null;
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
// React derives onPointerEnter/Leave from pointerover/pointerout; a null
// relatedTarget means "from/to the window", which is the case these cover.
const pointerOver = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  });
const pointerOut = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
  });
const keydown = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });

/** matchMedia as jsdom lacks it: answers per query, change listeners accepted and ignored. */
function mockMatchMedia(answers: Record<string, boolean>) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: answers[query] ?? false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  servers = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}` }));
  activeServerId = 's0';
  unread = {};
  dmUnread = { c1: 2 };
  conversations = [conv('c1', 'u1', 'Mara'), conv('c2', 'u2', 'Jonas'), conv('c3', 'u3', 'Priya'), conv('c4', 'u4', 'Rui'), conv('c5', 'u5', 'Dana')];
  participantStatuses = { u1: 'online', u2: 'idle' };
  activeConversationId = null;
  channelUsers = new Map();
  channelServers = new Map();
  pinnedServerIds = [];
  stripMode = 'pinned';
  setActiveServer.mockClear();
  clearActiveConversation.mockClear();
  setActiveConversation.mockClear();
  togglePinServer.mockClear();
  setShowFriendsView.mockClear();
  setShowSupportView.mockClear();
  setSpacesStripMode.mockClear();
  serverSetState.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // @ts-expect-error — jsdom has no matchMedia; tests that mock it put it back
  delete window.matchMedia;
});

describe('SpacesStrip', () => {
  it('the compass opens Explore, and the switcher hands over to it (closing itself)', () => {
    render();
    expect(document.body.querySelector('[data-testid="explore-open-marker"]')).toBeNull();
    click(strip().querySelector('[data-testid="discovery-explore"]')!);
    expect(document.body.querySelector('[data-testid="explore-open-marker"]')).not.toBeNull();
  });

  it('the switcher\'s no-match offer opens Explore and closes the switcher', () => {
    render();
    click(strip().querySelector('[data-testid="server-switcher-open"]')!);
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).not.toBeNull();
    click(document.body.querySelector('[data-testid="switcher-explore"]')!);
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="explore-open-marker"]')).not.toBeNull();
  });

  it('shows at most seven space tabs plus the overflow count', () => {
    render();
    const tabs = servers.filter((s) => tabByName(s.name));
    expect(tabs.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
    const more = strip().querySelector('button[aria-label="server.moreSpaces"]')!;
    expect(more.textContent).toContain('+5');
  });

  it('expands the active space into a named tab', () => {
    render();
    expect(tabByName('Server 0')!.textContent).toContain('Server 0');
    // Inactive tabs are icon-only marks — no name text.
    expect(tabByName('Server 1')!.textContent).not.toContain('Server 1');
  });

  it('lets an active space beyond the fold borrow the last slot', () => {
    activeServerId = 's9';
    render();
    expect(tabByName('Server 9')).toBeTruthy();
    expect(tabByName('Server 9')!.textContent).toContain('Server 9');
    expect(tabByName('Server 6')).toBeNull(); // gave up its slot
  });

  it('switches space on tab click and leaves any open DM', () => {
    render();
    click(tabByName('Server 3')!);
    expect(clearActiveConversation).toHaveBeenCalled();
    expect(setActiveServer).toHaveBeenCalledWith('s3');
  });

  it('marks a space live when someone is in its voice channels', () => {
    channelUsers = new Map([['ch1', [voiceUser('u1'), voiceUser('u2')]]]);
    channelServers = new Map([['ch1', 's2']]);
    render();
    expect(tabByName('Server 2')!.querySelector('[data-testid="live-bars"]')).toBeTruthy();
    expect(tabByName('Server 1')!.querySelector('[data-testid="live-bars"]')).toBeNull();
  });

  it('aggregates hidden unread onto the overflow chip', () => {
    unread = { s9: 4, s11: 3, s1: 7 }; // s1 is visible — its 7 stays on its own tab
    render();
    const more = strip().querySelector('button[aria-label="server.moreSpaces"]')!;
    expect(more.textContent).toContain('7'); // 4 + 3 hidden
    expect(tabByName('Server 1')!.textContent).toContain('7');
  });

  it('keeps the unread badge inside the scrollable rail instead of clipping its top', () => {
    // The badge hangs 2px above its 42px tab. The rail is overflow-x:auto,
    // which forces overflow-y to auto too, so without vertical padding the
    // rail clipped the badge's top edge — a "4" with its head cut off.
    unread = { s1: 4 };
    render();
    const rail = strip().querySelector('[data-testid="spaces-rail"]')!;
    expect(rail.className).toMatch(/\boverflow-x-auto\b/);
    expect(rail.className).toMatch(/\bpy-0\.5\b/);
    const badge = tabByName('Server 1')!.querySelector('[data-testid="unread-badge"]')!;
    expect(badge.textContent).toBe('4');
    expect(badge.className.split(' ')).toContain('-top-0.5'); // the overhang the padding exists for
  });

  it('opens the spaces menu from Find a space', () => {
    render();
    click(strip().querySelector('[data-testid="server-switcher-open"]')!);
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).toBeTruthy();
  });

  it('gives pinned spaces the first slots, in pin order', () => {
    pinnedServerIds = ['s10', 's8']; // both beyond the natural fold
    render();
    const tabs = Array.from(strip().querySelectorAll('button[aria-current]'))
      .map((b) => b.getAttribute('aria-label'))
      .filter((l) => l?.startsWith('Server'));
    expect(tabs.slice(0, 2)).toEqual(['Server 10', 'Server 8']);
  });

  it('opens the spaces menu on Ctrl+Shift+L', () => {
    render();
    keydown({ key: 'L', ctrlKey: true, shiftKey: true });
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).toBeTruthy();
  });

  it('offers Pin space from a tab context menu', () => {
    render();
    const tab = tabByName('Server 2')!;
    act(() => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    });
    const item = document.body.querySelector('button[aria-label="server.pinSpace"], .fixed button') as HTMLButtonElement;
    expect(item?.textContent).toContain('server.pinSpace');
    click(item);
    expect(togglePinServer).toHaveBeenCalledWith('s2');
  });

  it('sizes the tab budget to the available width, reserving the New space tab', () => {
    expect(computeMaxTabs(0)).toBe(7); // unmeasured: keep the default
    expect(computeMaxTabs(300)).toBe(2); // tight: active + one
    expect(computeMaxTabs(720)).toBe(6); // roomy: it grows with the screen
    expect(computeMaxTabs(720)).toBeGreaterThan(computeMaxTabs(500));
  });

  it('space icons are 32px and never dimmed when idle', () => {
    render();
    const idle = tabByName('Server 1')!;
    const icon = idle.querySelector('span[aria-hidden]') as HTMLElement;
    expect(icon.style.width).toBe('32px');
    expect(strip().innerHTML).not.toContain('opacity-[0.82]');
  });

  // ─── The Messages zone ──────────────────────────────────────────────────

  it('the Messages tab is labelled in a space and carries the DM unread; clicking it goes home', () => {
    render();
    const tab = strip().querySelector('[data-testid="messages-tab"]')!;
    expect(tab.getAttribute('aria-label')).toBe('server.messagesTab');
    expect(tab.textContent).toContain('server.messagesTab');
    expect(tab.getAttribute('aria-current')).toBe('false');
    expect(tab.querySelector('[data-testid="unread-badge"]')!.textContent).toBe('2');
    click(tab);
    expect(serverSetState).toHaveBeenCalledWith({ activeServerId: null });
    expect(clearActiveConversation).toHaveBeenCalled();
  });

  it('the Messages tab stays labelled at home, is current there, and drops the badge', () => {
    activeServerId = null;
    render();
    const tab = strip().querySelector('[data-testid="messages-tab"]')!;
    expect(tab.textContent).toContain('server.messagesTab');
    expect(tab.getAttribute('aria-current')).toBe('true');
    expect(tab.querySelector('[data-testid="unread-badge"]')).toBeNull();
  });

  it('shows the three most recent conversations as people, in store order, with presence and unread', () => {
    dmUnread = { c2: 2 };
    render();
    const people = Array.from(strip().querySelectorAll('[data-testid="recent-person"]'));
    expect(people.map((p) => p.getAttribute('aria-label'))).toEqual(['Mara', 'Jonas', 'Priya']);
    expect(people[0].innerHTML).toContain('bg-green-500'); // online
    expect(people[1].innerHTML).toContain('bg-amber-400'); // idle
    expect(people[2].innerHTML).toContain('bg-gray-500'); // no status known → offline
    expect(people[1].querySelector('[data-testid="unread-badge"]')!.textContent).toBe('2');
    expect(people[0].querySelector('[data-testid="unread-badge"]')).toBeNull();
  });

  it('opens a conversation from its avatar: leaves the space and the Friends / Support views', () => {
    render();
    click(strip().querySelector('button[aria-label="Jonas"]')!);
    expect(setShowFriendsView).toHaveBeenCalledWith(false);
    expect(setShowSupportView).toHaveBeenCalledWith(false);
    expect(serverSetState).toHaveBeenCalledWith({ activeServerId: null });
    expect(setActiveConversation).toHaveBeenCalledWith('c2');
  });

  it('rings the open conversation while in Messages', () => {
    activeServerId = null;
    activeConversationId = 'c1';
    render();
    const mara = strip().querySelector('button[aria-label="Mara"]')!;
    expect(mara.getAttribute('aria-current')).toBe('true');
    expect(mara.innerHTML).toContain('ring-vox-accent-primary');
    expect(strip().querySelector('button[aria-label="Jonas"]')!.innerHTML).not.toContain('ring-vox-accent-primary');
  });

  it('an account with no conversations still gets the labelled Messages tab, alone', () => {
    conversations = [];
    render();
    expect(strip().querySelectorAll('[data-testid="recent-person"]')).toHaveLength(0);
    expect(strip().querySelector('[data-testid="messages-tab"]')!.textContent).toContain('server.messagesTab');
  });

  it('captions name the two zones', () => {
    render();
    const messages = strip().querySelector('[data-testid="strip-zone-messages"]')!;
    const spaces = strip().querySelector('[data-testid="strip-zone-spaces"]')!;
    expect(messages.querySelector('span[aria-hidden]')!.textContent).toBe('server.messagesTab');
    expect(spaces.querySelector('span[aria-hidden]')!.textContent).toBe('server.spacesZone');
  });

  // ─── New space ──────────────────────────────────────────────────────────

  it('New space is a labelled tab after the tab row and opens Create or join; the round plus is gone', () => {
    render();
    const creators = strip().querySelectorAll('button[aria-label="server.createOrJoin"]');
    expect(creators).toHaveLength(1);
    const newSpace = creators[0];
    expect(newSpace.getAttribute('data-testid')).toBe('new-space');
    expect(newSpace.textContent).toContain('server.newSpace');
    // It lives in the Spaces zone, after the rail and the overflow chip.
    expect(strip().querySelector('[data-testid="strip-zone-spaces"]')!.contains(newSpace)).toBe(true);
    const rail = strip().querySelector('[data-testid="spaces-rail"]')!;
    expect(rail.compareDocumentPosition(newSpace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const more = strip().querySelector('button[aria-label="server.moreSpaces"]')!;
    expect(more.compareDocumentPosition(newSpace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(newSpace);
    expect(document.body.querySelector('[data-testid="create-modal"]')).toBeTruthy();
  });

  it('Find, Explore and New space drop their labels below the width breakpoint but keep their names', () => {
    mockMatchMedia({ '(min-width: 1200px)': false });
    render();
    const find = strip().querySelector('[data-testid="server-switcher-open"]')!;
    expect(find.textContent).not.toContain('server.findSpace');
    expect(find.getAttribute('aria-label')).toBe('server.switcherTitle');
    expect(find.getAttribute('title')).toBe('server.findSpace');
    const explore = strip().querySelector('[data-testid="discovery-explore"]')!;
    expect(explore.textContent).not.toContain('discovery.explore');
    expect(explore.getAttribute('aria-label')).toBe('discovery.explore');
    expect(strip().querySelector('[data-testid="new-space"]')!.textContent).not.toContain('server.newSpace');
  });

  it('keeps the labels on a wide window', () => {
    mockMatchMedia({ '(min-width: 1200px)': true });
    render();
    expect(strip().querySelector('[data-testid="server-switcher-open"]')!.textContent).toContain('server.findSpace');
    expect(strip().querySelector('[data-testid="discovery-explore"]')!.textContent).toContain('discovery.explore');
  });

  it('pinned: the active tab is the reading surface, the strip sits on the page background, no pin control', () => {
    render();
    expect(strip().className).toContain('bg-vox-bg-primary');
    expect(strip().className).toContain('h-[64px]');
    expect(tabByName('Server 0')!.className).toContain('bg-vox-chat');
    expect(strip().querySelector('[data-testid="strip-keep-open"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="spaces-strip-handle"]')).toBeNull();
  });
});

describe('SpacesStrip — auto-hide (the chamfered hover panel)', () => {
  const handle = () => document.body.querySelector('[data-testid="spaces-strip-handle"]')!;
  const panel = () => document.body.querySelector('[data-testid="spaces-strip-panel"]')!;
  const revealed = () => panel().getAttribute('data-revealed') === 'true';
  const band = () => handle().parentElement!;

  beforeEach(() => {
    stripMode = 'auto';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds the strip into a notch, keeps the nav in the DOM, and shapes the panel', () => {
    render();
    expect(handle()).toBeTruthy();
    expect(handle().getAttribute('aria-label')).toBe('server.stripRevealHandle');
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    expect(revealed()).toBe(false);
    expect(panel().className).toContain('-translate-y-full');
    expect(panel().className).toContain('pointer-events-none');
    // Folded, the strip is still there for ⌘⇧L and Tab.
    expect(strip()).toBeTruthy();
    expect((strip() as HTMLElement).style.clipPath).toBe(STRIP_CLIP_PATH);
    expect(strip().className).toContain('h-[72px]');
    expect(strip().querySelector('[data-testid="messages-tab"]')).toBeTruthy();
    // The panel is narrower than the strip (insets, chamfers, the pin): Find,
    // Explore and New space are icon buttons there whatever the window width
    // (jsdom has no matchMedia, so the width query answers "wide" here).
    expect(strip().querySelector('[data-testid="server-switcher-open"]')!.textContent).not.toContain('server.findSpace');
    expect(strip().querySelector('[data-testid="discovery-explore"]')!.textContent).not.toContain('discovery.explore');
    expect(strip().querySelector('[data-testid="new-space"]')!.textContent).not.toContain('server.newSpace');
    expect(strip().querySelector('[data-testid="new-space"]')!.getAttribute('title')).toBe('server.createOrJoin');
  });

  it('reveals after the intent delay when the pointer rests on the notch, not before', () => {
    render();
    pointerOver(handle());
    act(() => {
      vi.advanceTimersByTime(STRIP_REVEAL_DELAY_MS - 1);
    });
    expect(revealed()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(revealed()).toBe(true);
    expect(handle().getAttribute('aria-expanded')).toBe('true');
    expect(panel().className).toContain('translate-y-0');
  });

  it('a pointer that only crosses the notch never reveals it', () => {
    render();
    pointerOver(handle());
    act(() => {
      vi.advanceTimersByTime(STRIP_REVEAL_DELAY_MS - 20);
    });
    pointerOut(handle());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(revealed()).toBe(false);
  });

  it('folds back after the grace period once the pointer leaves, unless it comes back', () => {
    render();
    click(handle());
    expect(revealed()).toBe(true);
    pointerOut(band());
    act(() => {
      vi.advanceTimersByTime(STRIP_HIDE_DELAY_MS - 1);
    });
    expect(revealed()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(revealed()).toBe(false);

    // Re-entry cancels the fold.
    click(handle());
    pointerOut(band());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    pointerOver(strip().querySelector('[data-testid="new-space"]')!);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(revealed()).toBe(true);
  });

  it('never folds while the spaces menu is open', () => {
    render();
    click(handle());
    click(strip().querySelector('[data-testid="server-switcher-open"]')!);
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).toBeTruthy();
    pointerOut(strip());
    act(() => {
      vi.advanceTimersByTime(STRIP_HIDE_DELAY_MS * 4);
    });
    expect(revealed()).toBe(true);
  });

  it('never folds while focus is inside; folds after focus leaves', () => {
    render();
    const newSpace = strip().querySelector('[data-testid="new-space"]')!;
    act(() => {
      newSpace.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(revealed()).toBe(true);
    pointerOut(strip());
    act(() => {
      vi.advanceTimersByTime(STRIP_HIDE_DELAY_MS * 4);
    });
    expect(revealed()).toBe(true);
    act(() => {
      newSpace.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(STRIP_HIDE_DELAY_MS);
    });
    expect(revealed()).toBe(false);
  });

  it('Ctrl+Shift+L reveals the folded strip and opens the menu; Escape folds a revealed strip', () => {
    render();
    keydown({ key: 'L', ctrlKey: true, shiftKey: true });
    expect(revealed()).toBe(true);
    expect(document.body.querySelector('[data-testid="switcher-open-marker"]')).toBeTruthy();
    // The menu owns Escape while it is open: the strip stays.
    keydown({ key: 'Escape' });
    expect(revealed()).toBe(true);
  });

  it('Escape folds a revealed strip when no popover is open', () => {
    render();
    click(handle());
    expect(revealed()).toBe(true);
    keydown({ key: 'Escape' });
    expect(revealed()).toBe(false);
  });

  it('the pin on the panel returns the strip to pinned mode', () => {
    render();
    click(handle());
    const pin = strip().querySelector('[data-testid="strip-keep-open"]')!;
    expect(pin.getAttribute('aria-label')).toBe('server.stripKeepOpen');
    click(pin);
    expect(setSpacesStripMode).toHaveBeenCalledWith('pinned');
  });

  it('the notch carries the signals the fold hides: unread anywhere, live anywhere', () => {
    dmUnread = {};
    unread = {};
    render();
    expect(handle().querySelector('[data-testid="strip-dot-unread"]')).toBeNull();
    expect(handle().querySelector('[data-testid="strip-dot-live"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);

    unread = { s9: 4 };
    channelUsers = new Map([['ch1', [voiceUser('u1')]]]);
    channelServers = new Map([['ch1', 's11']]);
    render();
    expect(handle().querySelector('[data-testid="strip-dot-unread"]')).toBeTruthy();
    expect(handle().querySelector('[data-testid="strip-dot-live"]')).toBeTruthy();
  });

  it('the slide is motion-safe only and the active tab reads as a step up inside the panel', () => {
    render();
    expect(panel().className).toContain('motion-safe:transition-[transform,opacity]');
    expect(tabByName('Server 0')!.className).toContain('bg-vox-bg-floating');
  });

  it('grows the tap target on a device without hover', () => {
    mockMatchMedia({ '(hover: none)': true, '(min-width: 1200px)': true });
    render();
    expect(handle().className).toContain('h-6');
  });

  it('folds on its own 1.5 s after a space is chosen, with the pointer still over it and the tab focused', () => {
    render();
    click(handle());
    const tab = tabByName('Server 3')!;
    pointerOver(tab); // the pointer is over the panel, as it is when you click
    act(() => {
      tab.focus();
      tab.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.activeElement).toBe(tab);
    click(tab);
    expect(setActiveServer).toHaveBeenCalledWith('s3');
    // The chosen tab no longer holds the focus, so focus-within cannot keep the strip out.
    expect(strip().contains(document.activeElement)).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS - 1);
    });
    expect(revealed()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(revealed()).toBe(false);
  });

  it('folds the same way after Messages or a person is chosen', () => {
    render();
    click(handle());
    pointerOver(strip());
    click(strip().querySelector('button[aria-label="Jonas"]')!);
    expect(setActiveConversation).toHaveBeenCalledWith('c2');
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS);
    });
    expect(revealed()).toBe(false);

    click(handle());
    click(strip().querySelector('[data-testid="messages-tab"]')!);
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS);
    });
    expect(revealed()).toBe(false);
  });

  it('a second choice restarts the fold, and a popover opened meanwhile still holds it', () => {
    render();
    click(handle());
    click(tabByName('Server 1')!);
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS - 100);
    });
    click(tabByName('Server 2')!);
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS - 100);
    });
    expect(revealed()).toBe(true); // restarted by the second choice
    click(strip().querySelector('[data-testid="server-switcher-open"]')!); // a popover
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS * 2);
    });
    expect(revealed()).toBe(true);
  });

  it('pinned, a choice folds nothing (there is nothing to fold)', () => {
    stripMode = 'pinned';
    render();
    click(tabByName('Server 3')!);
    act(() => {
      vi.advanceTimersByTime(STRIP_NAV_FOLD_DELAY_MS);
    });
    expect(strip()).toBeTruthy();
    expect(document.body.querySelector('[data-testid="spaces-strip-panel"]')).toBeNull();
  });
});
