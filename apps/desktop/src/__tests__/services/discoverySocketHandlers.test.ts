import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiscoveryServer, ServerJoinRequest } from '@voxium/shared';

/**
 * The four server-discovery socket events as MainLayout registers them.
 * Real stores, mocked API/toast/i18n: what matters is which store moves,
 * by how much, and what the user is told.
 */

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
const T = vi.hoisted(() => ({
  success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(),
}));
vi.mock('../../stores/toastStore', () => ({ toast: T }));
vi.mock('../../i18n', () => ({
  default: { t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${Object.values(o).join('|')}` : k) },
}));

import { discoverySocketHandlers as H } from '../../services/discoverySocketHandlers';
import { useServerStore } from '../../stores/serverStore';
import { useDiscoveryStore } from '../../stores/discoveryStore';

const server = { id: 'srv-1', name: 'Makhtofi Raiders', iconUrl: null, invitesLocked: false, ownerId: 'o', createdAt: '2026-01-01T00:00:00.000Z' };
const card = (id: string, extra: Partial<DiscoveryServer> = {}): DiscoveryServer => ({
  id, name: `Space ${id}`, iconUrl: null, description: null, tags: [], memberCount: 1, onlineCount: 0, weeklyMessages: 0,
  joinMode: 'approval', featured: false, isMember: false, requestPending: true, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null,
  ...extra,
});
const bob = { id: 'u-2', username: 'bob', displayName: 'Bob', avatarUrl: null };
const request = (serverId: string, userId = 'u-2'): ServerJoinRequest =>
  ({ id: `r-${serverId}-${userId}`, serverId, userId, message: 'hi', status: 'pending', createdAt: '2026-10-09T10:00:00.000Z', user: { ...bob, id: userId } });

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({ servers: [], joinRequestCounts: {}, joinRequests: [], joinRequestsServerId: null });
  useDiscoveryStore.setState({ servers: [card('srv-1'), card('srv-2')], featured: [], status: 'ready' });
});

describe('server:join_approved', () => {
  it('appends the server to the strip once, flips the card to Open, and toasts the welcome', () => {
    H.joinApproved({ server });
    expect(useServerStore.getState().servers.map((s) => s.id)).toEqual(['srv-1']);
    expect(useDiscoveryStore.getState().servers[0]).toMatchObject({ isMember: true, requestPending: false });
    expect(T.success).toHaveBeenCalledWith('discovery.toasts.approved:Makhtofi Raiders');
    H.joinApproved({ server });
    expect(useServerStore.getState().servers).toHaveLength(1);
  });

  it('drops a payload without a server shape', () => {
    H.joinApproved({ server: { id: 'x' } });
    H.joinApproved(null);
    H.joinApproved('srv-1');
    expect(useServerStore.getState().servers).toEqual([]);
    expect(T.success).not.toHaveBeenCalled();
  });
});

describe('server:join_declined', () => {
  it('clears the pending mark and toasts the server name (or a generic one)', () => {
    H.joinDeclined({ serverId: 'srv-2', serverName: 'Lingua Lounge' });
    expect(useDiscoveryStore.getState().servers[1]).toMatchObject({ isMember: false, requestPending: false });
    expect(T.info).toHaveBeenCalledWith('discovery.toasts.declined:Lingua Lounge');
    H.joinDeclined({ serverId: 'srv-1' });
    expect(T.info).toHaveBeenLastCalledWith('discovery.toasts.declined:discovery.toasts.unknownSpace');
    H.joinDeclined({ serverName: 'no id' });
    expect(T.info).toHaveBeenCalledTimes(2);
  });
});

describe('server:join_request', () => {
  it('bumps only that server\'s badge, appends to a loaded list, and toasts requester + space once', () => {
    useServerStore.setState({ servers: [server as never], joinRequests: [], joinRequestsServerId: 'srv-1' });
    H.joinRequest({ serverId: 'srv-1', request: request('srv-1') });
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1 });
    expect(useServerStore.getState().joinRequests).toHaveLength(1);
    expect(T.info).toHaveBeenCalledWith('discovery.toasts.newRequest:Bob|Makhtofi Raiders');
    // the socket replays it: nothing moves, nothing toasts
    H.joinRequest({ serverId: 'srv-1', request: request('srv-1') });
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1 });
    expect(T.info).toHaveBeenCalledTimes(1);
    // a server we moderate but have not loaded the list for: badge only, generic name
    H.joinRequest({ serverId: 'srv-9', request: request('srv-9', 'u-5') });
    expect(useServerStore.getState().joinRequestCounts).toEqual({ 'srv-1': 1, 'srv-9': 1 });
    expect(useServerStore.getState().joinRequests).toHaveLength(1);
    expect(T.info).toHaveBeenLastCalledWith('discovery.toasts.newRequest:Bob|discovery.toasts.unknownSpace');
  });

  it('drops a malformed payload or one whose row disagrees with the event', () => {
    H.joinRequest({ serverId: 'srv-1', request: { id: 'r' } });
    H.joinRequest({ serverId: 'srv-1', request: request('srv-2') });
    H.joinRequest({ request: request('srv-1') });
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
    expect(T.info).not.toHaveBeenCalled();
  });
});

describe('server:join_request_resolved', () => {
  it('drops the row and moves the badge for every outcome; ignores junk', () => {
    useServerStore.setState({ joinRequests: [request('srv-1'), request('srv-1', 'u-3')], joinRequestsServerId: 'srv-1', joinRequestCounts: { 'srv-1': 2 } });
    H.joinRequestResolved({ serverId: 'srv-1', userId: 'u-2', outcome: 'approved' });
    H.joinRequestResolved({ serverId: 'srv-1', userId: 'u-3', outcome: 'joined' });
    expect(useServerStore.getState().joinRequests).toEqual([]);
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
    H.joinRequestResolved({ serverId: 'srv-1' });
    H.joinRequestResolved(undefined);
    expect(useServerStore.getState().joinRequestCounts).toEqual({});
  });
});
