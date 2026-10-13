import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Role, ServerMember } from '@voxium/shared';
import type { DirectoryState, PeopleState } from '../../stores/serverStore';

/**
 * Server settings → Members → the directory: server-paged rows for a search
 * text and a role filter. The section asks the store for the first page on
 * open and whenever the filter changes (typing settles first), follows the
 * cursor on "Load more", renders the server's figures — never the rows on
 * screen — and keeps the moderation actions of the old in-memory list.
 */

const t = (k: string, o?: Record<string, unknown>) =>
  o && 'filtered' in o ? `${k}:${o.filtered}/${o.total}` : o && 'name' in o ? `${k}:${o.name}` : k;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const S = vi.hoisted(() => ({
  fetchDirectory: vi.fn(), fetchDirectoryMore: vi.fn(), assignMemberRoles: vi.fn(),
  updateMemberRole: vi.fn(), kickMember: vi.fn(), transferOwnership: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
let directory: DirectoryState;
let members: ServerMember[] = [];
let roles: Role[] = [];
let people: PeopleState;
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ directory, members, roles, people, ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', username: 'me', displayName: 'Me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: S.toastSuccess, error: S.toastError, info: vi.fn(), warning: vi.fn() } }));

import { MembersDirectory, DIRECTORY_SEARCH_DEBOUNCE_MS } from '../../components/server/MembersDirectory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, role: ServerMember['role'] = 'member'): ServerMember =>
  ({ userId: id, serverId: 'srv-1', role, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id, username: id, displayName: id.toUpperCase(), avatarUrl: null, status: 'offline' } } as unknown as ServerMember);
const listed = (rows: ServerMember[], extra: Partial<DirectoryState> = {}): DirectoryState =>
  ({ serverId: 'srv-1', rows, total: rows.length, nextCursor: null, hasMore: false, q: '', role: null, loading: false, error: false, ...extra });

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];

async function render() {
  await act(async () => { root.render(<MembersDirectory serverId="srv-1" />); });
}
function setInput(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  S.fetchDirectory.mockResolvedValue(undefined);
  S.fetchDirectoryMore.mockResolvedValue(undefined);
  S.kickMember.mockResolvedValue(undefined);
  members = [row('me', 'owner')];
  roles = [];
  people = { full: false, truncated: false, onlineCount: 5, memberCount: 3000, loaded: true };
  directory = listed([row('me', 'owner'), row('bob'), row('carol')], { total: 3000, hasMore: true, nextCursor: 'cur-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('MembersDirectory', () => {
  it('asks for the first page on open (unfiltered), renders the rows and the server\'s figures, and offers the next page', async () => {
    await render();
    expect(S.fetchDirectory).toHaveBeenCalledTimes(1);
    expect(S.fetchDirectory).toHaveBeenCalledWith('srv-1', { q: '', role: null });
    expect(qa('[data-testid="member-row"]')).toHaveLength(3);
    expect(q('[data-testid="members-count"]')!.textContent).toBe('serverSettings.members.memberCountPlural:3000/3000');
    const more = q('[data-testid="members-load-more"]')!;
    expect(more.textContent).toBe('serverSettings.members.loadMore');
    await act(async () => { more.click(); });
    expect(S.fetchDirectoryMore).toHaveBeenCalledWith('srv-1');
  });

  it('no next page, no button; another server\'s list is not shown', async () => {
    directory = listed([row('me', 'owner')]);
    await render();
    expect(q('[data-testid="members-load-more"]')).toBeNull();
    directory = listed([row('x')], { serverId: 'srv-2' });
    await render();
    expect(qa('[data-testid="member-row"]')).toHaveLength(0);
    expect(q('[data-testid="members-empty"]')!.textContent).toBe('serverSettings.members.noMembers');
  });

  it('typing settles before it becomes a request; the role filter is immediate; a filtered count reads matching of total', async () => {
    await render();
    setInput(q('[data-testid="members-search"]')!, 'al');
    await act(async () => { await vi.advanceTimersByTimeAsync(DIRECTORY_SEARCH_DEBOUNCE_MS - 50); });
    expect(S.fetchDirectory).toHaveBeenCalledTimes(1);
    setInput(q('[data-testid="members-search"]')!, 'ali');
    await act(async () => { await vi.advanceTimersByTimeAsync(DIRECTORY_SEARCH_DEBOUNCE_MS); });
    expect(S.fetchDirectory).toHaveBeenCalledTimes(2);
    expect(S.fetchDirectory).toHaveBeenLastCalledWith('srv-1', { q: 'ali', role: null });

    const select = q('[data-testid="members-role-filter"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'owner', 'admin', 'none']);
    await act(async () => { setInput(select, 'owner'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(S.fetchDirectory).toHaveBeenCalledTimes(3);
    expect(S.fetchDirectory).toHaveBeenLastCalledWith('srv-1', { q: 'ali', role: 'owner' });

    directory = listed([row('me', 'owner')], { total: 1, q: 'ali', role: 'owner' });
    await render();
    expect(q('[data-testid="members-count"]')!.textContent).toBe('serverSettings.members.memberCountPlural:1/3000');
    directory = listed([], { total: 0, q: 'zzz', role: null });
    await render();
    expect(q('[data-testid="members-empty"]')!.textContent).toBe('serverSettings.members.noResults');
  });

  it('a failed page toasts the translated error (the fallback key when the failure carries no message)', async () => {
    S.fetchDirectory.mockRejectedValueOnce({ status: 500 });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(S.toastError).toHaveBeenCalledWith('serverSettings.members.failedToLoad');
  });

  it('the owner expands a member row, confirms a removal with a reason, and the store is told', async () => {
    await render();
    const rows = qa('[data-testid="member-row"]');
    await act(async () => { (rows[1].firstElementChild as HTMLElement).click(); });
    await act(async () => { q('[data-testid="remove-and-ban"]')!.click(); });
    setInput(q('[data-testid="ban-reason-input"]')!, '  spam  ');
    await act(async () => { q('[data-testid="remove-and-ban-submit"]')!.click(); });
    expect(S.kickMember).toHaveBeenCalledWith('srv-1', 'bob', 'spam');
    expect(S.toastSuccess).toHaveBeenCalledWith('server.removeAndBanned:BOB');
  });
});
