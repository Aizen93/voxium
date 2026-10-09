import { create } from 'zustand';
import axios from 'axios';
import { DISCOVERY_SEARCH_MIN, DISCOVERY_SEARCH_MAX } from '@voxium/shared';
import type { DiscoveryPage, DiscoveryServer, DiscoverySort, Server } from '@voxium/shared';
import { api } from '../services/api';
import { useServerStore } from './serverStore';

/**
 * Explore — the member side of server discovery
 * (docs/local/server-discovery-plan.html, "Desktop client → Explore").
 *
 * Holds the browse state (query, tag, sort), the loaded result list with its
 * cursor, the Featured row and the capped total, plus the viewer's actions:
 * join (open mode — lands in the server like an invite would), request
 * (approval mode), cancel. The card flags (isMember / requestPending) are
 * edited locally on every action and by the two user-targeted socket events
 * (see services/discoverySocketHandlers.ts).
 *
 * Account-scoped: listed in ACCOUNT_STORES (resetStores.ts), so every update
 * below is immutable.
 */

export type DiscoveryStatus =
  /** nothing fetched yet */
  | 'idle'
  | 'ready'
  /** the server_discovery flag is off (403): the modal shows its off state */
  | 'off'
  | 'error';

/** The pages the client follows via `nextCursor`, kept as a flat list. */
interface DiscoveryState {
  query: string;
  tag: string;
  sort: DiscoverySort;
  featured: DiscoveryServer[];
  servers: DiscoveryServer[];
  nextCursor: string | null;
  totalCapped: number;
  status: DiscoveryStatus;
  /** The raw server message of the last failure, for translateServerError. */
  error: string | null;
  loading: boolean;
  loadingMore: boolean;
  /** The card whose action is in flight (one at a time). */
  busyServerId: string | null;

  setQuery: (query: string) => void;
  setTag: (tag: string) => void;
  setSort: (sort: DiscoverySort) => void;
  /** First page for the current query/tag/sort; a later call supersedes an earlier one still in flight. */
  fetchFirst: () => Promise<void>;
  /** Next page via the cursor; appends. */
  fetchMore: () => Promise<void>;
  /** Open mode: POST join, append the returned server to serverStore and make it active. */
  join: (serverId: string) => Promise<Server>;
  /** Approval mode: POST a request with an optional message; the card reads Requested. */
  request: (serverId: string, message?: string) => Promise<void>;
  cancelRequest: (serverId: string) => Promise<void>;
  /** server:join_approved / server:join_declined, and anything else that settles a pending request. */
  markRequestResolved: (serverId: string, outcome: 'approved' | 'declined' | 'cancelled') => void;
  /** Local edit of one card's flags (a member:left for us, a ban, …). */
  patchServer: (serverId: string, patch: Partial<Pick<DiscoveryServer, 'isMember' | 'requestPending'>>) => void;
}

/** A query is sent only when it can be searched: 3–64 characters, trimmed. */
export function searchableQuery(query: string): string | null {
  const q = query.trim();
  if (q.length < DISCOVERY_SEARCH_MIN || q.length > DISCOVERY_SEARCH_MAX) return null;
  return q;
}

function isDiscoveryPage(v: unknown): v is DiscoveryPage {
  return !!v && typeof v === 'object'
    && Array.isArray((v as DiscoveryPage).servers)
    && Array.isArray((v as DiscoveryPage).featured);
}

/** The flag-off answer (403 + the mapped message) is a STATE, not an error. */
function isFeatureOff(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 403
    && err.response?.data?.error === 'Server discovery is currently disabled';
}

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) return typeof err.response?.data?.error === 'string' ? err.response.data.error : err.message;
  return err instanceof Error ? err.message : 'Failed to load Explore';
}

/** Monotonic id of the latest fetchFirst, so a slow earlier page cannot land on top of a newer one. */
let fetchSeq = 0;

function applyFlags(list: DiscoveryServer[], serverId: string, patch: Partial<Pick<DiscoveryServer, 'isMember' | 'requestPending'>>): DiscoveryServer[] {
  let changed = false;
  const next = list.map((s) => {
    if (s.id !== serverId) return s;
    changed = true;
    return { ...s, ...patch };
  });
  return changed ? next : list;
}

/** The viewer just became a member: the card reads Open and counts them —
 *  the directory page is cached for a minute, so the server's figure would
 *  not show the viewer themselves until the next page. */
