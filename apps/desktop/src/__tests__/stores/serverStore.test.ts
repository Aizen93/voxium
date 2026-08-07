import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { useServerStore } from '../../stores/serverStore';
import { api } from '../../services/api';
import type { Channel, ServerMember } from '@voxium/shared';

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
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      channels: [],
      categories: [],
      activeChannelId: null,
      members: [],
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

  describe('fetchMembers race', () => {
    it('discards a slow members response for a server no longer being viewed', async () => {
      useServerStore.setState({ activeServerId: 'srv-A', members: [staleMember] });

      const pending = deferred();
      mockGet.mockReturnValueOnce(pending.promise);

      const fetchPromise = useServerStore.getState().fetchMembers('srv-A');

      // User switches servers while srv-A's members request is in flight
      useServerStore.setState({ activeServerId: 'srv-B' });

      pending.resolve({
        data: { data: [{ userId: 'u-A', serverId: 'srv-A', role: 'member', user: { id: 'u-A', username: 'a' } }] },
      });
      await fetchPromise;

      expect(useServerStore.getState().members).toEqual([staleMember]);
    });

    it('control: applies the members response when the server is still active', async () => {
      useServerStore.setState({ activeServerId: 'srv-D' });

      const freshMembers = [{ userId: 'u-D', serverId: 'srv-D', role: 'member', user: { id: 'u-D', username: 'd' } }];
      mockGet.mockResolvedValueOnce({ data: { data: freshMembers } });

      await useServerStore.getState().fetchMembers('srv-D');

      expect(useServerStore.getState().members).toEqual(freshMembers);
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
        if (url === '/servers/srv-C/members') {
          return Promise.resolve({ data: { data: [memberC] } });
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
