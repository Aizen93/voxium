import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LIMITS, MEMBER_LIST } from '@voxium/shared';

/**
 * The directory hook behind the member pickers: the first page for the text,
 * debounced only while typing; the next page by cursor, appended without
 * duplicates; a stale answer dropped; a failure reported once and answered
 * with null so the picker shows the rows it holds.
 */

const { apiGet, toastError } = vi.hoisted(() => ({ apiGet: vi.fn(), toastError: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { get: apiGet } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { useMemberDirectory, type MemberDirectory } from '../../hooks/useMemberDirectory';

const row = (id: string) => ({ userId: id, nickname: null, user: { id, username: id, displayName: id, avatarUrl: null } });
const page = (ids: string[], extra: Record<string, unknown> = {}) => ({ data: { success: true, data: ids.map(row), total: ids.length, hasMore: false, nextCursor: null, ...extra } });

let latest: MemberDirectory | null = null;
function Probe({ serverId, query }: { serverId: string; query: string }) {
  latest = useMemberDirectory(serverId, query);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = (serverId: string, query: string) =>
  act(() => {
    root.render(<Probe serverId={serverId} query={query} />);
  });
// The first page is behind a (0 ms) timer and the answer behind a promise: a
// macrotask lets both land, with real timers.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

beforeEach(() => {
  apiGet.mockReset();
  toastError.mockClear();
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useMemberDirectory', () => {
  it('answers null until the first page, then the directory rows, total and hasMore', async () => {
    apiGet.mockResolvedValueOnce(page(['a', 'b', 'c'], { total: 240, hasMore: true, nextCursor: 'cur1' }));
    render('srv', '');
    expect(latest!.rows).toBeNull();
    expect(latest!.loading).toBe(true);
    await flush();
    expect(apiGet).toHaveBeenCalledWith('/servers/srv/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE } });
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['a', 'b', 'c']);
    expect(latest!.total).toBe(240);
    expect(latest!.hasMore).toBe(true);
    expect(latest!.loading).toBe(false);
  });

  it('loads the next page by cursor and appends it without duplicates', async () => {
    apiGet
      .mockResolvedValueOnce(page(['a', 'b'], { total: 4, hasMore: true, nextCursor: 'cur1' }))
      .mockResolvedValueOnce(page(['b', 'c', 'd'], { total: 4, hasMore: false, nextCursor: null }));
    render('srv', '');
    await flush();
    act(() => latest!.loadMore());
    expect(latest!.loading).toBe(true);
    await flush();
    expect(apiGet).toHaveBeenLastCalledWith('/servers/srv/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE, cursor: 'cur1' } });
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['a', 'b', 'c', 'd']);
    expect(latest!.hasMore).toBe(false);
    // nothing left: a further call asks for nothing
    act(() => latest!.loadMore());
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('sends the text to the server after the typing debounce, and the empty text at once', async () => {
    vi.useFakeTimers();
    apiGet.mockResolvedValue(page(['zed']));
    render('srv', '');
    expect(apiGet).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);

    render('srv', 'ze');
    expect(latest!.rows).toBeNull(); // the old page is for another text
    await act(async () => {
      vi.advanceTimersByTime(MEMBER_LIST.TYPING_DEBOUNCE_MS - 1);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(apiGet).toHaveBeenLastCalledWith('/servers/srv/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE, q: 'ze' } });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['zed']);
  });

  it('drops a first page that arrives for a text that is no longer current', async () => {
    let resolveOld!: (v: unknown) => void;
    apiGet
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(page(['new']));
    render('srv', '');
    await flush(); // the first request is on the wire, unanswered
    render('srv2', '');
    expect(latest!.rows).toBeNull(); // nothing of the old text shows meanwhile
    await flush();
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['new']);
    await act(async () => {
      resolveOld(page(['old']));
    });
    await flush();
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['new']);
  });

  it('a failed first page answers null, reports once, and is not loading', async () => {
    apiGet.mockRejectedValueOnce(new Error('429'));
    render('srv', '');
    await flush();
    expect(latest!.rows).toBeNull();
    expect(latest!.error).toBe(true);
    expect(latest!.loading).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('a failed next page keeps the rows already shown', async () => {
    apiGet
      .mockResolvedValueOnce(page(['a'], { hasMore: true, nextCursor: 'cur1' }))
      .mockRejectedValueOnce(new Error('network'));
    render('srv', '');
    await flush();
    act(() => latest!.loadMore());
    await flush();
    expect(latest!.rows!.map((m) => m.userId)).toEqual(['a']);
    expect(latest!.error).toBe(true);
    expect(latest!.hasMore).toBe(true); // can be asked for again
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
