import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DirectoryChips, directoryChips, type DirectoryState } from '../../components/DirectoryChips';

/**
 * The chips are read off the materialised listing column and its inputs —
 * one truth table, so a server never shows two contradictory states.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: DirectoryState = {
  discoverable: true, discoveryListed: true, featuredAt: null, discoveryBlockedAt: null, invitesLocked: false, ownerBannedAt: null, joinMode: 'approval',
};
const keys = (s: Partial<DirectoryState>) => directoryChips({ ...base, ...s }).map((c) => c.key);

describe('directoryChips', () => {
  it('a listed server is Listed, and Featured when curated', () => {
    expect(keys({})).toEqual(['listed']);
    expect(keys({ featuredAt: '2026-10-11T00:00:00.000Z' })).toEqual(['listed', 'featured']);
  });

  it('Blocked wins over everything (a block forces the owner switch off too)', () => {
    expect(keys({ discoveryBlockedAt: '2026-10-11T00:00:00.000Z', discoverable: false, discoveryListed: false })).toEqual(['blocked']);
    // a stale column must not paint a blocked server as listed
    expect(keys({ discoveryBlockedAt: '2026-10-11T00:00:00.000Z', discoveryListed: true, featuredAt: '2026-10-11T00:00:00.000Z' })).toEqual(['blocked']);
  });

  it('a hidden server says why, in the order the listing inputs are checked', () => {
    expect(keys({ discoveryListed: false, discoverable: false })).toEqual(['hidden']);
    expect(keys({ discoveryListed: false, discoverable: false, invitesLocked: true })).toEqual(['hidden']);
    expect(keys({ discoveryListed: false, invitesLocked: true })).toEqual(['hidden-invites-locked']);
    expect(keys({ discoveryListed: false, ownerBannedAt: '2026-10-11T00:00:00.000Z' })).toEqual(['hidden-owner-banned']);
    // discoverable, unlocked, not blocked, owner not banned, still not listed:
    // the column disagrees with its inputs — a recompute is pending, and the
    // chip must not blame the owner for it
    expect(keys({ discoveryListed: false })).toEqual(['hidden-recompute-pending']);
  });

  it('Featured is its own stamp: a hidden featured server keeps the chip (it returns to the row when relisted)', () => {
    expect(keys({ discoveryListed: false, discoverable: false, featuredAt: '2026-10-11T00:00:00.000Z' })).toEqual(['hidden', 'featured']);
    expect(keys({ discoveryListed: false, invitesLocked: true, featuredAt: '2026-10-11T00:00:00.000Z' })).toEqual(['hidden-invites-locked', 'featured']);
  });
});

describe('<DirectoryChips>', () => {
  let container: HTMLDivElement;
  let root: Root;
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function render(server: DirectoryState, showJoinMode?: boolean) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<DirectoryChips server={server} showJoinMode={showJoinMode} />); });
  }

  it('renders the chips with their labels and the join mode', async () => {
    await render({ ...base, featuredAt: '2026-10-11T00:00:00.000Z', joinMode: 'open' });
    expect(container.querySelector('[data-testid="directory-chip-listed"]')!.textContent).toBe('Listed');
    expect(container.querySelector('[data-testid="directory-chip-featured"]')!.textContent).toBe('Featured');
    expect(container.querySelector('[data-testid="directory-join-mode"]')!.textContent).toBe('open join');
  });

  it('labels the approval mode and can hide the join mode', async () => {
    await render({ ...base, discoveryListed: false, invitesLocked: true });
    expect(container.querySelector('[data-testid="directory-chip-hidden-invites-locked"]')!.textContent).toBe('Hidden: invites locked');
    expect(container.querySelector('[data-testid="directory-join-mode"]')!.textContent).toBe('approval');
    await act(async () => { root.render(<DirectoryChips server={base} showJoinMode={false} />); });
    expect(container.querySelector('[data-testid="directory-join-mode"]')).toBeNull();
  });
});
