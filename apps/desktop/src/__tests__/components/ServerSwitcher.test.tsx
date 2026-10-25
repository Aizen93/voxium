import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The switcher is the answer to "what does a user with 100+ servers do".
 *
 * A rail shows the handful you use; this reaches the rest by name. So the
 * things worth pinning down are the ones that make it usable at that scale:
 * it filters, unread sorts to the top, the keyboard drives it, and Enter opens
 * exactly the row that is highlighted — not the first one, and not one that
 * scrolled under the cursor.
 *
 * Anchored under the strip's "Find a space" control it is a dropdown that
 * must be positioned on its FIRST render (the anchor is mounted already),
 * never painted at the window's left edge and then moved.
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
let unread: Record<string, number> = {};
let channelUsers = new Map<string, unknown[]>();
let channelServers = new Map<string, string>();
let pinnedServerIds: string[] = [];

vi.mock('../../stores/serverStore', () => {
  const state = () => ({ servers, serverUnreadCounts: unread, setActiveServer, pinnedServerIds, togglePinServer });
  const useServerStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useServerStore.getState = state;
  useServerStore.setState = vi.fn();
  return { useServerStore };
});
vi.mock('../../stores/dmStore', () => {
  const state = () => ({ dmUnreadCounts: {} as Record<string, number>, clearActiveConversation });
  const useDMStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useDMStore.getState = state;
  return { useDMStore };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ activeVoiceServerId: null, channelUsers, channelServers });
  const useVoiceStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useVoiceStore.getState = state;
  return { useVoiceStore };
});

import { ServerSwitcher } from '../../components/server/ServerSwitcher';

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render() {
  act(() => {
    root.render(<ServerSwitcher onClose={onClose} />);
  });
}
const input = () =>
  document.body.querySelector('[data-testid="server-switcher-input"]') as HTMLInputElement;
const rows = () =>
  Array.from(document.body.querySelectorAll('[data-testid="server-switcher"] button[data-row-btn]'));
// Read the NAME element, not the whole button: the button also contains the
// icon's initials, so 'Astronomy' would come back as 'AAstronomy'.
const nameOf = (el: Element | null | undefined) =>
  el?.querySelector('[data-row-name]')?.textContent?.trim() ?? '';
