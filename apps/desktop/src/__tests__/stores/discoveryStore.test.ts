import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { DiscoveryServer, DiscoveryPage } from '@voxium/shared';

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

import { api } from '../../services/api';
import { useDiscoveryStore, searchableQuery } from '../../stores/discoveryStore';
import { useServerStore } from '../../stores/serverStore';

/**
 * Explore's store: the browse state and the viewer's actions
 * (docs/local/server-discovery-plan.html, "Desktop client → Explore").
 */

const mockGet = api.get as unknown as Mock;
const mockPost = api.post as unknown as Mock;
const mockDelete = api.delete as unknown as Mock;

const card = (id: string, extra: Partial<DiscoveryServer> = {}): DiscoveryServer => ({
  id, name: `Space ${id}`, iconUrl: null, description: null, tags: [], memberCount: 1, onlineCount: 0, weeklyMessages: 0,
  joinMode: 'approval', featured: false, isMember: false, requestPending: false, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null,
  ...extra,
});
const page = (servers: DiscoveryServer[], extra: Partial<DiscoveryPage> = {}) => ({
  data: { success: true, data: { featured: [], servers, nextCursor: null, totalCapped: servers.length, ...extra } },
});
const axiosError = (status: number, error: string) =>
  Object.assign(new Error(error), { isAxiosError: true, response: { status, data: { success: false, error } } });

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const setActiveServer = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  useDiscoveryStore.setState({
    query: '', tag: '', sort: 'active', featured: [], servers: [], nextCursor: null, totalCapped: 0,
    status: 'idle', error: null, loading: false, loadingMore: false, busyServerId: null,
  });
  useServerStore.setState({ servers: [], setActiveServer });
});

describe('searchableQuery', () => {
  it('sends a query only between 3 and 64 characters, trimmed', () => {
    expect(searchableQuery('  ab ')).toBeNull();
    expect(searchableQuery(' abc ')).toBe('abc');
    expect(searchableQuery('x'.repeat(64))).toHaveLength(64);
    expect(searchableQuery('x'.repeat(65))).toBeNull();
  });
});

