import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiscoveryServer } from '@voxium/shared';

/**
 * The directory card is ONE component for Explore and for the owner's
 * preview. What matters is that the single button follows the server's join
 * mode and the viewer's state exactly as the plan's table says, and that the
 * three ranking inputs and the tags are printed.
 */

const t = (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

import { DiscoveryCard } from '../../components/discovery/DiscoveryCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: DiscoveryServer = {
  id: 'srv-1', name: 'Voxium HQ', iconUrl: null, description: 'Official space.', tags: ['open-source', 'community'],
  memberCount: 318, onlineCount: 42, weeklyMessages: 900, joinMode: 'approval', featured: false,
  isMember: false, requestPending: false, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null, tier: null,
};

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => { root.render(ui); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DiscoveryCard', () => {
  it('prints the name, description, every tag label and the three ranking inputs', () => {
    render(<DiscoveryCard server={base} />);
    expect(q('[data-testid="discovery-card-name"]')!.textContent).toBe('Voxium HQ');
    expect(q('[data-testid="discovery-card-description"]')!.textContent).toBe('Official space.');
    const tags = Array.from(container.querySelectorAll('[data-testid="discovery-card-tags"] span')).map((e) => e.textContent);
    expect(tags).toEqual(['discovery.tags.open-source', 'discovery.tags.community']);
    expect(q('[data-testid="discovery-card-online"]')!.textContent).toBe('discovery.card.online:42');
    expect(q('[data-testid="discovery-card-members"]')!.textContent).toBe('discovery.card.members:318');
    expect(q('[data-testid="discovery-card-messages"]')!.textContent).toBe('discovery.card.messages:900');
    expect(q('[data-testid="discovery-featured"]')).toBeNull();
  });

  it('shows the placeholder when there is no description and the Featured badge when curated', () => {
    render(<DiscoveryCard server={{ ...base, description: null, featured: true, tags: [] }} />);
    expect(q('[data-testid="discovery-card-description"]')!.textContent).toBe('discovery.card.noDescription');
    expect(q('[data-testid="discovery-featured"]')).not.toBeNull();
    expect(q('[data-testid="discovery-card-tags"]')).toBeNull();
  });

  it('wears the activity badge of its tier next to the name, and none without one', () => {
    render(<DiscoveryCard server={{ ...base, tier: 'gold' }} />);
    const badge = q('[data-testid="discovery-tier"]')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-tier')).toBe('gold');
    expect(badge.getAttribute('title')).toContain('discovery.tier.badgeLabel');
    render(<DiscoveryCard server={base} />);
    expect(q('[data-testid="discovery-tier"]')).toBeNull();
    // a value the client does not know is no badge, not a crash
    render(<DiscoveryCard server={{ ...base, tier: 'mythic' as unknown as 'gold' }} />);
    expect(q('[data-testid="discovery-tier"]')).toBeNull();
  });

  it('the one button: Request to join (approval) / Join (open) / Requested + Cancel (pending) / Open (member)', () => {
    const onRequest = vi.fn();
    const onJoin = vi.fn();
    const onCancel = vi.fn();
    const onOpen = vi.fn();

    render(<DiscoveryCard server={base} onRequest={onRequest} />);
    expect(q('[data-testid="discovery-join"]')!.textContent).toBe('discovery.card.requestToJoin');
    act(() => { q('[data-testid="discovery-join"]')!.click(); });
    expect(onRequest).toHaveBeenCalledWith(base);

    render(<DiscoveryCard server={{ ...base, joinMode: 'open' }} onJoin={onJoin} />);
    expect(q('[data-testid="discovery-join"]')!.textContent).toBe('discovery.card.join');
    act(() => { q('[data-testid="discovery-join"]')!.click(); });
    expect(onJoin).toHaveBeenCalledTimes(1);

    render(<DiscoveryCard server={{ ...base, requestPending: true }} onCancelRequest={onCancel} />);
    expect(q('[data-testid="discovery-requested"]')!.textContent).toBe('discovery.card.requested');
    expect((q('[data-testid="discovery-requested"]') as HTMLButtonElement).disabled).toBe(true);
    act(() => { q('[data-testid="discovery-cancel-request"]')!.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);

    render(<DiscoveryCard server={{ ...base, isMember: true, requestPending: true }} onOpen={onOpen} />);
    expect(q('[data-testid="discovery-open"]')!.textContent).toBe('discovery.card.open');
    expect(q('[data-testid="discovery-cancel-request"]')).toBeNull(); // a member has nothing pending to cancel
    act(() => { q('[data-testid="discovery-open"]')!.click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preview mode renders the button inert and no report menu', () => {
    const onJoin = vi.fn();
    const onReport = vi.fn();
    render(<DiscoveryCard server={{ ...base, joinMode: 'open' }} preview onJoin={onJoin} onReport={onReport} />);
    const btn = q('[data-testid="discovery-join"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    act(() => { btn.click(); });
    expect(onJoin).not.toHaveBeenCalled();
    expect(q('[data-testid="discovery-card-menu"]')).toBeNull();
  });

  it('renders the "…" menu only when a handler is given, and at most five tags', () => {
    render(<DiscoveryCard server={{ ...base, tags: ['gaming', 'esports', 'music', 'art', 'science', 'community'] }} />);
    expect(q('[data-testid="discovery-card-menu"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="discovery-card-tags"] span')).toHaveLength(5);
    render(<DiscoveryCard server={base} onReport={vi.fn()} />);
    expect(q('[data-testid="discovery-card-menu"]')).not.toBeNull();
  });

  it('the "…" menu is a list: it opens under the button, Report is one entry, choosing it reports and closes', () => {
    const onReport = vi.fn();
    render(<DiscoveryCard server={base} onReport={onReport} />);
    const button = q('[data-testid="discovery-card-menu"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).toBeNull();

    act(() => { button.click(); });
    const list = document.body.querySelector('[data-testid="discovery-card-menu-list"]')!;
    expect(list).not.toBeNull();
    expect(list.getAttribute('role')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = list.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-testid')).toBe('discovery-report');
    expect(items[0].textContent).toContain('discovery.card.report');

    act(() => { (items[0] as HTMLButtonElement).click(); });
    expect(onReport).toHaveBeenCalledWith(base);
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('the menu closes on Escape (and keeps the key from the Explore modal) and on a press outside', () => {
    render(<DiscoveryCard server={base} onReport={vi.fn()} />);
    const button = q('[data-testid="discovery-card-menu"]') as HTMLButtonElement;
    act(() => { button.click(); });
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).not.toBeNull();
    // a bubble-phase listener (how the Explore modal listens) must not see the Escape the menu consumed
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).toBeNull();

    act(() => { button.click(); });
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).not.toBeNull();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).toBeNull();
    // a press on the button itself toggles rather than closing-then-reopening
    act(() => { button.click(); });
    act(() => { button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(document.body.querySelector('[data-testid="discovery-card-menu-list"]')).not.toBeNull();
  });
});
