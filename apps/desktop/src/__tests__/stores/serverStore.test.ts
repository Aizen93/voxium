import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ─── Mock the API client with controllable promises ─────────────────────────

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  },
}));

import { useServerStore, EMPTY_PEOPLE, EMPTY_DIRECTORY, resetMemberLookupState, retireDirectory, MEMBER_LOOKUP_DEBOUNCE_MS } from '../../stores/serverStore';
import { api } from '../../services/api';
import { LIMITS, MEMBER_LIST } from '@voxium/shared';
import type { Channel, ServerMember, PublicUser } from '@voxium/shared';

const mockGet = api.get as unknown as Mock;
const mockPost = api.post as unknown as Mock;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const staleChannel = { id: 'ch-old', serverId: 'srv-B', name: 'old-general', type: 'text' } as unknown as Channel;
const staleMember = { userId: 'u-old', serverId: 'srv-B', role: 'member', user: { id: 'u-old', username: 'old' } } as unknown as ServerMember;

describe('serverStore — staleness guards (MED-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // markChannelRead fire-and-forget POSTs need a real promise to .catch() on
    mockPost.mockResolvedValue({ data: { data: {} } });
    resetMemberLookupState();
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      channels: [],
      categories: [],
      activeChannelId: null,
      members: [],
      people: EMPTY_PEOPLE,
      directory: EMPTY_DIRECTORY,
      roles: [],
      isLoading: false,
      unreadCounts: {},
      serverUnreadCounts: {},
    });
  });

  describe('setActiveServer race', () => {
    it('discards a slow response for a server the user already navigated away from', async () => {
      useServerStore.setState({ channels: [staleChannel] });

      const pending = deferred();
      mockGet.mockReturnValueOnce(pending.promise);

      const joinPromise = useServerStore.getState().setActiveServer('srv-A');
      expect(useServerStore.getState().activeServerId).toBe('srv-A');
      expect(useServerStore.getState().isLoading).toBe(true);

      // User moves on to another server while srv-A's GET is still in flight
      useServerStore.setState({ activeServerId: 'srv-B' });

      pending.resolve({
        data: {
          data: {
            channels: [{ id: 'ch-A1', serverId: 'srv-A', name: 'general', type: 'text' }],
            categories: [{ id: 'cat-A1', serverId: 'srv-A', name: 'Cat A' }],
            roles: [{ id: 'role-A1', name: 'Role A' }],
          },
        },
      });
      await joinPromise;

      // srv-A's payload must NOT be applied under srv-B
      const state = useServerStore.getState();
      expect(state.channels).toEqual([staleChannel]);
      expect(state.categories).toEqual([]);
      expect(state.roles).toEqual([]);
      expect(state.activeChannelId).toBeNull();

      // The follow-up member fetch for srv-A must never start
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledWith('/servers/srv-A');
    });

    it('discards a FAILED stale request without surfacing isLoading changes', async () => {
      const pending = deferred();
      mockGet.mockReturnValueOnce(pending.promise);

      const joinPromise = useServerStore.getState().setActiveServer('srv-A');
      useServerStore.setState({ activeServerId: 'srv-B', isLoading: false });

      pending.reject(new Error('network down'));
      await joinPromise;

      // The catch path is also guarded — no isLoading flip for a stale server
      expect(useServerStore.getState().isLoading).toBe(false);
      expect(useServerStore.getState().activeServerId).toBe('srv-B');
    });
  });

  describe('fetchPeople race', () => {
    it('discards a slow people response for a server no longer being viewed', async () => {
      useServerStore.setState({ activeServerId: 'srv-A', members: [staleMember] });

      const pending = deferred();
      mockGet.mockReturnValueOnce(pending.promise);

      const fetchPromise = useServerStore.getState().fetchPeople('srv-A');

      // User switches servers while srv-A's request is in flight
      useServerStore.setState({ activeServerId: 'srv-B' });

      pending.resolve({
        data: { data: [{ userId: 'u-A', serverId: 'srv-A', role: 'member', user: { id: 'u-A', username: 'a' } }], full: true, onlineCount: 0, memberCount: 1 },
      });
      await fetchPromise;

      expect(useServerStore.getState().members).toEqual([staleMember]);
      expect(useServerStore.getState().people.loaded).toBe(false);
    });

    it('control: applies the slice and its figures when the server is still active', async () => {
      useServerStore.setState({ activeServerId: 'srv-D' });

      const freshMembers = [{ userId: 'u-D', serverId: 'srv-D', role: 'member', user: { id: 'u-D', username: 'd', status: 'online' } }];
      mockGet.mockResolvedValueOnce({ data: { data: freshMembers, full: false, truncated: true, onlineCount: 640, memberCount: 12_000 } });

      await useServerStore.getState().fetchPeople('srv-D');

      expect(mockGet).toHaveBeenCalledWith('/servers/srv-D/members/online');
      expect(useServerStore.getState().members).toEqual(freshMembers);
      expect(useServerStore.getState().people).toEqual({ full: false, truncated: true, onlineCount: 640, memberCount: 12_000, loaded: true });
    });

    it('a response without the figures is a full list (every row counts itself)', async () => {
      useServerStore.setState({ activeServerId: 'srv-D' });
      mockGet.mockResolvedValueOnce({ data: { data: [
        { userId: 'u-1', serverId: 'srv-D', role: 'owner', user: { id: 'u-1', username: 'a', status: 'online' } },
        { userId: 'u-2', serverId: 'srv-D', role: 'member', user: { id: 'u-2', username: 'b', status: 'offline' } },
      ] } });
      await useServerStore.getState().fetchPeople('srv-D');
      expect(useServerStore.getState().people).toEqual({ full: true, truncated: false, onlineCount: 1, memberCount: 2, loaded: true });
    });
  });

  describe('setActiveServer control', () => {
    it('applies channels, categories, roles and members when the server is still active', async () => {
      const chC = { id: 'ch-C1', serverId: 'srv-C', name: 'general', type: 'text' };
      const catC = { id: 'cat-C1', serverId: 'srv-C', name: 'Cat C' };
      const roleC = { id: 'role-C1', name: 'Role C' };
      const memberC = { userId: 'u-C', serverId: 'srv-C', role: 'member', user: { id: 'u-C', username: 'c' } };

      mockGet.mockImplementation((url: string) => {
        if (url === '/servers/srv-C') {
          return Promise.resolve({ data: { data: { channels: [chC], categories: [catC], roles: [roleC] } } });
        }
        if (url === '/servers/srv-C/members/online') {
          return Promise.resolve({ data: { data: [memberC], full: true, onlineCount: 0, memberCount: 1 } });
        }
        return Promise.reject(new Error(`unexpected GET ${url}`));
      });

      await useServerStore.getState().setActiveServer('srv-C');

      const state = useServerStore.getState();
      expect(state.activeServerId).toBe('srv-C');
      expect(state.channels).toEqual([chC]);
      expect(state.categories).toEqual([catC]);
      expect(state.roles).toEqual([roleC]);
      expect(state.activeChannelId).toBe('ch-C1'); // first text channel auto-selected
      expect(state.isLoading).toBe(false);

      // Background member fetch also lands (activeServerId still matches)
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useServerStore.getState().members).toEqual([memberC]);
    });

    it('switching servers drops the previous server\'s rows at once — they must not answer for the next one', async () => {
      useServerStore.setState({ activeServerId: 'srv-B', members: [staleMember], people: { ...EMPTY_PEOPLE, loaded: true, memberCount: 1 } });
      mockGet.mockImplementation(() => new Promise(() => {}));
      void useServerStore.getState().setActiveServer('srv-C');
      expect(useServerStore.getState().members).toEqual([]);
      expect(useServerStore.getState().people).toEqual(EMPTY_PEOPLE);
    });
  });
});