describe('discoveryStore — browsing', () => {
  it('fetchFirst asks for the sort alone, adds q only once searchable and the tag when set, and stores the page', async () => {
    mockGet.mockResolvedValue(page([card('a')], { featured: [card('f', { featured: true })], nextCursor: 'c1', totalCapped: 1000 }));
    await useDiscoveryStore.getState().fetchFirst();
    expect(mockGet).toHaveBeenCalledWith('/discovery/servers', { params: { sort: 'active' } });
    const s = useDiscoveryStore.getState();
    expect(s.status).toBe('ready');
    expect(s.servers.map((x) => x.id)).toEqual(['a']);
    expect(s.featured.map((x) => x.id)).toEqual(['f']);
    expect(s.nextCursor).toBe('c1');
    expect(s.totalCapped).toBe(1000);
    expect(s.loading).toBe(false);

    useDiscoveryStore.setState({ query: 'ab', tag: 'gaming', sort: 'members' });
    await useDiscoveryStore.getState().fetchFirst();
    expect(mockGet).toHaveBeenLastCalledWith('/discovery/servers', { params: { sort: 'members', tag: 'gaming' } });

    useDiscoveryStore.setState({ query: ' raid ' });
    await useDiscoveryStore.getState().fetchFirst();
    expect(mockGet).toHaveBeenLastCalledWith('/discovery/servers', { params: { sort: 'members', q: 'raid', tag: 'gaming' } });
  });

  it('a fetchFirst that resolves after a newer one was started is dropped', async () => {
    const slow = deferred();
    const fast = deferred();
    mockGet.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const p1 = useDiscoveryStore.getState().fetchFirst();
    useDiscoveryStore.setState({ tag: 'music' });
    const p2 = useDiscoveryStore.getState().fetchFirst();
    fast.resolve(page([card('music')]));
    await p2;
    slow.resolve(page([card('stale')]));
    await p1;
    expect(useDiscoveryStore.getState().servers.map((x) => x.id)).toEqual(['music']);
  });

  it('fetchMore follows the cursor with the same filters, appends without duplicates, and is a no-op without a cursor', async () => {
    useDiscoveryStore.setState({ query: 'raid', tag: 'gaming', sort: 'name', servers: [card('a'), card('b')], nextCursor: 'c1', status: 'ready' });
    mockGet.mockResolvedValue(page([card('b'), card('c')], { nextCursor: 'c2' }));
    await useDiscoveryStore.getState().fetchMore();
    expect(mockGet).toHaveBeenCalledWith('/discovery/servers', { params: { sort: 'name', cursor: 'c1', q: 'raid', tag: 'gaming' } });
    expect(useDiscoveryStore.getState().servers.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(useDiscoveryStore.getState().nextCursor).toBe('c2');
    expect(useDiscoveryStore.getState().loadingMore).toBe(false);

    useDiscoveryStore.setState({ nextCursor: null });
    mockGet.mockClear();
    await useDiscoveryStore.getState().fetchMore();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a page that arrives after the browse changed is dropped', async () => {
    useDiscoveryStore.setState({ servers: [card('a')], nextCursor: 'c1', status: 'ready' });
    const more = deferred();
    mockGet.mockReturnValueOnce(more.promise).mockResolvedValueOnce(page([card('fresh')]));
    const pMore = useDiscoveryStore.getState().fetchMore();
    await useDiscoveryStore.getState().fetchFirst(); // a new browse
    more.resolve(page([card('late')], { nextCursor: 'c9' }));
    await pMore;
    expect(useDiscoveryStore.getState().servers.map((x) => x.id)).toEqual(['fresh']);
    expect(useDiscoveryStore.getState().nextCursor).toBeNull();
  });

  it('the flag-off 403 is the "off" state, not an error; any other failure is "error" with the message kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useDiscoveryStore.setState({ servers: [card('a')], featured: [card('f')], status: 'ready' });
    mockGet.mockRejectedValue(axiosError(403, 'Server discovery is currently disabled'));
    await useDiscoveryStore.getState().fetchFirst();
    expect(useDiscoveryStore.getState().status).toBe('off');
    expect(useDiscoveryStore.getState().servers).toEqual([]);
    expect(useDiscoveryStore.getState().featured).toEqual([]);
    expect(useDiscoveryStore.getState().error).toBeNull();

    mockGet.mockRejectedValue(axiosError(400, 'Refine your search'));
    await useDiscoveryStore.getState().fetchFirst();
    expect(useDiscoveryStore.getState().status).toBe('error');
    expect(useDiscoveryStore.getState().error).toBe('Refine your search');
    expect(useDiscoveryStore.getState().loading).toBe(false);
    expect(warn).toHaveBeenCalled();

    // fetchMore surfaces its failure to the caller (a toast) and keeps the list
    useDiscoveryStore.setState({ servers: [card('a')], nextCursor: 'c1', status: 'ready' });
    mockGet.mockRejectedValue(new Error('network'));
    await expect(useDiscoveryStore.getState().fetchMore()).rejects.toThrow('network');
    expect(useDiscoveryStore.getState().servers).toHaveLength(1);
    expect(useDiscoveryStore.getState().loadingMore).toBe(false);
    warn.mockRestore();
  });

  it('refuses a malformed page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockResolvedValue({ data: { success: true, data: { servers: 'nope' } } });
    await useDiscoveryStore.getState().fetchFirst();
    expect(useDiscoveryStore.getState().status).toBe('error');
    warn.mockRestore();
  });
});

