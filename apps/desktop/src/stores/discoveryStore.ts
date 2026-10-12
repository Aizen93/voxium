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
 * edited locally on every action, by the two user-targeted socket events
 * (see services/discoverySocketHandlers.ts), and reconciled against the
 * strip (serverStore.servers) so a kick, a leave or a deletion flips the
 * card back while Explore is open.
 *
 * Account-scoped: listed in ACCOUNT_STORES (resetStores.ts), so every update
 * below is immutable, and resetDiscoveryModuleState() retires the requests
 * still in flight at logout.
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
  /** Which browse (q|tag|sort) produced the lists — another one starts from empty. */
  browseKey: string | null;
  /** The parameters the current page was fetched with: a cursor is bound to them, not to the live query box. */
  browseParams: { q: string | null; tag: string; sort: DiscoverySort } | null;
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
  /**
   * Join from the card. Open mode: the server answers with the Server, the
   * strip gains it and it becomes active — resolves to it. If the owner
   * switched to approval meanwhile (the page is cached for a minute) the same
   * POST creates a REQUEST instead: the card reads Requested and this
   * resolves to null.
   */
  join: (serverId: string) => Promise<Server | null>;
  /**
   * Request to join with an optional message. Resolves 'pending' normally;
   * 'joined' when the owner switched to open meanwhile and the POST landed
   * the viewer in the server (then everything join() does has been done).
   */
  request: (serverId: string, message?: string) => Promise<'pending' | 'joined'>;
  cancelRequest: (serverId: string) => Promise<void>;
  /** server:join_approved / server:join_declined, and anything else that settles a pending request. */
  markRequestResolved: (serverId: string, outcome: 'approved' | 'declined' | 'cancelled') => void;
  /** The viewer is no longer a member of that server (kick, leave, deletion): the card reads Join again. */
  leftServer: (serverId: string) => void;
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

function isServerBody(v: unknown): v is Server {
  return !!v && typeof v === 'object' && typeof (v as Server).id === 'string' && typeof (v as Server).name === 'string';
}

function isPendingBody(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as { status?: unknown }).status === 'pending';
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

/** The server's own message, or null — anything else ('Network Error', a malformed page) gets the localized fallback in the UI. */
function serverError(err: unknown): string | null {
  return axios.isAxiosError(err) && typeof err.response?.data?.error === 'string' ? err.response.data.error : null;
}

/** Monotonic id of the latest fetchFirst, so a slow earlier page cannot land on top of a newer one. */
let fetchSeq = 0;
/** Bumped at logout: a request that was in flight for the previous account must not touch the next one's stores. */
let session = 0;

/** Called by resetAccountStores: retire everything still in flight. */
export function resetDiscoveryModuleState(): void {
  fetchSeq++;
  session++;
}

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

/** The inverse: the viewer is out (kicked, left, the server was deleted). */
function leaveMember(list: DiscoveryServer[], serverId: string): DiscoveryServer[] {
  let changed = false;
  const next = list.map((s) => {
    if (s.id !== serverId) return s;
    changed = true;
    return { ...s, isMember: false, requestPending: false, memberCount: s.isMember ? Math.max(0, s.memberCount - 1) : s.memberCount };
  });
  return changed ? next : list;
}

