import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MEMBER_LIST } from '@voxium/shared';
import type { ServerMember } from '@voxium/shared';

/**
 * The pickers' server search: null while the text is empty or the server has
 * not answered (the caller filters its own rows), the rows once it has, and
 * null again — never [] — when the request failed, so a member the client
 * already holds is still offered. memberMatches is that local filter.
 */

vi.mock('../../services/api', () => ({ api: { get: vi.fn() } }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { api } from '../../services/api';
import { useMemberSearch, memberMatches } from '../../hooks/useMemberSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockGet = api.get as unknown as Mock;

const row = (id: string, nickname: string | null = null): ServerMember =>
  ({ userId: id, serverId: 'srv-1', role: 'member', nickname, joinedAt: '', roles: [], user: { id, username: id, displayName: id.toUpperCase(), avatarUrl: null, status: 'online' } } as unknown as ServerMember);

let latest: ServerMember[] | null | undefined;
function Probe({ query }: { query: string }) {
  latest = useMemberSearch('srv-1', query);
  return null;
}

let container: HTMLDivElement;
let root: Root;
async function render(query: string) {
  await act(async () => { root.render(<Probe query={query} />); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  latest = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useMemberSearch', () => {
  it('asks the server once the typing settled, with the picker limit, and hands back its rows', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [row('alice')] } });
    await render('al');
    expect(latest).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_LIST.TYPING_DEBOUNCE_MS); });
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members/search', { params: { q: 'al', limit: MEMBER_LIST.SEARCH_MAX } });
    expect(latest!.map((m) => m.userId)).toEqual(['alice']);
    // empty text: nothing asked, the caller's rows
    await render('   ');
    expect(latest).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('a failed request is null (the caller falls back to its own rows) and toasts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockRejectedValueOnce(new Error('429'));
    await render('al');
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_LIST.TYPING_DEBOUNCE_MS); });
    expect(latest).toBeNull();
    expect(toastError).toHaveBeenCalledWith('common.somethingWentWrong');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('results for an older text are not handed out for the newer one', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [row('alice')] } });
    await render('al');
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_LIST.TYPING_DEBOUNCE_MS); });
    expect(latest).not.toBeNull();
    mockGet.mockReturnValueOnce(new Promise(() => {}));
    await render('ali');
    expect(latest).toBeNull();
  });
});

describe('memberMatches', () => {
  it('matches display name, username and nickname, case-insensitively; empty text matches everyone', () => {
    const m = row('bob', 'Deuce');
    expect(memberMatches(m, '')).toBe(true);
    expect(memberMatches(m, 'BO')).toBe(true);
    expect(memberMatches(m, 'deu')).toBe(true);
    expect(memberMatches(m, 'zzz')).toBe(false);
  });
});