describe('discoveryStore — the viewer\'s actions', () => {
  const server = { id: 'srv-a', name: 'Space a', iconUrl: null, invitesLocked: false, ownerId: 'o', createdAt: '2026-01-01T00:00:00.000Z' };

  it('join (open mode) POSTs, appends the server to the strip once, makes it active and flips the card to Open', async () => {
    useDiscoveryStore.setState({ servers: [card('a', { joinMode: 'open' })], featured: [card('a', { joinMode: 'open', featured: true })], status: 'ready' });
    mockPost.mockResolvedValue({ data: { success: true, data: server } });
    const seen: (string | null)[] = [];
    const unsub = useDiscoveryStore.subscribe((s) => seen.push(s.busyServerId));

    await expect(useDiscoveryStore.getState().join('a')).resolves.toEqual(server);
    expect(mockPost).toHaveBeenCalledWith('/discovery/servers/a/join');
    expect(useServerStore.getState().servers.map((s) => s.id)).toEqual(['srv-a']);
    expect(setActiveServer).toHaveBeenCalledWith('srv-a');
    // the card reads Open and counts the viewer (the page cache would not, for a minute)
    expect(useDiscoveryStore.getState().servers[0]).toMatchObject({ isMember: true, requestPending: false, memberCount: 2 });
    expect(useDiscoveryStore.getState().featured[0]).toMatchObject({ isMember: true, requestPending: false, memberCount: 2 });
    expect(seen).toContain('a');
    expect(useDiscoveryStore.getState().busyServerId).toBeNull();
    unsub();

    // already in the strip (an invite join raced): not appended twice, not counted twice
    await useDiscoveryStore.getState().join('a');
    expect(useServerStore.getState().servers).toHaveLength(1);
    expect(useDiscoveryStore.getState().servers[0].memberCount).toBe(2);
  });

  it('a refused join (banned, full) rethrows for the toast and clears the busy mark', async () => {
    useDiscoveryStore.setState({ servers: [card('a', { joinMode: 'open' })], status: 'ready' });
    mockPost.mockRejectedValue(axiosError(403, 'You are banned from this server'));
    await expect(useDiscoveryStore.getState().join('a')).rejects.toThrow();
    expect(useServerStore.getState().servers).toEqual([]);
    expect(useDiscoveryStore.getState().servers[0].isMember).toBe(false);
    expect(useDiscoveryStore.getState().busyServerId).toBeNull();
  });

  it('request sends the trimmed message (or no body), and the card reads Requested', async () => {
    useDiscoveryStore.setState({ servers: [card('a')], status: 'ready' });
    mockPost.mockResolvedValue({ data: { success: true, data: { status: 'pending' } } });
    await useDiscoveryStore.getState().request('a', '  let me in  ');
    expect(mockPost).toHaveBeenCalledWith('/discovery/servers/a/join', { message: 'let me in' });
    expect(useDiscoveryStore.getState().servers[0].requestPending).toBe(true);

    await useDiscoveryStore.getState().request('a', '   ');
    expect(mockPost).toHaveBeenLastCalledWith('/discovery/servers/a/join', {});
    await useDiscoveryStore.getState().request('a');
    expect(mockPost).toHaveBeenLastCalledWith('/discovery/servers/a/join', {});
  });

  it('a refused request (cooldown) rethrows and leaves the card alone', async () => {
    useDiscoveryStore.setState({ servers: [card('a')], status: 'ready' });
    mockPost.mockRejectedValue(axiosError(403, 'Your request was declined recently. Please try again later.'));
    await expect(useDiscoveryStore.getState().request('a')).rejects.toThrow();
    expect(useDiscoveryStore.getState().servers[0].requestPending).toBe(false);
    expect(useDiscoveryStore.getState().busyServerId).toBeNull();
  });

  it('cancelRequest DELETEs and clears the pending mark — also on a 404 (the row was already settled)', async () => {
    useDiscoveryStore.setState({ servers: [card('a', { requestPending: true })], status: 'ready' });
    mockDelete.mockResolvedValue({ data: { success: true } });
    await useDiscoveryStore.getState().cancelRequest('a');
    expect(mockDelete).toHaveBeenCalledWith('/discovery/servers/a/join');
    expect(useDiscoveryStore.getState().servers[0].requestPending).toBe(false);

    useDiscoveryStore.setState({ servers: [card('a', { requestPending: true })] });
    mockDelete.mockRejectedValue(axiosError(404, 'Join request not found'));
    await useDiscoveryStore.getState().cancelRequest('a');
    expect(useDiscoveryStore.getState().servers[0].requestPending).toBe(false);

    useDiscoveryStore.setState({ servers: [card('a', { requestPending: true })] });
    mockDelete.mockRejectedValue(new Error('network'));
    await expect(useDiscoveryStore.getState().cancelRequest('a')).rejects.toThrow('network');
    expect(useDiscoveryStore.getState().servers[0].requestPending).toBe(true);
  });

  it('markRequestResolved: approved makes the card a member, declined only clears the mark; unknown ids change nothing', () => {
    useDiscoveryStore.setState({ servers: [card('a', { requestPending: true }), card('b', { requestPending: true })], status: 'ready' });
    const before = useDiscoveryStore.getState().servers;
    useDiscoveryStore.getState().markRequestResolved('a', 'approved');
    useDiscoveryStore.getState().markRequestResolved('b', 'declined');
    const [a, b] = useDiscoveryStore.getState().servers;
    expect(a).toMatchObject({ isMember: true, requestPending: false, memberCount: 2 });
    expect(b).toMatchObject({ isMember: false, requestPending: false, memberCount: 1 });
    useDiscoveryStore.getState().markRequestResolved('zzz', 'approved');
    expect(useDiscoveryStore.getState().servers).not.toBe(before);
    const after = useDiscoveryStore.getState().servers;
    useDiscoveryStore.getState().markRequestResolved('zzz', 'approved');
    expect(useDiscoveryStore.getState().servers).toBe(after); // untouched reference when nothing matched
  });
});
