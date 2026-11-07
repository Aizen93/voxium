import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerBan, ServerJoinRequest } from '@voxium/shared';

/**
 * Server settings → Members → Join requests and Banned (KICK_MEMBERS). Both
 * sections read the store's lists, fetch on open and act through the store;
 * the tests pin what each row shows and which store action each button runs.
 */

// A STABLE t, like react-i18next's: the sections list it in an effect
// dependency, and a fresh function per render would loop the effect.
const t = (k: string, o?: Record<string, unknown>) => (o && 'name' in o ? `${k}:${o.name}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const S = vi.hoisted(() => ({
  fetchJoinRequests: vi.fn(), approveJoinRequest: vi.fn(), declineJoinRequest: vi.fn(),
  fetchBans: vi.fn(), unbanMember: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));

let joinRequests: ServerJoinRequest[] = [];
let bans: ServerBan[] = [];
/** Which server the store's lists were loaded for (one list at a time). */
let listsFor = 'srv-1';
vi.mock('../../stores/serverStore', () => {
  const NO_JOIN_REQUESTS: never[] = [];
  const NO_BANS: never[] = [];
  const state = () => ({ joinRequests, bans, joinRequestsServerId: listsFor, bansServerId: listsFor, ...S });
  const useServerStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useServerStore.getState = state;
  return { useServerStore, NO_JOIN_REQUESTS, NO_BANS };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: S.toastSuccess, error: S.toastError, info: vi.fn(), warning: vi.fn() } }));

import { JoinRequestsSection } from '../../components/server/JoinRequestsSection';
import { BannedSection } from '../../components/server/BannedSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bob = { id: 'u-2', username: 'bob', displayName: 'Bob', avatarUrl: null };

let container: HTMLDivElement;
let root: Root;
async function render(ui: React.ReactElement) {
  await act(async () => { root.render(ui); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];

beforeEach(() => {
  vi.clearAllMocks();
  joinRequests = [];
  bans = [];
  listsFor = 'srv-1';
  S.fetchJoinRequests.mockResolvedValue(undefined);
  S.fetchBans.mockResolvedValue(undefined);
  S.approveJoinRequest.mockResolvedValue(undefined);
  S.declineJoinRequest.mockResolvedValue(undefined);
  S.unbanMember.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('JoinRequestsSection', () => {
  it('fetches on open and shows the empty state', async () => {
    await render(<JoinRequestsSection serverId="srv-1" />);
    expect(S.fetchJoinRequests).toHaveBeenCalledWith('srv-1');
    expect(q('[data-testid="join-requests-empty"]')).not.toBeNull();
  });

  it('lists each request with the user, the message (or its absence) and the time, and approves / declines through the store', async () => {
    joinRequests = [
      { id: 'r-1', serverId: 'srv-1', userId: 'u-2', message: 'Let me in', status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: bob },
      { id: 'r-2', serverId: 'srv-1', userId: 'u-3', message: null, status: 'pending', createdAt: '2026-10-09T11:00:00.000Z', user: { ...bob, id: 'u-3', username: 'cy', displayName: 'Cy' } },
    ];
    await render(<JoinRequestsSection serverId="srv-1" />);
    const rows = qa('[data-testid="join-request-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Bob');
    expect(rows[0].textContent).toContain('@bob');
    expect(rows[0].querySelector('[data-testid="join-request-message"]')!.textContent).toBe('Let me in');
    expect(rows[1].querySelector('[data-testid="join-request-message"]')!.textContent).toBe('server.joinRequests.noMessage');
    expect(rows[0].textContent).toContain('server.joinRequests.requestedAt');

    await act(async () => { (rows[0].querySelector('[data-testid="join-request-approve"]') as HTMLButtonElement).click(); });
    expect(S.approveJoinRequest).toHaveBeenCalledWith('srv-1', 'u-2');
    expect(S.toastSuccess).toHaveBeenCalledWith('server.joinRequests.approved:Bob');

    await act(async () => { (rows[1].querySelector('[data-testid="join-request-decline"]') as HTMLButtonElement).click(); });
    expect(S.declineJoinRequest).toHaveBeenCalledWith('srv-1', 'u-3');
    expect(S.toastSuccess).toHaveBeenCalledWith('server.joinRequests.declined:Cy');
  });

  it('a refused approval (the helper said banned, or the row vanished) toasts the error', async () => {
    joinRequests = [{ id: 'r-1', serverId: 'srv-1', userId: 'u-2', message: null, status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: bob }];
    S.approveJoinRequest.mockRejectedValue(new Error('Join request not found'));
    await render(<JoinRequestsSection serverId="srv-1" />);
    await act(async () => { q('[data-testid="join-request-approve"]')!.click(); });
    expect(S.toastError).toHaveBeenCalledTimes(1);
    expect(S.toastSuccess).not.toHaveBeenCalled();
  });

  it('a failed fetch toasts and still renders', async () => {
    S.fetchJoinRequests.mockRejectedValue(new Error('boom'));
    await render(<JoinRequestsSection serverId="srv-1" />);
    expect(S.toastError).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="join-requests"]')).not.toBeNull();
  });

  it('a list the store loaded for ANOTHER server is not shown here', async () => {
    joinRequests = [{ id: 'r-1', serverId: 'srv-9', userId: 'u-2', message: null, status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: bob }];
    listsFor = 'srv-9';
    await render(<JoinRequestsSection serverId="srv-1" />);
    expect(qa('[data-testid="join-request-row"]')).toHaveLength(0);
    expect(q('[data-testid="join-requests-empty"]')).not.toBeNull();
  });
});

describe('BannedSection', () => {
  it('fetches on open, shows the empty state, and lists bans with reason, date and who banned', async () => {
    await render(<BannedSection serverId="srv-1" />);
    expect(S.fetchBans).toHaveBeenCalledWith('srv-1');
    expect(q('[data-testid="banned-empty"]')).not.toBeNull();

    bans = [
      { serverId: 'srv-1', userId: 'u-2', reason: 'spam', createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: { id: 'u-1', username: 'alice', displayName: 'Alice' } },
      { serverId: 'srv-1', userId: 'u-3', reason: null, createdAt: '2026-10-09T11:00:00.000Z', user: { ...bob, id: 'u-3', username: 'cy', displayName: 'Cy' }, bannedBy: null },
    ];
    await render(<BannedSection serverId="srv-1" />);
    const rows = qa('[data-testid="ban-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-testid="ban-reason"]')!.textContent).toBe('spam');
    expect(rows[0].textContent).toContain('server.banned.by:Alice');
    expect(rows[1].querySelector('[data-testid="ban-reason"]')!.textContent).toBe('server.banned.noReason');
    expect(rows[1].textContent).not.toContain('server.banned.by');
  });

  it('unban goes through the store and toasts', async () => {
    bans = [{ serverId: 'srv-1', userId: 'u-2', reason: null, createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: null }];
    await render(<BannedSection serverId="srv-1" />);
    await act(async () => { q('[data-testid="ban-unban"]')!.click(); });
    expect(S.unbanMember).toHaveBeenCalledWith('srv-1', 'u-2');
    expect(S.toastSuccess).toHaveBeenCalledWith('server.banned.unbanned:Bob');

    S.unbanMember.mockRejectedValue(new Error('Ban not found'));
    await act(async () => { q('[data-testid="ban-unban"]')!.click(); });
    expect(S.toastError).toHaveBeenCalledTimes(1);
  });

  it('a banned list the store loaded for ANOTHER server is not shown here', async () => {
    bans = [{ serverId: 'srv-9', userId: 'u-2', reason: null, createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: null }];
    listsFor = 'srv-9';
    await render(<BannedSection serverId="srv-1" />);
    expect(qa('[data-testid="ban-row"]')).toHaveLength(0);
    expect(q('[data-testid="banned-empty"]')).not.toBeNull();
  });
});