// ─── The member cache, presence and the directory ───────────────────────────

const row = (id: string, extra: Partial<ServerMember> = {}, user: Partial<PublicUser> = {}): ServerMember => ({
  userId: id, serverId: 'srv-1', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
  user: { id, username: id, displayName: id.toUpperCase(), avatarUrl: null, bio: null, status: 'offline', role: 'user', isSupporter: false, supporterTier: null, createdAt: '2026-01-01T00:00:00.000Z', ...user } as PublicUser,
  ...extra,
});
const joiner = (id: string, status: PublicUser['status'] = 'online'): PublicUser =>
  ({ id, username: id, displayName: id.toUpperCase(), avatarUrl: null, bio: null, status, role: 'user', isSupporter: false, supporterTier: null, createdAt: '2026-01-01T00:00:00.000Z' }) as PublicUser;
const ids = (rows: ServerMember[]) => rows.map((m) => m.userId);

describe('serverStore — member lookups (ensureMembers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetMemberLookupState();
    useServerStore.setState({ activeServerId: 'srv-1', members: [row('me', { role: 'owner' }, { status: 'online' })], people: { full: false, truncated: false, onlineCount: 1, memberCount: 5000, loaded: true }, directory: EMPTY_DIRECTORY });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('collects unknown ids for one debounce window and asks for them in ONE request; known ids and repeats are not asked', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-2', {}, { status: 'online' }), row('u-3')] } });
    const store = useServerStore.getState();
    store.ensureMembers(['u-2', 'me']);
    store.ensureMembers(['u-3', 'u-2', '']);
    expect(mockGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members/lookup', { params: { ids: 'u-2,u-3' } });
    expect(ids(useServerStore.getState().members)).toEqual(['me', 'u-2', 'u-3']);
    // the online one came online after the slice was loaded: counted
    expect(useServerStore.getState().people.onlineCount).toBe(2);
  });

  it('an id the server did not return is a non-member: remembered, never asked again until the server changes', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    useServerStore.getState().ensureMembers(['ghost']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    useServerStore.getState().ensureMembers(['ghost']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS * 2);
    expect(mockGet).toHaveBeenCalledTimes(1);
    // a join clears the mark
    useServerStore.getState().addMember('srv-1', joiner('ghost', 'offline'));
    useServerStore.setState({ members: useServerStore.getState().members.filter((m) => m.userId !== 'ghost') });
    useServerStore.getState().ensureMembers(['ghost']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('splits more than LOOKUP_MAX_IDS ids over consecutive requests', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    useServerStore.getState().ensureMembers(Array.from({ length: MEMBER_LIST.LOOKUP_MAX_IDS + 5 }, (_, i) => `u-${i}`));
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect((mockGet.mock.calls[0][1] as { params: { ids: string } }).params.ids.split(',')).toHaveLength(MEMBER_LIST.LOOKUP_MAX_IDS);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect((mockGet.mock.calls[1][1] as { params: { ids: string } }).params.ids.split(',')).toHaveLength(5);
  });

  it('a failed lookup is logged and retried by itself after the back-off — nobody re-asks for a row they are already waiting on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockRejectedValueOnce(new Error('503'));
    useServerStore.getState().ensureMembers(['u-2']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    mockGet.mockResolvedValue({ data: { data: [row('u-2')] } });
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(ids(useServerStore.getState().members)).toContain('u-2');
    warn.mockRestore();
  });

  it('three failures in a row drop the queue (a server that keeps failing is not asked forever)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error('503'));
    useServerStore.getState().ensureMembers(['u-2']);
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(10_000 + MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][0]).toContain('giving up');
    warn.mockRestore();
  });

  it('ids queued while the slice is in flight still go out once it lands (minus the ones the slice now holds)', async () => {
    const slice = deferred();
    mockGet.mockReturnValueOnce(slice.promise);
    const loading = useServerStore.getState().fetchPeople('srv-1');
    useServerStore.getState().ensureMembers(['u-author', 'u-in-slice']);
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-author')] } });
    slice.resolve({ data: { data: [row('me', { role: 'owner' }, { status: 'online' }), row('u-in-slice')], full: false, truncated: false, onlineCount: 1, memberCount: 5000 } });
    await loading;
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenLastCalledWith('/servers/srv-1/members/lookup', { params: { ids: 'u-author' } });
    expect(ids(useServerStore.getState().members)).toEqual(['me', 'u-in-slice', 'u-author']);
  });

  it('ids a request is already out for are not asked again by a second flush', async () => {
    const slow = deferred();
    mockGet.mockReturnValueOnce(slow.promise);
    useServerStore.getState().ensureMembers(['u-2']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(1);
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-3')] } });
    useServerStore.getState().ensureMembers(['u-3', 'u-2']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenLastCalledWith('/servers/srv-1/members/lookup', { params: { ids: 'u-3' } });
    slow.resolve({ data: { data: [row('u-2')] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(useServerStore.getState().members)).toEqual(['me', 'u-3', 'u-2']);
  });

  it('a page or a lookup never overwrites the status a presence event already moved (either ordering)', async () => {
    useServerStore.setState({ members: [row('me', { role: 'owner' }, { status: 'online' }), row('x', {}, { status: 'online' })], people: { full: false, truncated: false, onlineCount: 10, memberCount: 5000, loaded: true } });
    // the page was read while x was online; x goes offline before it lands
    const page = deferred();
    mockGet.mockReturnValueOnce(page.promise);
    const loading = useServerStore.getState().fetchDirectory('srv-1', { q: '', role: null });
    useServerStore.getState().updateMemberStatus('x', 'offline');
    expect(useServerStore.getState().people.onlineCount).toBe(9);
    page.resolve({ data: { data: [row('x', {}, { status: 'online' })], total: 5000, hasMore: false, nextCursor: null } });
    await loading;
    expect(useServerStore.getState().members.find((m) => m.userId === 'x')!.user.status).toBe('offline');
    useServerStore.getState().updateMemberStatus('x', 'online');
    expect(useServerStore.getState().people.onlineCount).toBe(10);
  });

  it('rows that land after a server switch are dropped', async () => {
    const pending = deferred();
    mockGet.mockReturnValueOnce(pending.promise);
    useServerStore.getState().ensureMembers(['u-2']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    resetMemberLookupState();
    retireDirectory();
    useServerStore.setState({ activeServerId: 'srv-2', members: [] });
    pending.resolve({ data: { data: [row('u-2')] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(useServerStore.getState().members).toEqual([]);
  });

  it('does nothing without an active server', () => {
    useServerStore.setState({ activeServerId: null });
    useServerStore.getState().ensureMembers(['u-2']);
    vi.advanceTimersByTime(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a lookup for someone the cut slice already counted does not count them twice', async () => {
    useServerStore.setState({ people: { full: false, truncated: true, onlineCount: 900, memberCount: 5000, loaded: true } });
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-2', {}, { status: 'online' })] } });
    useServerStore.getState().ensureMembers(['u-2']);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(useServerStore.getState().people.onlineCount).toBe(900);
  });
});

describe('serverStore — presence on the slice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetMemberLookupState();
    useServerStore.setState({
      activeServerId: 'srv-1',
      members: [row('me', { role: 'owner' }, { status: 'online' }), row('u-2', {}, { status: 'online' }), row('u-3')],
      people: { full: false, truncated: false, onlineCount: 2, memberCount: 5000, loaded: true },
      directory: { ...EMPTY_DIRECTORY, serverId: 'srv-1', rows: [row('u-2', {}, { status: 'online' })], total: 5000 },
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a known member going offline or online moves the row (in the directory too) and the count by one', () => {
    useServerStore.getState().updateMemberStatus('u-2', 'offline');
    expect(useServerStore.getState().members[1].user.status).toBe('offline');
    expect(useServerStore.getState().directory.rows[0].user.status).toBe('offline');
    expect(useServerStore.getState().people.onlineCount).toBe(1);
    useServerStore.getState().updateMemberStatus('u-3', 'idle');
    expect(useServerStore.getState().people.onlineCount).toBe(2);
    // idle → dnd is still online: no move
    useServerStore.getState().updateMemberStatus('u-3', 'dnd');
    expect(useServerStore.getState().people.onlineCount).toBe(2);
  });

  it('a presence event for a row the directory holds without a twin among the known rows still patches it', () => {
    useServerStore.setState({ directory: { ...useServerStore.getState().directory, rows: [row('only-dir', {}, { status: 'online' })] } });
    useServerStore.getState().updateMemberStatus('only-dir', 'offline');
    expect(useServerStore.getState().directory.rows[0].user.status).toBe('offline');
    expect(useServerStore.getState().people.onlineCount).toBe(2);
  });

  it('an unknown user coming online on a big server is looked up — and counted only once the server says they are a member', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-9', {}, { status: 'online' })] } });
    useServerStore.getState().updateMemberStatus('u-9', 'online');
    expect(useServerStore.getState().people.onlineCount).toBe(2);
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS);
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members/lookup', { params: { ids: 'u-9' } });
    expect(ids(useServerStore.getState().members)).toContain('u-9');
    expect(useServerStore.getState().people.onlineCount).toBe(3);
  });

  it('no lookup for an unknown user going offline, on a small server (everyone is loaded), on a cut slice, or before the slice loaded', async () => {
    useServerStore.getState().updateMemberStatus('u-9', 'offline');
    useServerStore.setState({ people: { full: true, truncated: false, onlineCount: 2, memberCount: 3, loaded: true } });
    useServerStore.getState().updateMemberStatus('u-9', 'online');
    useServerStore.setState({ people: { full: false, truncated: true, onlineCount: 900, memberCount: 5000, loaded: true } });
    useServerStore.getState().updateMemberStatus('u-9', 'online');
    useServerStore.setState({ people: EMPTY_PEOPLE });
    useServerStore.getState().updateMemberStatus('u-9', 'online');
    await vi.advanceTimersByTimeAsync(MEMBER_LOOKUP_DEBOUNCE_MS * 2);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('serverStore — joins and leaves move the rows and the figures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMemberLookupState();
    useServerStore.setState({
      activeServerId: 'srv-1',
      members: [row('me', { role: 'owner' }, { status: 'online' }), row('u-2', {}, { status: 'online' })],
      people: { full: true, truncated: false, onlineCount: 2, memberCount: 2, loaded: true },
      directory: { ...EMPTY_DIRECTORY, serverId: 'srv-1', rows: [row('me', { role: 'owner' }), row('u-2')], total: 2 },
    });
  });

  it('member:joined adds the row, counts them (online or not) and appends to a complete, unfiltered directory', () => {
    useServerStore.getState().addMember('srv-1', joiner('u-3', 'offline'));
    const state = useServerStore.getState();
    expect(ids(state.members)).toEqual(['me', 'u-2', 'u-3']);
    expect(state.people).toMatchObject({ memberCount: 3, onlineCount: 2 });
    expect(ids(state.directory.rows)).toEqual(['me', 'u-2', 'u-3']);
    expect(state.directory.total).toBe(3);
    // a repeat of the event changes nothing
    useServerStore.getState().addMember('srv-1', joiner('u-3', 'offline'));
    expect(useServerStore.getState().people.memberCount).toBe(3);
    // another server's join is not ours
    useServerStore.getState().addMember('srv-2', joiner('u-4'));
    expect(useServerStore.getState().people.memberCount).toBe(3);
  });

  it('member:joined on a directory that has more pages, or a filtered one, moves only what it can', () => {
    useServerStore.setState({ directory: { ...useServerStore.getState().directory, hasMore: true, nextCursor: 'c' } });
    useServerStore.getState().addMember('srv-1', joiner('u-3'));
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['me', 'u-2']);
    expect(useServerStore.getState().directory.total).toBe(3);
    useServerStore.setState({ directory: { ...useServerStore.getState().directory, hasMore: false, q: 'al' } });
    useServerStore.getState().addMember('srv-1', joiner('u-4'));
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['me', 'u-2']);
    expect(useServerStore.getState().directory.total).toBe(3);
  });

  it('member:left drops the row from both lists and the figures; an unknown leaver still counts', () => {
    useServerStore.getState().removeMember('srv-1', 'u-2');
    let state = useServerStore.getState();
    expect(ids(state.members)).toEqual(['me']);
    expect(ids(state.directory.rows)).toEqual(['me']);
    expect(state.people).toMatchObject({ memberCount: 1, onlineCount: 1 });
    expect(state.directory.total).toBe(1);
    useServerStore.getState().removeMember('srv-1', 'u-unknown');
    state = useServerStore.getState();
    expect(state.people).toMatchObject({ memberCount: 0, onlineCount: 1 });
    expect(state.directory.total).toBe(0);
  });

  it('role, roles, nickname and profile changes land in both lists; a deleted role leaves both', () => {
    const store = useServerStore.getState();
    useServerStore.setState({ roles: [{ id: 'r-1', serverId: 'srv-1', name: 'Mod', color: '#f00', position: 1, permissions: '0', isDefault: false, createdAt: '' }] });
    store.handleMemberRoleUpdated('srv-1', 'u-2', 'admin');
    store.handleMemberRolesUpdated('srv-1', 'u-2', ['r-1']);
    store.handleNicknameUpdated('srv-1', 'u-2', 'Deuce');
    store.updateMemberProfile('u-2', { displayName: 'Two' });
    store.updateMemberAvatar('u-2', 'avatars/u-2.webp');
    for (const list of [useServerStore.getState().members, useServerStore.getState().directory.rows]) {
      const m = list.find((x) => x.userId === 'u-2')!;
      expect(m).toMatchObject({ role: 'admin', nickname: 'Deuce' });
      expect(m.roles?.map((r) => r.id)).toEqual(['r-1']);
      expect(m.user).toMatchObject({ displayName: 'Two', avatarUrl: 'avatars/u-2.webp' });
    }
    store.handleRoleDeleted('srv-1', 'r-1');
    expect(useServerStore.getState().members[1].roles).toEqual([]);
    expect(useServerStore.getState().directory.rows[1].roles).toEqual([]);
    // untouched rows keep their identity (no needless re-renders)
    expect(useServerStore.getState().members[0]).toBe(useServerStore.getState().members[0]);
  });

  it('being kicked from, or losing, the active server clears the rows, the figures and that server\'s directory', () => {
    useServerStore.getState().handleMemberKicked('srv-1');
    let state = useServerStore.getState();
    expect(state.members).toEqual([]);
    expect(state.people).toEqual(EMPTY_PEOPLE);
    expect(state.directory).toEqual(EMPTY_DIRECTORY);

    useServerStore.setState({ activeServerId: 'srv-1', members: [row('me')], people: { ...EMPTY_PEOPLE, loaded: true }, directory: { ...EMPTY_DIRECTORY, serverId: 'srv-1' } });
    useServerStore.getState().handleServerDeleted('srv-1');
    state = useServerStore.getState();
    expect(state.members).toEqual([]);
    expect(state.people).toEqual(EMPTY_PEOPLE);
    expect(state.directory).toEqual(EMPTY_DIRECTORY);
  });
});

describe('serverStore — the member directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMemberLookupState();
    useServerStore.setState({ activeServerId: 'srv-1', members: [row('me', { role: 'owner' }, { status: 'online' })], people: { full: false, truncated: false, onlineCount: 1, memberCount: 300, loaded: true }, directory: EMPTY_DIRECTORY });
  });

  it('fetchDirectory loads the first page for a filter (the params it sends), remembers whose list it is and merges the rows into the known rows', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [row('me', { role: 'owner' }), row('u-2')], total: 300, hasMore: true, nextCursor: 'cur-1' } });
    await useServerStore.getState().fetchDirectory('srv-1', { q: 'al', role: 'owner' });
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE, q: 'al', role: 'owner' } });
    const d = useServerStore.getState().directory;
    expect(d).toMatchObject({ serverId: 'srv-1', total: 300, hasMore: true, nextCursor: 'cur-1', q: 'al', role: 'owner', loading: false, error: false });
    expect(ids(d.rows)).toEqual(['me', 'u-2']);
    expect(ids(useServerStore.getState().members)).toEqual(['me', 'u-2']);
  });

  it('an unfiltered fetch sends no q or role', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [], total: 0, hasMore: false, nextCursor: null } });
    await useServerStore.getState().fetchDirectory('srv-1', { q: '', role: null });
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE } });
  });

  it('fetchDirectoryMore follows the cursor with the same filter, appends without repeats, and is a no-op while loading or at the end', async () => {
    useServerStore.setState({ directory: { ...EMPTY_DIRECTORY, serverId: 'srv-1', rows: [row('u-2')], total: 300, hasMore: true, nextCursor: 'cur-1', q: 'al', role: null } });
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-2'), row('u-3')], total: 300, hasMore: false, nextCursor: null } });
    await useServerStore.getState().fetchDirectoryMore('srv-1');
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/members', { params: { limit: LIMITS.MEMBERS_PER_PAGE, cursor: 'cur-1', q: 'al' } });
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['u-2', 'u-3']);
    expect(useServerStore.getState().directory.hasMore).toBe(false);
    await useServerStore.getState().fetchDirectoryMore('srv-1');
    await useServerStore.getState().fetchDirectoryMore('srv-9');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('a slower first page is dropped when a newer one was asked for (typing), and a "more" page that outlived a new first page too', async () => {
    const slow = deferred();
    const fast = deferred();
    mockGet.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const first = useServerStore.getState().fetchDirectory('srv-1', { q: 'a', role: null });
    const second = useServerStore.getState().fetchDirectory('srv-1', { q: 'al', role: null });
    fast.resolve({ data: { data: [row('u-2')], total: 1, hasMore: true, nextCursor: 'cur-al' } });
    await second;
    slow.resolve({ data: { data: [row('u-7'), row('u-8')], total: 2, hasMore: true, nextCursor: 'x' } });
    await first;
    expect(useServerStore.getState().directory).toMatchObject({ q: 'al', total: 1, hasMore: true });
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['u-2']);

    // Load more for "al" is in flight when the user types "ali": the more-page lands and is dropped
    const more = deferred();
    const third = deferred();
    mockGet.mockReturnValueOnce(more.promise).mockReturnValueOnce(third.promise);
    const moreLoading = useServerStore.getState().fetchDirectoryMore('srv-1');
    const thirdLoading = useServerStore.getState().fetchDirectory('srv-1', { q: 'ali', role: null });
    third.resolve({ data: { data: [row('u-9')], total: 1, hasMore: false, nextCursor: null } });
    await thirdLoading;
    more.resolve({ data: { data: [row('u-3')], total: 1, hasMore: false, nextCursor: null } });
    await moreLoading;
    expect(useServerStore.getState().directory).toMatchObject({ q: 'ali', loading: false, hasMore: false });
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['u-9']);
  });

  it('a slice refetch for the same server (reconnect, tab return) leaves a directory page in flight alone: it lands, loading clears, the next page can follow', async () => {
    const page = deferred();
    const slice = deferred();
    mockGet.mockReturnValueOnce(page.promise).mockReturnValueOnce(slice.promise);
    const pageLoading = useServerStore.getState().fetchDirectory('srv-1', { q: '', role: null });
    const sliceLoading = useServerStore.getState().fetchPeople('srv-1');
    slice.resolve({ data: { data: [row('me', { role: 'owner' }, { status: 'online' })], full: false, truncated: false, onlineCount: 1, memberCount: 300 } });
    await sliceLoading;
    page.resolve({ data: { data: [row('me', { role: 'owner' }), row('u-2')], total: 300, hasMore: true, nextCursor: 'cur-1' } });
    await pageLoading;
    expect(useServerStore.getState().directory).toMatchObject({ serverId: 'srv-1', loading: false, hasMore: true, nextCursor: 'cur-1' });
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['me', 'u-2']);
    mockGet.mockResolvedValueOnce({ data: { data: [row('u-3')], total: 300, hasMore: false, nextCursor: null } });
    await useServerStore.getState().fetchDirectoryMore('srv-1');
    expect(ids(useServerStore.getState().directory.rows)).toEqual(['me', 'u-2', 'u-3']);
  });

  it('a failed page marks the error, clears loading and rethrows so the section can toast', async () => {
    mockGet.mockRejectedValueOnce(new Error('500'));
    await expect(useServerStore.getState().fetchDirectory('srv-1', { q: '', role: null })).rejects.toThrow('500');
    expect(useServerStore.getState().directory).toMatchObject({ serverId: 'srv-1', loading: false, error: true, rows: [] });
  });
});

