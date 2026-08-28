import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VoiceUser } from '@voxium/shared';

/**
 * The spaces strip: communities as tabs along the top.
 *
 * The contract that keeps it a strip, not a rail: it never lists every
 * server. At most MAX_TABS are visible in stable store order, the active
 * space is an expanded named tab, the long tail collapses into "+N" (with
 * aggregated unread), and a space with people in voice carries a live mark
 * wherever it is. Everything else is one click away in the spaces menu.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const { setActiveServer, clearActiveConversation, togglePinServer } = vi.hoisted(() => ({
  setActiveServer: vi.fn(),
  clearActiveConversation: vi.fn(),
  togglePinServer: vi.fn(),
}));

let servers: Array<{ id: string; name: string; iconUrl?: string | null }> = [];
let activeServerId: string | null = null;
let unread: Record<string, number> = {};
let channelUsers = new Map<string, VoiceUser[]>();
let channelServers = new Map<string, string>();
let pinnedServerIds: string[] = [];

vi.mock('../../stores/serverStore', () => {
  const state = () => ({ servers, activeServerId, setActiveServer, serverUnreadCounts: unread, pinnedServerIds, togglePinServer });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
  useServerStore.setState = vi.fn();
  return { useServerStore };
});
vi.mock('../../stores/dmStore', () => {
  const state = () => ({ dmUnreadCounts: { c1: 2 } as Record<string, number>, clearActiveConversation });
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
vi.mock('../../components/server/CreateServerModal', () => ({
  CreateServerModal: () => <div data-testid="create-modal" />,
}));
vi.mock('../../components/server/ServerSwitcher', () => ({
  ServerSwitcher: () => <div data-testid="switcher-open-marker" />,
}));

import { SpacesStrip, computeMaxTabs } from '../../components/server/SpacesStrip';

const voiceUser = (id: string): VoiceUser =>
  ({ id, username: id, displayName: id, avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false }) as VoiceUser;

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

beforeEach(() => {
  servers = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}` }));
  activeServerId = 's0';
  unread = {};
  channelUsers = new Map();
  channelServers = new Map();
  pinnedServerIds = [];
  setActiveServer.mockClear();
  clearActiveConversation.mockClear();
  togglePinServer.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SpacesStrip', () => {
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
    // The badge hangs 4px above its 34px tab. The rail is overflow-x:auto,
    // which forces overflow-y to auto too, so without vertical padding the
    // rail clipped the badge's top edge — a "4" with its head cut off.
    unread = { s1: 4 };
    render();
    const rail = strip().querySelector('[data-testid="spaces-rail"]')!;
    expect(rail.className).toMatch(/\boverflow-x-auto\b/);
    expect(rail.className).toMatch(/\bpy-1\b/);
    const badge = tabByName('Server 1')!.querySelector('[data-testid="unread-badge"]')!;
    expect(badge.textContent).toBe('4');
    expect(badge.className.split(' ')).toContain('-top-1'); // the overhang the padding exists for
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
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
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

  it('sizes the tab budget to the available width', () => {
    expect(computeMaxTabs(0)).toBe(7); // unmeasured: keep the default
    expect(computeMaxTabs(300)).toBe(2); // tight: active + one
    expect(computeMaxTabs(720)).toBe(11); // roomy: it grows with the screen
    expect(computeMaxTabs(720)).toBeGreaterThan(computeMaxTabs(500));
  });

  it('shows the DM tab with aggregate DM unread while in a server', () => {
    render();
    const dm = strip().querySelector('button[aria-label="dm.title"]')!;
    expect(dm.textContent).toContain('2');
    click(dm);
    expect(clearActiveConversation).toHaveBeenCalled();
  });
});
