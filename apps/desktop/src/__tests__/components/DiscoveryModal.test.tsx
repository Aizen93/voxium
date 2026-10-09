import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiscoveryServer } from '@voxium/shared';

/**
 * Explore: the modal over the real discoveryStore and a mocked API. What is
 * pinned: the first page loads on open, the search only fires at 3+
 * characters after the debounce, tags and sort refetch, Load more follows
 * the cursor, the off/empty/error states render, and the card's one button
 * runs the right store action with the right toast.
 */

const t = (k: string, o?: Record<string, unknown>) => {
  if (!o) return k;
  if ('name' in o) return `${k}:${o.name}`;
  if ('count' in o) return `${k}:${o.count}`;
  if ('min' in o) return `${k}:${o.min}`;
  return k;
};
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});
vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
const S = vi.hoisted(() => ({ setActiveServer: vi.fn(), setState: vi.fn() }));
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ servers: [], setActiveServer: S.setActiveServer });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  useServerStore.setState = S.setState;
  return { useServerStore };
});
const T = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: T }));
vi.mock('../../components/chat/ReportModal', () => ({
  ReportModal: ({ serverId }: { serverId: string }) => <div data-testid="report-marker">{serverId}</div>,
}));

import { api } from '../../services/api';
import { useDiscoveryStore } from '../../stores/discoveryStore';
import { DiscoveryModal } from '../../components/discovery/DiscoveryModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGet = api.get as unknown as Mock;
const mockPost = api.post as unknown as Mock;
const mockDelete = api.delete as unknown as Mock;

const card = (id: string, extra: Partial<DiscoveryServer> = {}): DiscoveryServer => ({
  id, name: `Space ${id}`, iconUrl: null, description: 'About it.', tags: ['gaming'], memberCount: 5, onlineCount: 1, weeklyMessages: 9,
  joinMode: 'approval', featured: false, isMember: false, requestPending: false, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null,
  ...extra,
});
const page = (servers: DiscoveryServer[], extra: Record<string, unknown> = {}) => ({
  data: { success: true, data: { featured: [], servers, nextCursor: null, totalCapped: servers.length, ...extra } },
});
const axiosError = (status: number, error: string) =>
  Object.assign(new Error(error), { isAxiosError: true, response: { status, data: { success: false, error } } });

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const cardEl = (id: string) => q(`[data-testid="discovery-card"][data-server-id="${id}"]`)!;
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const lastParams = () => mockGet.mock.calls[mockGet.mock.calls.length - 1][1].params;

