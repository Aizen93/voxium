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
  });

  it('closes on Escape without switching anything', () => {
    render();
    key('Escape');
    expect(onClose).toHaveBeenCalled();
    expect(setActiveServer).not.toHaveBeenCalled();
  });
});