const labels = () => rows().map(nameOf);
const activeLabel = () => nameOf(document.body.querySelector('[data-active="true"]'));

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function key(k: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

beforeEach(() => {
  servers = [
    { id: 's-cook', name: 'Cooking' },
    { id: 's-astro', name: 'Astronomy' },
    { id: 's-books', name: 'Book Club' },
  ];
  unread = {};
  channelUsers = new Map();
  channelServers = new Map();
  pinnedServerIds = [];
  setActiveServer.mockClear();
  clearActiveConversation.mockClear();
  togglePinServer.mockClear();
  onClose.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ServerSwitcher', () => {
  it('lists every server plus DMs, alphabetically', () => {
    render();
    expect(labels()).toEqual(['dm.title', 'Astronomy', 'Book Club', 'Cooking']);
  });

  it('filters as you type — the point of the whole thing', () => {
    render();
    type('boo');
    expect(labels()).toEqual(['Book Club']);
  });

  it('surfaces live spaces above everything — voice is why you switch NOW', () => {
    channelUsers = new Map([['ch-x', [{}, {}]]]);
    channelServers = new Map([['ch-x', 's-books']]);
    render();
    // Book Club jumps the alphabet into the Live now section.
    expect(labels()).toEqual(['dm.title', 'Book Club', 'Astronomy', 'Cooking']);
    expect(document.body.textContent).toContain('server.liveNow');
    expect(document.body.textContent).toContain('server.allSpaces');
    expect(document.body.textContent).toContain('server.inVoiceCount');
  });

  it('groups pinned favorites after live, in the order they were pinned', () => {
    pinnedServerIds = ['s-cook', 's-astro']; // pin order, not alphabetical
    render();
    expect(labels()).toEqual(['dm.title', 'Cooking', 'Astronomy', 'Book Club']);
    expect(document.body.textContent).toContain('server.pinnedSection');
    expect(document.body.textContent).toContain('server.allSpaces');
  });

  it('toggles a pin from the row without switching servers', () => {
    render();
    const pinBtn = document.body.querySelector(
      '[data-testid="server-switcher"] button[aria-label="server.pinSpace"]',
    ) as HTMLButtonElement;
    expect(pinBtn).toBeTruthy();
    act(() => {
      pinBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(togglePinServer).toHaveBeenCalled();
    expect(setActiveServer).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // stays open to pin several
  });

  it('puts servers with unread first, whatever the alphabet says', () => {
    // The reason to switch is usually that something happened elsewhere, so the
    // thing that happened should not be buried under C.
    unread = { 's-cook': 3 };
    render();
    expect(labels()[1]).toContain('Cooking');
  });

  it('opens the highlighted row, not the first one', () => {
    // Arrowing down and pressing Enter must open what is highlighted; taking
    // rows[0] regardless is the classic version of this bug.
    render();
    key('ArrowDown');
    key('ArrowDown');
    expect(activeLabel()).toBe('Book Club');

    key('Enter');

    expect(setActiveServer).toHaveBeenCalledWith('s-books');
    expect(onClose).toHaveBeenCalled();
  });

  it('wraps at both ends so the list is a loop', () => {
    render();
    key('ArrowUp');
    expect(activeLabel()).toBe('Cooking'); // last row
    key('ArrowDown');
    expect(activeLabel()).toBe('dm.title'); // back to the first
  });

  it('keeps the cursor inside the list when filtering shortens it', () => {
    // Cursor at index 3, then a filter that leaves one row. Left unclamped,
    // Enter would reference a row that no longer exists and do nothing.
    render();
    key('ArrowUp'); // last row
    type('astro');

    expect(labels()).toEqual(['Astronomy']);
    key('Enter');
    expect(setActiveServer).toHaveBeenCalledWith('s-astro');
  });

  it('goes to DMs rather than a server when that row is chosen', () => {
    render();
    key('Enter'); // first row is DMs
    expect(setActiveServer).not.toHaveBeenCalled();
    expect(clearActiveConversation).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when nothing matches instead of showing an empty box', () => {
    render();
    type('zzzzz');
    expect(document.body.textContent).toContain('server.switcherEmpty');
    // no Explore hand-over offered without a parent that can open it
    expect(document.body.querySelector('[data-testid="switcher-explore"]')).toBeNull();
  });

  it('offers Explore when nothing matches and a parent can open it — closing itself first', () => {
    const onExplore = vi.fn();
    act(() => {
      root.render(<ServerSwitcher onClose={onClose} onExplore={onExplore} />);
    });
    expect(document.body.querySelector('[data-testid="switcher-explore"]')).toBeNull(); // rows exist
    type('zzzzz');
    const offer = document.body.querySelector('[data-testid="switcher-explore"]') as HTMLButtonElement;
    expect(offer.textContent).toBe('discovery.switcherExplore');
    act(() => { offer.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExplore).toHaveBeenCalledTimes(1);
    expect(setActiveServer).not.toHaveBeenCalled();
  });

  it('closes on Escape without switching anything', () => {
    render();
    key('Escape');
    expect(onClose).toHaveBeenCalled();
    expect(setActiveServer).not.toHaveBeenCalled();
  });
});

describe('ServerSwitcher — anchored under the strip', () => {
  let anchor: HTMLButtonElement;
  const dialog = () => document.body.querySelector('[data-testid="server-switcher"]') as HTMLElement;
  const rect = (left: number, right: number) =>
    ({ top: 10, bottom: 50, left, right, width: right - left, height: 40, x: left, y: 10, toJSON: () => ({}) });

  beforeEach(() => {
    anchor = document.createElement('button');
    document.body.appendChild(anchor);
    // jsdom has no layout: the anchor reports where the strip's control sits.
    anchor.getBoundingClientRect = () => rect(900, 1180);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  });

  afterEach(() => {
    anchor.remove();
  });

  it('is positioned under the anchor on its first render, never shown unpositioned', () => {
    act(() => {
      root.render(<ServerSwitcher onClose={onClose} anchorRef={{ current: anchor }} />);
    });
    const el = dialog();
    expect(el.className).toContain('fixed');
    expect(el.style.top).toBe('58px'); // anchor bottom + 8
    expect(el.style.right).toBe('100px'); // window width − anchor right
    expect(el.style.visibility).toBe('');
  });

  it('follows the anchor when the window is resized', () => {
    act(() => {
      root.render(<ServerSwitcher onClose={onClose} anchorRef={{ current: anchor }} />);
    });
    anchor.getBoundingClientRect = () => rect(500, 780);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 940 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(dialog().style.right).toBe('160px');
  });

  it('hides itself rather than painting at the left edge when the anchor cannot be measured', () => {
    act(() => {
      root.render(<ServerSwitcher onClose={onClose} anchorRef={{ current: null }} />);
    });
    expect(dialog().style.visibility).toBe('hidden');
  });

  it('is a centred palette, not a fixed dropdown, without an anchor', () => {
    render();
    const el = dialog();
    expect(el.className).not.toContain('fixed');
    expect(el.style.top).toBe('');
  });
});