describe('serverStore — pinned spaces', () => {
  beforeEach(() => {
    localStorage.clear();
    useServerStore.setState({ pinnedServerIds: [] });
  });

  it('toggles a pin on and off, preserving pin order', () => {
    const { togglePinServer } = useServerStore.getState();
    togglePinServer('s-b');
    togglePinServer('s-a');
    expect(useServerStore.getState().pinnedServerIds).toEqual(['s-b', 's-a']);

    togglePinServer('s-b');
    expect(useServerStore.getState().pinnedServerIds).toEqual(['s-a']);
  });

  it('persists pins to localStorage so they survive a restart', () => {
    useServerStore.getState().togglePinServer('s-x');
    expect(JSON.parse(localStorage.getItem('voxium_pinned_spaces')!)).toEqual(['s-x']);
  });
});

// ─── Secure channels ────────────────────────────────────────────────────────

describe('secure channels', () => {
  const mockDelete = api.delete as unknown as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({ secureChannelMembers: {} });
  });

  it('createSecureChannel POSTs name + memberIds and does NOT touch local channel state', async () => {
    mockPost.mockResolvedValue({ data: { data: { id: 'sec-1', name: 'covert', secure: true } } });
    const before = useServerStore.getState().channels;

    const channel = await useServerStore.getState().createSecureChannel('srv-1', 'covert', ['u2', 'u3']);

    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/secure-channels', {
      name: 'covert',
      memberIds: ['u2', 'u3'],
      type: 'text',
    });
    expect(channel.id).toBe('sec-1');
    // Socket event is the sole source of truth for the sidebar
    expect(useServerStore.getState().channels).toBe(before);
  });

  it('member management hits the secure-channels endpoints', async () => {
    mockPost.mockResolvedValue({ data: { data: {} } });
    mockDelete.mockResolvedValue({ data: { data: {} } });

    await useServerStore.getState().inviteSecureChannelMember('srv-1', 'sec-1', 'u9');
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/secure-channels/sec-1/members', { userId: 'u9' });

    await useServerStore.getState().removeSecureChannelMember('srv-1', 'sec-1', 'u9');
    expect(mockDelete).toHaveBeenCalledWith('/servers/srv-1/secure-channels/sec-1/members/u9');
  });

  it('leaveSecureChannel removes self and drops the cached member list', async () => {
    mockDelete.mockResolvedValue({ data: { data: {} } });
    useServerStore.setState({
      secureChannelMembers: { 'sec-1': [{ userId: 'me', isCreator: false, addedAt: '', user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } }] },
    });

    await useServerStore.getState().leaveSecureChannel('srv-1', 'sec-1', 'me');

    expect(mockDelete).toHaveBeenCalledWith('/servers/srv-1/secure-channels/sec-1/members/me');
    expect(useServerStore.getState().secureChannelMembers['sec-1']).toBeUndefined();
  });

  it('fetchSecureChannelCount reads the opaque moderation count', async () => {
    mockGet.mockResolvedValue({ data: { data: { count: 3 } } });

    const count = await useServerStore.getState().fetchSecureChannelCount('srv-1');

    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/secure-channels/count');
    expect(count).toBe(3);
  });

  it('handleChannelMembersUpdated validates the payload shape at runtime', () => {
    const { handleChannelMembersUpdated } = useServerStore.getState();

    // Garbage payloads change nothing
    handleChannelMembersUpdated({ channelId: 42, serverId: 'srv-1', members: [] });
    handleChannelMembersUpdated({ channelId: 'sec-1', serverId: 'srv-1', members: 'not-an-array' });
    expect(useServerStore.getState().secureChannelMembers).toEqual({});

    // Valid rows land; malformed rows inside the array are dropped
    handleChannelMembersUpdated({
      channelId: 'sec-1',
      serverId: 'srv-1',
      members: [
        { userId: 'u1', isCreator: true, addedAt: '2026-08-12', user: { id: 'u1', username: 'a', displayName: 'A', avatarUrl: null } },
        { bogus: true },
        null,
      ],
    });
    const list = useServerStore.getState().secureChannelMembers['sec-1'];
    expect(list).toHaveLength(1);
    expect(list[0].userId).toBe('u1');
  });
});


