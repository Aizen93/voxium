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
  isMember: false, requestPending: false, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null,
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
    expect(q('[data-testid="discovery-featured"]')).toBeNull();
  });

  it('shows the placeholder when there is no description and the Featured badge when curated', () => {
    render(<DiscoveryCard server={{ ...base, description: null, featured: true, tags: [] }} />);
    expect(q('[data-testid="discovery-card-description"]')!.textContent).toBe('discovery.card.noDescription');
    expect(q('[data-testid="discovery-featured"]')).not.toBeNull();
    expect(q('[data-testid="discovery-card-tags"]')).toBeNull();
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
    expect(q('[data-testid="discovery-report"]')).toBeNull();
  });

  it('renders the report action only when a handler is given, and at most five tags', () => {
    const onReport = vi.fn();
    render(<DiscoveryCard server={{ ...base, tags: ['gaming', 'esports', 'music', 'art', 'science', 'community'] }} onReport={onReport} />);
    act(() => { q('[data-testid="discovery-report"]')!.click(); });
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-testid="discovery-card-tags"] span')).toHaveLength(5);
  });
});
