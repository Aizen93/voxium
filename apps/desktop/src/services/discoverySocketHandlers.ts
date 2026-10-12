import type { Server } from '@voxium/shared';
import i18n from '../i18n';
import { useServerStore, isServerJoinRequest } from '../stores/serverStore';
import { useDiscoveryStore } from '../stores/discoveryStore';
import { toast } from '../stores/toastStore';

/**
 * The four server-discovery socket events, as MainLayout registers them
 * (docs/local/server-discovery-plan.html, "Socket handlers in MainLayout").
 *
 * Two are user-targeted (the requester's `user:{id}` room): join_approved
 * and join_declined. Two reach the moderator audience: join_request and
 * join_request_resolved. Every payload is unauthenticated JSON as far as
 * this client knows — each handler validates the shape and drops the rest.
 */

function isServerPayload(v: unknown): v is Server {
  return !!v && typeof v === 'object'
    && typeof (v as Server).id === 'string'
    && typeof (v as Server).name === 'string'
    && typeof (v as Server).ownerId === 'string';
}

export const discoverySocketHandlers = {
  /** server:join_approved → the strip gains the server, the card reads Open, a toast says who let us in. */
  joinApproved: (payload: unknown) => {
    const server = (payload as { server?: unknown } | null)?.server;
    if (!isServerPayload(server)) return;
    useServerStore.setState((state) => (
      state.servers.some((s) => s.id === server.id) ? state : { servers: [...state.servers, server] }
    ));
    useDiscoveryStore.getState().markRequestResolved(server.id, 'approved');
    toast.success(i18n.t('discovery.toasts.approved', { name: server.name }));
  },

  /** server:join_declined → the card goes back to Request to join (the cooldown shows on the next click), a toast. */
  joinDeclined: (payload: unknown) => {
    const p = payload as { serverId?: unknown; serverName?: unknown } | null;
    if (typeof p?.serverId !== 'string') return;
    useDiscoveryStore.getState().markRequestResolved(p.serverId, 'declined');
    const name = typeof p.serverName === 'string' && p.serverName ? p.serverName : i18n.t('discovery.toasts.unknownSpace');
    toast.info(i18n.t('discovery.toasts.declined', { name }));
  },

  /** server:join_request → the badge on THAT server, the loaded list, a toast naming requester and space. */
  joinRequest: (payload: unknown) => {
    const p = payload as { serverId?: unknown; request?: unknown } | null;
    if (typeof p?.serverId !== 'string' || !isServerJoinRequest(p.request) || p.request.serverId !== p.serverId) return;
    const before = useServerStore.getState().joinRequestCounts[p.serverId] || 0;
    useServerStore.getState().handleJoinRequest(p.serverId, p.request);
    // A replay of a request we already hold moves nothing — and toasts nothing
    if ((useServerStore.getState().joinRequestCounts[p.serverId] || 0) === before) return;
    const serverName = useServerStore.getState().servers.find((s) => s.id === p.serverId)?.name
      ?? i18n.t('discovery.toasts.unknownSpace');
    toast.info(i18n.t('discovery.toasts.newRequest', { user: p.request.user.displayName, server: serverName }));
  },

  /** server:join_request_resolved (every outcome: approved / declined / cancelled / joined) → drop the row, move the badge. */
  joinRequestResolved: (payload: unknown) => {
    const p = payload as { serverId?: unknown; userId?: unknown } | null;
    if (typeof p?.serverId !== 'string' || typeof p?.userId !== 'string') return;
    useServerStore.getState().handleJoinRequestResolved(p.serverId, p.userId);
  },
};