/** The strip is the truth about membership: every card follows it. */
function reconcile(list: DiscoveryServer[], stripIds: Set<string>): DiscoveryServer[] {
  let changed = false;
  const next = list.map((s) => {
    const inStrip = stripIds.has(s.id);
    if (s.isMember === inStrip) return s;
    changed = true;
    return inStrip
      ? { ...s, isMember: true, requestPending: false, memberCount: s.memberCount + 1 }
      : { ...s, isMember: false, requestPending: false, memberCount: Math.max(0, s.memberCount - 1) };
  });
  return changed ? next : list;
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => {
  /** The open-mode landing, shared by join() and a request() that joined: strip, card, active server. */
  const landJoined = async (serverId: string, server: Server) => {
    // Mirror joinServer: append to the strip (the reconcile below flips the
    // card), then land in it like an invite join does. member:joined for the
    // others arrives over the socket.
    useServerStore.setState((state) => (
      state.servers.some((s) => s.id === server.id) ? state : { servers: [...state.servers, server] }
    ));
    set((state) => ({
      featured: becomeMember(state.featured, serverId),
      servers: becomeMember(state.servers, serverId),
    }));
    await useServerStore.getState().setActiveServer(server.id);
  };

  return {
    query: '',
    tag: '',
    sort: 'active',
    featured: [],
    servers: [],
    nextCursor: null,
    totalCapped: 0,
    browseKey: null,
    browseParams: null,
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
      const { query, tag, sort, browseKey } = get();
      const q = searchableQuery(query);
      const key = `${q ?? ''}|${tag}|${sort}`;
      // A new browse owns the page state: the previous results must not sit
      // under the new heading, and a Load more superseded by this call must
      // not leave its flag behind (it bails on seq and never writes again).
      const browseParams = { q: q ?? null, tag, sort };
      set(browseKey === key
        ? { loading: true, loadingMore: false, error: null, browseParams }
        : { loading: true, loadingMore: false, error: null, browseKey: key, browseParams, featured: [], servers: [], nextCursor: null, totalCapped: 0 });
      try {
        const params: Record<string, string> = { sort };
        if (q) params.q = q;
        if (tag) params.tag = tag;
        const { data } = await api.get('/discovery/servers', { params });
        if (seq !== fetchSeq) return; // superseded by a newer browse (or logout)
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
        set({ status: 'error', error: serverError(err), loading: false });
      }
    },

    fetchMore: async () => {
      const { nextCursor, loadingMore, loading, browseParams } = get();
      if (!nextCursor || loadingMore || loading || !browseParams) return;
      const seq = fetchSeq;
      set({ loadingMore: true });
      try {
        // The cursor is bound to the browse that issued it (q, tag, sort), not
        // to the live query box: a keystroke inside the debounce window must
        // not pair a new q with the old cursor ("Invalid cursor").
        const params: Record<string, string> = { sort: browseParams.sort, cursor: nextCursor };
        if (browseParams.q) params.q = browseParams.q;
        if (browseParams.tag) params.tag = browseParams.tag;
        const { data } = await api.get('/discovery/servers', { params });
        if (seq !== fetchSeq) return; // the browse changed underneath; that page is gone (fetchFirst reset the flag)
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
        set({ loadingMore: false, error: serverError(err) });
        throw err;
      }
    },

    join: async (serverId) => {
      const mySession = session;
      set({ busyServerId: serverId });
      try {
        const { data } = await api.post(`/discovery/servers/${serverId}/join`);
        if (mySession !== session) return null; // logged out meanwhile: not this account's answer
        const body: unknown = data.data;
        if (isPendingBody(body)) {
          // The owner switched to approval after the page was cached: the
          // server created a request from this click.
          set((state) => ({
            featured: applyFlags(state.featured, serverId, { requestPending: true }),
            servers: applyFlags(state.servers, serverId, { requestPending: true }),
          }));
          return null;
        }
        if (!isServerBody(body)) throw new Error('Malformed join response');
        await landJoined(serverId, body);
        return body;
      } finally {
        if (mySession === session) set({ busyServerId: null });
      }
    },

    request: async (serverId, message) => {
      const mySession = session;
      set({ busyServerId: serverId });
      try {
        const trimmed = message?.trim();
        const { data } = await api.post(`/discovery/servers/${serverId}/join`, trimmed ? { message: trimmed } : {});
        if (mySession !== session) return 'pending';
        const body: unknown = data.data;
        if (isServerBody(body)) {
          // The owner switched to open after the page was cached: the server
          // joined the viewer outright — land exactly like join().
          await landJoined(serverId, body);
          return 'joined';
        }
        set((state) => ({
          featured: applyFlags(state.featured, serverId, { requestPending: true }),
          servers: applyFlags(state.servers, serverId, { requestPending: true }),
        }));
        return 'pending';
      } finally {
        if (mySession === session) set({ busyServerId: null });
      }
    },

    cancelRequest: async (serverId) => {
      const mySession = session;
      set({ busyServerId: serverId });
      try {
        await api.delete(`/discovery/servers/${serverId}/join`);
        if (mySession !== session) return;
        get().markRequestResolved(serverId, 'cancelled');
      } catch (err) {
        if (mySession !== session) return;
        // The row is already gone (approved, declined, or swept meanwhile): the
        // card must not stay stuck on Requested.
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          get().markRequestResolved(serverId, 'cancelled');
          return;
        }
        throw err;
      } finally {
        if (mySession === session) set({ busyServerId: null });
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

    leftServer: (serverId) => {
      set((state) => ({
        featured: leaveMember(state.featured, serverId),
        servers: leaveMember(state.servers, serverId),
      }));
    },
  };
});

// The strip is the truth about membership. Whatever removes a server from it
// (member:kicked, server:deleted, leaveServer, a reconnect that refetched)
// or adds one (an invite join, join_approved) is reflected on the cards at
// once — so an open Explore never offers "Open" on a server the viewer is no
// longer in, and never counts them twice.
useServerStore.subscribe((state, prev) => {
  if (state.servers === prev.servers) return;
  const ids = new Set(state.servers.map((s) => s.id));
  useDiscoveryStore.setState((d) => {
    const featured = reconcile(d.featured, ids);
    const servers = reconcile(d.servers, ids);
    return featured === d.featured && servers === d.servers ? d : { featured, servers };
  });
});