// ─── Server discovery — the owner side ──────────────────────────────────────

import type { ServerJoinRequest, ServerBan } from '@voxium/shared';

const mockPatch = api.patch as unknown as Mock;
const mockDelete = api.delete as unknown as Mock;

const bob = { id: 'u-2', username: 'bob', displayName: 'Bob', avatarUrl: null };
const req = (userId: string, id = `r-${userId}`): ServerJoinRequest =>
  ({ id, serverId: 'srv-1', userId, message: null, status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: { ...bob, id: userId } });

describe('serverStore — discovery, join requests and bans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({ joinRequestCounts: {}, joinRequests: [], joinRequestsServerId: null, bans: [], bansServerId: null });
  });

  it('updateDiscovery PATCHes the fields and touches no local state (server:updated is the source of truth)', async () => {
    mockPatch.mockResolvedValue({ data: { data: {} } });
    useServerStore.setState({ servers: [{ id: 'srv-1', name: 'S', joinMode: 'approval', discoverable: true } as never] });
    await useServerStore.getState().updateDiscovery('srv-1', { joinMode: 'open', tags: ['gaming'] });
    expect(mockPatch).toHaveBeenCalledWith('/servers/srv-1/discovery', { joinMode: 'open', tags: ['gaming'] });
    expect((useServerStore.getState().servers[0] as { joinMode: string }).joinMode).toBe('approval');
  });

  it('fetchDiscoveryInfo reads the owner endpoint and picks its fields with safe defaults', async () => {
    mockGet.mockResolvedValue({ data: { data: { id: 'srv-1', memberCount: 12, onlineCount: 3, weeklyMessages: 40, statsRefreshedAt: '2026-10-09T04:00:00.000Z', discoveryListed: true, discoveryBlockedAt: null, featuredAt: null, activityScore: 84, tier: 'gold', nextTier: { tier: 'platinum', score: 120 }, tiersAvailable: true, tierThresholds: { bronze: 2, silver: 3, gold: 3, platinum: 5, diamond: 5 } } } });
    await expect(useServerStore.getState().fetchDiscoveryInfo('srv-1')).resolves.toEqual({
      memberCount: 12, onlineCount: 3, weeklyMessages: 40, statsRefreshedAt: '2026-10-09T04:00:00.000Z', discoveryListed: true, discoveryBlockedAt: null, featuredAt: null,
      activityScore: 84, tier: 'gold', nextTier: { tier: 'platinum', score: 120 }, tiersAvailable: true,
      tierThresholds: { bronze: 2, silver: 3, gold: 3, platinum: 5, diamond: 5 },
    });
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/discovery');
    mockGet.mockResolvedValue({ data: { data: { id: 'srv-1' } } });
    await expect(useServerStore.getState().fetchDiscoveryInfo('srv-1')).resolves.toEqual({
      memberCount: 0, onlineCount: 0, weeklyMessages: 0, statsRefreshedAt: null, discoveryListed: true, discoveryBlockedAt: null, featuredAt: null,
      activityScore: 0, tier: null, nextTier: null, tiersAvailable: false, tierThresholds: null,
    });
    // a tier the client does not know, or a malformed next tier, is dropped — never rendered
    mockGet.mockResolvedValue({ data: { data: { id: 'srv-1', tier: 'mythic', nextTier: { tier: 'gold' }, tiersAvailable: 'yes', tierThresholds: { bronze: 1 } } } });
    await expect(useServerStore.getState().fetchDiscoveryInfo('srv-1')).resolves.toMatchObject({ tier: null, nextTier: null, tiersAvailable: false, tierThresholds: null });
  });

  it('fetchJoinRequests loads the list, remembers whose it is, and sets the badge from the total', async () => {
    mockGet.mockResolvedValue({ data: { data: [req('u-2')], total: 7, hasMore: false } });
    await useServerStore.getState().fetchJoinRequests('srv-1');
    const s = useServerStore.getState();
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/join-requests', { params: { page: 1 } });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(s.joinRequests).toHaveLength(1);
    expect(s.joinRequestsServerId).toBe('srv-1');
    expect(s.joinRequestCounts).toEqual({ 'srv-1': 7 });
  });

  it('fetchJoinRequests follows hasMore through the pages, and stops at the page cap', async () => {
    const pageOf = (opts?: { params?: { page?: number } }) => opts?.params?.page ?? 1;
    mockGet.mockImplementation((_url: string, opts?: { params?: { page?: number } }) =>
      Promise.resolve({ data: { data: [req(`u-${pageOf(opts)}`)], total: 3, hasMore: pageOf(opts) < 3 } }));
    await useServerStore.getState().fetchJoinRequests('srv-1');
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet).toHaveBeenLastCalledWith('/servers/srv-1/join-requests', { params: { page: 3 } });
    expect(useServerStore.getState().joinRequests.map((r) => r.userId)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 3 });

    // a server that always answers "more" is cut off at the cap, never looped
    mockGet.mockClear();
    mockGet.mockImplementation((_url: string, opts?: { params?: { page?: number } }) =>
      Promise.resolve({ data: { data: [req(`u-${pageOf(opts)}`)], total: 5000, hasMore: true } }));
    await useServerStore.getState().fetchJoinRequests('srv-1');
    expect(mockGet).toHaveBeenCalledTimes(10);
    expect(useServerStore.getState().joinRequests).toHaveLength(10);
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 5000 }); // the badge says the truth
  });

  it('a fetch that resolves after another server was asked for is dropped — the list belongs to the LAST server', async () => {
    const slow = deferred();
    const fast = deferred();
    mockGet.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const p1 = useServerStore.getState().fetchJoinRequests('srv-1');
    const p2 = useServerStore.getState().fetchJoinRequests('srv-2');
    // claimed at once, so a section opening for srv-2 never shows srv-1's rows
    expect(useServerStore.getState().joinRequestsServerId).toBe('srv-2');
    expect(useServerStore.getState().joinRequests).toEqual([]);
    fast.resolve({ data: { data: [{ ...req('u-9'), serverId: 'srv-2' }], total: 1, hasMore: false } });
    await p2;
    slow.resolve({ data: { data: [req('u-2')], total: 1, hasMore: false } });
    await p1;
    const s = useServerStore.getState();
    expect(s.joinRequestsServerId).toBe('srv-2');
    expect(s.joinRequests.map((r) => r.userId)).toEqual(['u-9']);
    expect(s.joinRequestCounts).toEqual({ 'srv-2': 1 });
  });

  it('handleJoinRequest drops a malformed payload (socket JSON is untrusted) and one whose serverId disagrees', () => {
    useServerStore.setState({ joinRequests: [], joinRequestsServerId: 'srv-1' });
    useServerStore.getState().handleJoinRequest('srv-1', { id: 'r-x' });
    useServerStore.getState().handleJoinRequest('srv-1', { ...req('u-2'), user: { id: 'u-2' } });
    useServerStore.getState().handleJoinRequest('srv-1', { ...req('u-2'), createdAt: 123 });
    useServerStore.getState().handleJoinRequest(42, req('u-2'));
    useServerStore.getState().handleJoinRequest('srv-2', req('u-2')); // the row says srv-1
    useServerStore.getState().handleJoinRequestResolved(undefined, 'u-2');
    useServerStore.getState().handleJoinRequestResolved('srv-1', { userId: 'u-2' });
    expect(useServerStore.getState().joinRequests).toEqual([]);
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
    // and a well-formed one is still taken
    useServerStore.getState().handleJoinRequest('srv-1', req('u-2'));
    expect(useServerStore.getState().joinRequests).toHaveLength(1);
  });

  it('handleJoinRequest appends to the loaded list once and bumps the badge; another server only bumps its badge', () => {
    useServerStore.setState({ joinRequests: [], joinRequestsServerId: 'srv-1' });
    useServerStore.getState().handleJoinRequest('srv-1', req('u-2'));
    useServerStore.getState().handleJoinRequest('srv-1', req('u-2')); // socket replay
    useServerStore.getState().handleJoinRequest('srv-9', { ...req('u-5'), serverId: 'srv-9' });
    const s = useServerStore.getState();
    expect(s.joinRequests.map((r) => r.userId)).toEqual(['u-2']);
    expect(s.joinRequestCounts).toEqual({ 'srv-1': 1, 'srv-9': 1 });
  });

  it('our own approve drops the row and the badge ONCE — the socket echo of it does not count twice', async () => {
    mockPost.mockResolvedValue({ data: {} });
    useServerStore.setState({ joinRequests: [req('u-2'), req('u-3')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 2 } });
    await useServerStore.getState().approveJoinRequest('srv-1', 'u-2');
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/join-requests/u-2/approve');
    expect(useServerStore.getState().joinRequests.map((r) => r.userId)).toEqual(['u-3']);
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1 });
    // the resolved event for the same user arrives next
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-2');
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1 });
    // decline the other one: the badge key disappears at zero
    await useServerStore.getState().declineJoinRequest('srv-1', 'u-3');
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/join-requests/u-3/decline');
    expect(useServerStore.getState().joinRequests).toEqual([]);
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
  });

  it('with no list loaded for that server, a resolved event moves the badge alone (and never below zero)', () => {
    useServerStore.setState({ joinRequestCounts: { 'srv-1': 1 }, joinRequestsServerId: 'srv-9', joinRequests: [] });
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-2');
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-2');
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
  });

  it('a failed approve leaves the list and the badge alone', async () => {
    mockPost.mockRejectedValue(new Error('Join request not found'));
    useServerStore.setState({ joinRequests: [req('u-2')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 1 } });
    await expect(useServerStore.getState().approveJoinRequest('srv-1', 'u-2')).rejects.toThrow();
    expect(useServerStore.getState().joinRequests).toHaveLength(1);
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1 });
  });

  it('a 404 on approve / decline / unban means the row is already gone (no event carries that): drop it locally, still rethrow', async () => {
    const gone = Object.assign(new Error('Request failed'), { isAxiosError: true, config: {}, toJSON: () => ({}), response: { status: 404, data: { error: 'Join request not found' } } });
    mockPost.mockRejectedValue(gone);
    useServerStore.setState({ joinRequests: [req('u-2')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 1 } });
    await expect(useServerStore.getState().approveJoinRequest('srv-1', 'u-2')).rejects.toThrow();
    expect(useServerStore.getState().joinRequests).toEqual([]);
    expect(useServerStore.getState().joinRequestCounts).toEqual({});

    useServerStore.setState({ joinRequests: [req('u-3')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 1 } });
    await expect(useServerStore.getState().declineJoinRequest('srv-1', 'u-3')).rejects.toThrow();
    expect(useServerStore.getState().joinRequests).toEqual([]);

    const ban: ServerBan = { serverId: 'srv-1', userId: 'u-4', reason: null, createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: null };
    useServerStore.setState({ bans: [ban], bansServerId: 'srv-1' });
    mockDelete.mockRejectedValue(gone);
    await expect(useServerStore.getState().unbanMember('srv-1', 'u-4')).rejects.toThrow();
    expect(useServerStore.getState().bans).toEqual([]);
    // any other failure keeps the rows
    mockDelete.mockRejectedValue(new Error('500'));
    useServerStore.setState({ bans: [ban], bansServerId: 'srv-1' });
    await expect(useServerStore.getState().unbanMember('srv-1', 'u-4')).rejects.toThrow();
    expect(useServerStore.getState().bans).toEqual([ban]);
  });

  it('with the list cut at the page cap, a resolution outside the loaded rows still moves the badge; the echo of our own action still does not', async () => {
    useServerStore.setState({ joinRequests: [req('u-2')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 1500 }, joinRequestsTruncated: true });
    // another moderator resolves someone we never loaded
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-999');
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1499 });
    expect(useServerStore.getState().joinRequests).toHaveLength(1);
    // our own approve of a loaded row: once on the action, not again on the echo
    mockPost.mockResolvedValue({ data: {} });
    await useServerStore.getState().approveJoinRequest('srv-1', 'u-2');
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1498 });
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-2');
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1498 });
    // a complete list that never had the user: a stale event, nothing moves
    useServerStore.setState({ joinRequestsTruncated: false });
    useServerStore.getState().handleJoinRequestResolved('srv-1', 'u-998');
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1498 });
  });

  it('fetchJoinRequests records whether the loaded rows stop short of the total', async () => {
    mockGet.mockResolvedValue({ data: { data: [req('u-2')], total: 40, hasMore: false } });
    await useServerStore.getState().fetchJoinRequests('srv-1');
    expect(useServerStore.getState().joinRequestsTruncated).toBe(true);
    mockGet.mockResolvedValue({ data: { data: [req('u-2')], total: 1, hasMore: false } });
    await useServerStore.getState().fetchJoinRequests('srv-1');
    expect(useServerStore.getState().joinRequestsTruncated).toBe(false);
  });

  it('fetchBans loads the list (scoped to its server); unbanMember DELETEs and drops the row locally (no socket event carries bans)', async () => {
    const ban: ServerBan = { serverId: 'srv-1', userId: 'u-2', reason: 'spam', createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: null };
    mockGet.mockResolvedValue({ data: { data: [ban], total: 1, hasMore: false } });
    await useServerStore.getState().fetchBans('srv-1');
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/bans', { params: { page: 1 } });
    expect(useServerStore.getState().bans).toEqual([ban]);
    expect(useServerStore.getState().bansServerId).toBe('srv-1');
    mockDelete.mockResolvedValue({ data: {} });
    await useServerStore.getState().unbanMember('srv-1', 'u-2');
    expect(mockDelete).toHaveBeenCalledWith('/servers/srv-1/bans/u-2');
    expect(useServerStore.getState().bans).toEqual([]);

    // a fetch for another server replaces the list and its owner at once
    const other: ServerBan = { ...ban, serverId: 'srv-2', userId: 'u-5' };
    mockGet.mockResolvedValue({ data: { data: [other], total: 1, hasMore: false } });
    await useServerStore.getState().fetchBans('srv-2');
    expect(useServerStore.getState().bansServerId).toBe('srv-2');
    expect(useServerStore.getState().bans).toEqual([other]);
    // an unban on a server whose list is not the loaded one touches nothing
    await useServerStore.getState().unbanMember('srv-1', 'u-5');
    expect(useServerStore.getState().bans).toEqual([other]);
  });

  it('a bans fetch that resolves after another server was asked for is dropped', async () => {
    const slow = deferred();
    const fast = deferred();
    mockGet.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const p1 = useServerStore.getState().fetchBans('srv-1');
    const p2 = useServerStore.getState().fetchBans('srv-2');
    fast.resolve({ data: { data: [{ serverId: 'srv-2', userId: 'u-5', reason: null, createdAt: 'x', user: bob, bannedBy: null }], total: 1, hasMore: false } });
    await p2;
    slow.resolve({ data: { data: [{ serverId: 'srv-1', userId: 'u-2', reason: null, createdAt: 'x', user: bob, bannedBy: null }], total: 1, hasMore: false } });
    await p1;
    expect(useServerStore.getState().bansServerId).toBe('srv-2');
    expect(useServerStore.getState().bans.map((b) => b.userId)).toEqual(['u-5']);
  });

  it('kickMember sends the reason when given and an empty body otherwise, and refreshes the banned list only while it is open for THAT server', async () => {
    mockPost.mockResolvedValue({ data: {} });
    await useServerStore.getState().kickMember('srv-1', 'u-2', 'spam');
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/members/u-2/kick', { reason: 'spam' });
    await useServerStore.getState().kickMember('srv-1', 'u-2');
    expect(mockPost).toHaveBeenLastCalledWith('/servers/srv-1/members/u-2/kick', {});
    expect(mockGet).not.toHaveBeenCalled(); // no Banned section open: nothing to refresh

    useServerStore.setState({ bans: [], bansServerId: 'srv-9' });
    await useServerStore.getState().kickMember('srv-1', 'u-2');
    expect(mockGet).not.toHaveBeenCalled(); // open for another server: still nothing

    const ban: ServerBan = { serverId: 'srv-1', userId: 'u-2', reason: null, createdAt: '2026-10-09T10:00:00.000Z', user: bob, bannedBy: null };
    useServerStore.setState({ bans: [], bansServerId: 'srv-1' });
    mockGet.mockResolvedValue({ data: { data: [ban], total: 1, hasMore: false } });
    await useServerStore.getState().kickMember('srv-1', 'u-2');
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/bans', { params: { page: 1 } });
    expect(useServerStore.getState().bans).toEqual([ban]);

    // a failed refresh is logged, not thrown — the removal itself succeeded
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error('boom'));
    await expect(useServerStore.getState().kickMember('srv-1', 'u-3')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