function becomeMember(list: DiscoveryServer[], serverId: string): DiscoveryServer[] {
  let changed = false;
  const next = list.map((s) => {
    if (s.id !== serverId) return s;
    changed = true;
    return { ...s, isMember: true, requestPending: false, memberCount: s.isMember ? s.memberCount : s.memberCount + 1 };
  });
  return changed ? next : list;
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => ({
  query: '',
  tag: '',
  sort: 'active',
  featured: [],
  servers: [],
  nextCursor: null,
  totalCapped: 0,
  status: 'idle',
  error: null,
  loading: false,
  loadingMore: false,
  busyServerId: null,

  setQuery: (query) => set({ query }),
  setTag: (tag) => set({ tag }),
  setSort: (sort) => set({ sort }),

  fetchFirst: async () => {
    const seq = ++fetchSeq;
    const { query, tag, sort } = get();
    const q = searchableQuery(query);
    set({ loading: true, error: null });
    try {
      const params: Record<string, string> = { sort };
      if (q) params.q = q;
      if (tag) params.tag = tag;
      const { data } = await api.get('/discovery/servers', { params });
      if (seq !== fetchSeq) return; // superseded by a newer browse
      const page: unknown = data.data;
      if (!isDiscoveryPage(page)) throw new Error('Malformed directory page');
      set({
        featured: page.featured,
        servers: page.servers,
        nextCursor: page.nextCursor ?? null,
        totalCapped: typeof page.totalCapped === 'number' ? page.totalCapped : page.servers.length,
        status: 'ready',
        loading: false,
        error: null,
      });
    } catch (err) {
      if (seq !== fetchSeq) return;
      if (isFeatureOff(err)) {
        set({ status: 'off', featured: [], servers: [], nextCursor: null, totalCapped: 0, loading: false, error: null });
        return;
      }
      console.warn('[Discovery] Failed to load the directory:', errorMessage(err));
      set({ status: 'error', error: errorMessage(err), loading: false });
    }
  },

  fetchMore: async () => {
    const { nextCursor, loadingMore, loading, query, tag, sort } = get();
    if (!nextCursor || loadingMore || loading) return;
    const seq = fetchSeq;
    set({ loadingMore: true });
    try {
      const params: Record<string, string> = { sort, cursor: nextCursor };
      const q = searchableQuery(query);
      if (q) params.q = q;
      if (tag) params.tag = tag;
      const { data } = await api.get('/discovery/servers', { params });
      if (seq !== fetchSeq) return; // the browse changed underneath; that page is gone
      const page: unknown = data.data;
      if (!isDiscoveryPage(page)) throw new Error('Malformed directory page');
      set((state) => {
        // A server can move between pages while we page (the Members sort is
        // live): never show one card twice.
        const seen = new Set(state.servers.map((s) => s.id));
        const fresh = page.servers.filter((s) => !seen.has(s.id));
        return { servers: [...state.servers, ...fresh], nextCursor: page.nextCursor ?? null, loadingMore: false };
      });
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.warn('[Discovery] Failed to load more:', errorMessage(err));
      set({ loadingMore: false, error: errorMessage(err) });
      throw err;
    }
  },

  join: async (serverId) => {
    set({ busyServerId: serverId });
    try {
      const { data } = await api.post(`/discovery/servers/${serverId}/join`);
      const server = data.data as Server;
      if (!server || typeof server.id !== 'string') throw new Error('Malformed join response');
      // Mirror joinServer: append to the strip, then land in it like an invite
      // join does. member:joined for the others arrives over the socket.
      useServerStore.setState((state) => (
        state.servers.some((s) => s.id === server.id) ? state : { servers: [...state.servers, server] }
      ));
      set((state) => ({
        featured: becomeMember(state.featured, serverId),
        servers: becomeMember(state.servers, serverId),
      }));
      await useServerStore.getState().setActiveServer(server.id);
      return server;
    } finally {
      set({ busyServerId: null });
    }
  },

  request: async (serverId, message) => {
    set({ busyServerId: serverId });
    try {
      const trimmed = message?.trim();
      await api.post(`/discovery/servers/${serverId}/join`, trimmed ? { message: trimmed } : {});
      set((state) => ({
        featured: applyFlags(state.featured, serverId, { requestPending: true }),
        servers: applyFlags(state.servers, serverId, { requestPending: true }),
      }));
    } finally {
      set({ busyServerId: null });
    }
  },

  cancelRequest: async (serverId) => {
    set({ busyServerId: serverId });
    try {
      await api.delete(`/discovery/servers/${serverId}/join`);
      get().markRequestResolved(serverId, 'cancelled');
    } catch (err) {
      // The row is already gone (approved, declined, or swept meanwhile): the
      // card must not stay stuck on Requested.
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        get().markRequestResolved(serverId, 'cancelled');
        return;
      }
      throw err;
    } finally {
      set({ busyServerId: null });
    }
  },

  markRequestResolved: (serverId, outcome) => {
    set((state) => (outcome === 'approved'
      ? { featured: becomeMember(state.featured, serverId), servers: becomeMember(state.servers, serverId) }
      : {
          featured: applyFlags(state.featured, serverId, { requestPending: false }),
          servers: applyFlags(state.servers, serverId, { requestPending: false }),
        }));
  },

  patchServer: (serverId, patch) => {
    set((state) => ({
      featured: applyFlags(state.featured, serverId, patch),
      servers: applyFlags(state.servers, serverId, patch),
    }));
  },
}));