async function render() {
  await act(async () => { root.render(<DiscoveryModal onClose={onClose} />); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDiscoveryStore.setState({
    query: '', tag: '', sort: 'active', featured: [], servers: [], nextCursor: null, totalCapped: 0,
    status: 'idle', error: null, loading: false, loadingMore: false, busyServerId: null,
  });
  mockGet.mockResolvedValue(page([card('a'), card('b', { joinMode: 'open' })], { featured: [card('f', { featured: true })], totalCapped: 1000, nextCursor: 'c1' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

describe('DiscoveryModal', () => {
  it('loads the first page on open and renders the Featured row, the ranked grid, the capped total and the footer', async () => {
    await render();
    expect(mockGet).toHaveBeenCalledWith('/discovery/servers', { params: { sort: 'active' } });
    expect(q('[data-testid="discovery-featured-row"]')!.querySelectorAll('[data-testid="discovery-card"]')).toHaveLength(1);
    expect(q('[data-testid="discovery-results"]')!.querySelectorAll('[data-testid="discovery-card"]')).toHaveLength(2);
    expect(q('[data-testid="discovery-results-heading"]')!.textContent).toContain('discovery.modal.resultsCapped:1000');
    expect(q('[data-testid="discovery-footer"]')!.textContent).toBe('discovery.modal.footer');
    expect(q('[data-testid="discovery-load-more"]')).not.toBeNull();
  });

  it('the search fires only at 3+ characters, 300 ms after the last keystroke, and says so below that', async () => {
    await render();
    vi.useFakeTimers();
    await act(async () => { setValue(q('[data-testid="discovery-search"]') as HTMLInputElement, 'ra'); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(q('[data-testid="discovery-search-hint"]')!.textContent).toBe('discovery.modal.searchHint:3');
    expect(mockGet).toHaveBeenCalledTimes(1); // the open fetch only

    await act(async () => { setValue(q('[data-testid="discovery-search"]') as HTMLInputElement, 'raid'); });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(mockGet).toHaveBeenCalledTimes(1); // not yet
    await act(async () => { vi.advanceTimersByTime(150); });
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(lastParams()).toEqual({ sort: 'active', q: 'raid' });
    expect(q('[data-testid="discovery-search-hint"]')).toBeNull();
  });

  it('a tag chip and the sort select refetch with the new filters; the chip toggles off', async () => {
    await render();
    await act(async () => { q('[data-testid="discovery-tag-music"]')!.click(); });
    expect(lastParams()).toEqual({ sort: 'active', tag: 'music' });
    expect(q('[data-testid="discovery-tag-music"]')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      const select = q('[data-testid="discovery-sort"]') as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'newest');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lastParams()).toEqual({ sort: 'newest', tag: 'music' });
    await act(async () => { q('[data-testid="discovery-tag-music"]')!.click(); });
    expect(lastParams()).toEqual({ sort: 'newest' });
    await act(async () => { q('[data-testid="discovery-tag-all"]')!.click(); });
    expect(q('[data-testid="discovery-tag-all"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('Load more follows the cursor and appends', async () => {
    await render();
    mockGet.mockResolvedValue(page([card('c')], { nextCursor: null }));
    await act(async () => { q('[data-testid="discovery-load-more"]')!.click(); });
    expect(lastParams()).toEqual({ sort: 'active', cursor: 'c1' });
    expect(q('[data-testid="discovery-results"]')!.querySelectorAll('[data-testid="discovery-card"]')).toHaveLength(3);
    expect(q('[data-testid="discovery-load-more"]')).toBeNull();
  });

  it('shows the off state on the flag-off 403, the two empty states, and an error with retry', async () => {
    mockGet.mockRejectedValue(axiosError(403, 'Server discovery is currently disabled'));
    await render();
    expect(q('[data-testid="discovery-off"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);

    mockGet.mockResolvedValue(page([]));
    await render();
    expect(q('[data-testid="discovery-empty"]')!.textContent).toContain('discovery.modal.emptyNone');
    await act(async () => { q('[data-testid="discovery-tag-art"]')!.click(); });
    expect(q('[data-testid="discovery-empty"]')!.textContent).toContain('discovery.modal.emptyMatch');
    act(() => root.unmount());
    root = createRoot(container);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockRejectedValue(axiosError(400, 'Refine your search'));
    await render();
    expect(q('[data-testid="discovery-error"]')!.textContent).toContain('serverErrors.refineSearch');
    mockGet.mockResolvedValue(page([card('a')]));
    await act(async () => { qa('[data-testid="discovery-error"] button')[0].click(); });
    expect(qa('[data-testid="discovery-card"]')).toHaveLength(1);
    warn.mockRestore();
  });

  it('Join (open mode) joins through the store, toasts the welcome and closes', async () => {
    const server = { id: 'b', name: 'Space b', iconUrl: null, invitesLocked: false, ownerId: 'o', createdAt: 'x' };
    mockPost.mockResolvedValue({ data: { success: true, data: server } });
    await render();
    await act(async () => { (cardEl('b').querySelector('[data-testid="discovery-join"]') as HTMLButtonElement).click(); });
    expect(mockPost).toHaveBeenCalledWith('/discovery/servers/b/join');
    expect(S.setActiveServer).toHaveBeenCalledWith('b');
    expect(T.success).toHaveBeenCalledWith('discovery.toasts.joined:Space b');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a refused Join toasts the translated reason and keeps the modal', async () => {
    mockPost.mockRejectedValue(axiosError(403, 'You are banned from this server'));
    await render();
    await act(async () => { (cardEl('b').querySelector('[data-testid="discovery-join"]') as HTMLButtonElement).click(); });
    expect(T.error).toHaveBeenCalledWith('serverErrors.bannedFromServer');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Request to join opens the dialog, sends the message, toasts, and the card reads Requested; Cancel withdraws', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { status: 'pending' } } });
    mockDelete.mockResolvedValue({ data: { success: true } });
    await render();
    await act(async () => { (cardEl('a').querySelector('[data-testid="discovery-join"]') as HTMLButtonElement).click(); });
    expect(q('[data-testid="join-request-dialog"]')).not.toBeNull();
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, 'EU evenings'); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(mockPost).toHaveBeenCalledWith('/discovery/servers/a/join', { message: 'EU evenings' });
    expect(T.success).toHaveBeenCalledWith('discovery.toasts.requestSent:Space a');
    expect(q('[data-testid="join-request-dialog"]')).toBeNull();
    expect(cardEl('a').querySelector('[data-testid="discovery-requested"]')).not.toBeNull();

    await act(async () => { (cardEl('a').querySelector('[data-testid="discovery-cancel-request"]') as HTMLButtonElement).click(); });
    expect(mockDelete).toHaveBeenCalledWith('/discovery/servers/a/join');
    expect(T.info).toHaveBeenCalledWith('discovery.toasts.requestCancelled:Space a');
    expect(cardEl('a').querySelector('[data-testid="discovery-join"]')).not.toBeNull();
  });

  it('a refused request keeps the dialog open with its toast', async () => {
    mockPost.mockRejectedValue(axiosError(403, 'Your request was declined recently. Please try again later.'));
    await render();
    await act(async () => { (cardEl('a').querySelector('[data-testid="discovery-join"]') as HTMLButtonElement).click(); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(T.error).toHaveBeenCalledWith('serverErrors.requestDeclinedRecently');
    expect(q('[data-testid="join-request-dialog"]')).not.toBeNull();
  });

  it('Open switches to a server the viewer is in and closes; the menu opens the server report', async () => {
    mockGet.mockResolvedValue(page([card('m', { isMember: true })]));
    await render();
    await act(async () => { (cardEl('m').querySelector('[data-testid="discovery-open"]') as HTMLButtonElement).click(); });
    expect(S.setActiveServer).toHaveBeenCalledWith('m');
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { (cardEl('m').querySelector('[data-testid="discovery-report"]') as HTMLButtonElement).click(); });
    expect(q('[data-testid="report-marker"]')!.textContent).toBe('m');
  });

  it('closes on Escape, but not while the request dialog is open', async () => {
    await render();
    await act(async () => { (cardEl('a').querySelector('[data-testid="discovery-join"]') as HTMLButtonElement).click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { q('[data-testid="join-request-dialog"] [aria-label="common.close"]')!.click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
