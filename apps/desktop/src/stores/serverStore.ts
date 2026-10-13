import { create } from 'zustand';
import axios from 'axios';
import { api } from '../services/api';
import { processImage } from '../utils/imageProcessing';
import { toast } from './toastStore';
import { isDiscoveryTier, DISCOVERY_TIERS, LIMITS, MEMBER_LIST } from '@voxium/shared';
import type { DiscoveryTier } from '@voxium/shared';
import type { Server, Channel, Category, ServerMember, PublicUser, UserStatus, UnreadCount, MemberRole, Role, ChannelPermissionOverride, SecureChannelMember, ServerJoinRequest, ServerBan, ServerDiscoveryInfo, ServerJoinMode } from '@voxium/shared';

/** Module-level constant so selectors can default without a fresh reference. */
export const NO_SECURE_MEMBERS: SecureChannelMember[] = [];
/** Same rule for the moderation lists: a section for a server the lists are
 *  not loaded for selects THESE, never a fresh `[]`. */
export const NO_JOIN_REQUESTS: ServerJoinRequest[] = [];
export const NO_BANS: ServerBan[] = [];

/** How many pages the moderation lists follow (`hasMore`) before stopping:
 *  10 × MEMBERS_PER_PAGE rows is far past any real queue, and bounds the
 *  fan-out of one tab open. */
const MODERATION_LIST_MAX_PAGES = 10;

/** `page` within a moderation payload, or the shape we refuse (socket events
 *  are unauthenticated JSON as far as this client knows). */
function isUserSummary(v: unknown): v is ServerJoinRequest['user'] {
  return !!v && typeof v === 'object'
    && typeof (v as { id?: unknown }).id === 'string'
    && typeof (v as { username?: unknown }).username === 'string'
    && typeof (v as { displayName?: unknown }).displayName === 'string';
}
export function isServerJoinRequest(v: unknown): v is ServerJoinRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ServerJoinRequest>;
  return typeof r.id === 'string' && typeof r.serverId === 'string' && typeof r.userId === 'string'
    && typeof r.createdAt === 'string' && (r.message === null || r.message === undefined || typeof r.message === 'string')
    && isUserSummary(r.user);
}

/** The score every tier starts at, as the owner endpoint sends it — all five, numeric. */
function isTierThresholdMap(v: unknown): v is Record<DiscoveryTier, number> {
  return !!v && typeof v === 'object' && DISCOVERY_TIERS.every((tier) => typeof (v as Record<string, unknown>)[tier] === 'number');
}

/** Follows `hasMore` through a paginated moderation list, up to the cap. */
async function fetchAllPages<T>(url: string): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  let total = 0;
  for (let page = 1; page <= MODERATION_LIST_MAX_PAGES; page++) {
    const { data } = await api.get(url, { params: { page } });
    const chunk = Array.isArray(data.data) ? (data.data as T[]) : [];
    rows.push(...chunk);
    total = typeof data.total === 'number' ? data.total : rows.length;
    if (!data.hasMore || chunk.length === 0) break;
  }
  return { rows, total: Math.max(total, rows.length) };
}

/** Resolutions this client applied itself (approve / decline), so the socket
 *  echo of them never moves the badge a second time. Keyed serverId:userId. */
const locallyResolved = new Set<string>();

/**
 * Approve or decline, then drop the row here without waiting for the socket
 * echo (we are in the moderator audience, so it comes too and is ignored by
 * the mark). A 404 is a resolution as well: the row can be gone without any
 * event (the requester deleted their account, the 30-day sweep) and must not
 * stay on screen as an undeletable row with a stale badge.
 */
async function decideJoinRequest(
  get: () => { handleJoinRequestResolved: (serverId: string, userId: string) => void },
  serverId: string,
  userId: string,
  action: 'approve' | 'decline',
): Promise<void> {
  try {
    await api.post(`/servers/${serverId}/join-requests/${userId}/${action}`);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) get().handleJoinRequestResolved(serverId, userId);
    throw err;
  }
  locallyResolved.add(`${serverId}:${userId}`);
  get().handleJoinRequestResolved(serverId, userId);
}

// ─── Member lists ───────────────────────────────────────────────────────────
//
// `members` is every member row this client KNOWS for the active server: the
// People panel's slice (GET /members/online — everyone on a small server, the
// online members on a big one) plus whatever the batched lookup fetched for a
// message author, a voice participant or a presence event. `people` says how
// that slice relates to the whole membership; the directory (Server settings
// → Members) is a separate, server-paged list that shares the same rows'
// live updates.

export interface PeopleState {
  /** Every member is loaded, offline included (the server is small). */
  full: boolean;
  /** Online members exist beyond the loaded slice (the cap cut them). */
  truncated: boolean;
  /** The server's figures at load time, moved by the live events since. */
  onlineCount: number;
  memberCount: number;
  loaded: boolean;
}
export const EMPTY_PEOPLE: PeopleState = { full: true, truncated: false, onlineCount: 0, memberCount: 0, loaded: false };

export interface DirectoryState {
  /** Whose list this is — a component renders it only when the id is its own. */
  serverId: string | null;
  rows: ServerMember[];
  /** Members matching the filter (the whole membership when unfiltered). */
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  q: string;
  /** 'owner' | 'admin' | 'none' | a role id | null for all */
  role: string | null;
  loading: boolean;
  error: boolean;
}
export const EMPTY_DIRECTORY: DirectoryState = { serverId: null, rows: [], total: 0, nextCursor: null, hasMore: false, q: '', role: null, loading: false, error: false };

/** How long unknown ids are collected before one lookup request goes out. */
export const MEMBER_LOOKUP_DEBOUNCE_MS = 300;
/** After a failed lookup, how long before the next one may go out. */
const MEMBER_LOOKUP_BACKOFF_MS = 10_000;
/** Known rows past this many: offline rows are dropped, oldest first (the viewer is online while here). */
const MEMBER_CACHE_MAX = MEMBER_LIST.PEOPLE_MAX_ROWS * 3;

/** Ids the server answered are NOT members of the active server (a presence
 *  event names everyone we share any server with) — asked once, never again
 *  until the server changes or they join. */
const lookupMisses = new Set<string>();
/** Ids queued for the next lookup. A failed request leaves them here (the
 *  retry goes out after the back-off); only a success or a miss removes one. */
const lookupPending = new Set<string>();
/** Ids a request is out for right now — not taken again by a second flush. */
const lookupInFlight = new Set<string>();
let lookupTimer: ReturnType<typeof setTimeout> | null = null;
let lookupBackoffUntil = 0;
/** Consecutive failed lookups; past MEMBER_LOOKUP_MAX_FAILURES the queue is dropped. */
let lookupFailures = 0;
const MEMBER_LOOKUP_MAX_FAILURES = 3;
/** Bumped by every first-page directory fetch so a slower earlier response is
 *  dropped, and when the directory's server is left (switch, removal, logout). */
let directoryGeneration = 0;

/** Forget the lookup queue and the misses: on a server switch, and at logout.
 *  NOT on a slice refetch — ids queued while the slice was in flight must
 *  still go out, and nothing re-asks for them (useMember only asks once). */
export function resetMemberLookupState(): void {
  lookupMisses.clear();
  lookupPending.clear();
  lookupInFlight.clear();
  if (lookupTimer) { clearTimeout(lookupTimer); lookupTimer = null; }
  lookupBackoffUntil = 0;
  lookupFailures = 0;
}

/** A directory page still in flight belongs to a server we are leaving: drop it when it lands. */
export function retireDirectory(): void {
  directoryGeneration++;
}

function isOnline(m: ServerMember): boolean {
  return (m.user.status || 'offline') !== 'offline';
}

/** The same row patched in the known rows and the directory (one of them may not hold it). */
function patchRows(rows: ServerMember[], userId: string, patch: (m: ServerMember) => ServerMember): ServerMember[] {
  let changed = false;
  const next = rows.map((m) => { if (m.userId !== userId) return m; changed = true; return patch(m); });
  return changed ? next : rows;
}
function patchMemberEverywhere(state: { members: ServerMember[]; directory: DirectoryState }, userId: string, patch: (m: ServerMember) => ServerMember) {
  const members = patchRows(state.members, userId, patch);
  const rows = patchRows(state.directory.rows, userId, patch);
  return { members, directory: rows === state.directory.rows ? state.directory : { ...state.directory, rows } };
}

/** Rows a lookup or a directory page brought in, merged into the known rows (fresher data wins). */
function mergeKnownMembers(state: { members: ServerMember[]; people: PeopleState }, rows: ServerMember[]) {
  const byId = new Map(state.members.map((m) => [m.userId, m]));
  let onlineCount = state.people.onlineCount;
  for (const row of rows) {
    const prev = byId.get(row.userId);
    if (prev) {
      // Presence events are the live authority for status: a page or a
      // lookup is a DB snapshot that may predate the event that already
      // moved the count. Take the fresher profile, keep the status we hold.
      byId.set(row.userId, { ...row, user: { ...row.user, status: prev.user.status } });
      continue;
    }
    // A member found online that the slice did not hold came online after the
    // load (the slice held every online member) — count them. A TRUNCATED
    // slice already counted the members it cut, so never there.
    if (!state.people.full && !state.people.truncated && isOnline(row)) onlineCount++;
    byId.set(row.userId, row);
  }
  let members = [...byId.values()];
  if (members.length > MEMBER_CACHE_MAX) {
    let excess = members.length - MEMBER_CACHE_MAX;
    members = members.filter((m) => {
      if (excess <= 0 || isOnline(m)) return true;
      excess--;
      return false;
    });
  }
  return { members, people: onlineCount === state.people.onlineCount ? state.people : { ...state.people, onlineCount } };
}

/** A member row from a `member:joined` payload (role and nickname are the join defaults). */
function memberFromJoin(serverId: string, user: PublicUser): ServerMember {
  return {
    userId: user.id,
    serverId,
    role: 'member',
    nickname: null,
    joinedAt: new Date().toISOString(),
    roles: [],
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio ?? null,
      status: user.status || 'online',
      role: user.role || 'user',
      isSupporter: user.isSupporter ?? false,
      supporterTier: user.supporterTier ?? null,
      createdAt: user.createdAt,
    },
  };
}

/** One page of the directory as the API sends it, with safe defaults. */
function directoryPage(data: { data?: unknown; total?: unknown; nextCursor?: unknown; hasMore?: unknown }) {
  const rows = Array.isArray(data.data) ? (data.data as ServerMember[]) : [];
  return {
    rows,
    total: typeof data.total === 'number' ? data.total : rows.length,
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
    hasMore: data.hasMore === true,
  };
}

const PINNED_KEY = 'voxium_pinned_spaces';

/** Pin order IS display order in the spaces strip — first pinned, first shown. */
function loadPinnedServers(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* ignore corrupt storage */ }
  return [];
}

interface ServerState {
  servers: Server[];
  activeServerId: string | null;
  /** Device-level preference (localStorage), like collapsed categories. */
  pinnedServerIds: string[];
  channels: Channel[];
  categories: Category[];
  activeChannelId: string | null;
  members: ServerMember[];
  people: PeopleState;
  directory: DirectoryState;
  roles: Role[];
  isLoading: boolean;
  unreadCounts: Record<string, number>;
  serverUnreadCounts: Record<string, number>;

  fetchServers: () => Promise<void>;
  togglePinServer: (serverId: string) => void;
  setActiveServer: (serverId: string) => Promise<void>;
  setActiveChannel: (channelId: string) => void;
  createServer: (name: string) => Promise<Server>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string) => Promise<Channel>;
  deleteChannel: (serverId: string, channelId: string) => Promise<void>;
  createInvite: (serverId: string) => Promise<string>;
  joinServer: (inviteCode: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  updateMemberStatus: (userId: string, status: UserStatus) => void;
  addMember: (serverId: string, user: PublicUser) => void;
  removeMember: (serverId: string, userId: string) => void;
  addChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId: string) => void;
  updateChannelData: (channel: Channel) => void;
  addCategory: (category: Category) => void;
  updateCategory: (category: Category) => void;
  removeCategory: (categoryId: string, serverId: string) => void;
  createCategory: (serverId: string, name: string) => Promise<Category>;
  deleteCategory: (serverId: string, categoryId: string) => Promise<void>;
  renameCategory: (serverId: string, categoryId: string, name: string) => Promise<void>;
  /** The People panel's slice (replaces `members` and `people`). */
  fetchPeople: (serverId: string) => Promise<void>;
  /** Fetch the rows of members this client has no row for — coalesced into
   *  one request per MEMBER_LOOKUP_DEBOUNCE_MS, at most LOOKUP_MAX_IDS each;
   *  ids the server does not return are remembered as non-members. */
  ensureMembers: (userIds: string[]) => void;
  /** Server settings → Members: the first page for a search text and a role filter. */
  fetchDirectory: (serverId: string, filter: { q: string; role: string | null }) => Promise<void>;
  fetchDirectoryMore: (serverId: string) => Promise<void>;
  incrementUnread: (channelId: string, serverId: string) => void;
  clearUnread: (channelId: string) => void;
  initUnreadCounts: (unreads: UnreadCount[]) => void;
  markChannelRead: (channelId: string, hintServerId?: string) => void;
  uploadServerIcon: (serverId: string, file: File) => Promise<void>;
  updateServer: (serverId: string, fields: { name?: string }) => Promise<void>;
  updateServerData: (server: Server) => void;
  updateMemberAvatar: (userId: string, avatarUrl: string | null) => void;
  updateMemberProfile: (userId: string, fields: Record<string, unknown>) => void;
  reorderCategories: (serverId: string, order: { id: string; position: number }[]) => Promise<void>;
  reorderChannels: (serverId: string, order: { id: string; position: number; categoryId: string | null }[]) => Promise<void>;
  updateMemberRole: (serverId: string, memberId: string, role: MemberRole) => Promise<void>;
  /** Remove AND ban (every removal is a ban); the reason is optional and shown to moderators. */
  kickMember: (serverId: string, memberId: string, reason?: string) => Promise<void>;
  transferOwnership: (serverId: string, targetUserId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  toggleInvitesLock: (serverId: string, locked: boolean) => Promise<void>;
  handleMemberRoleUpdated: (serverId: string, userId: string, role: MemberRole) => void;
  handleMemberKicked: (serverId: string) => void;
  handleServerDeleted: (serverId: string) => void;

  // Roles
  fetchRoles: (serverId: string) => Promise<void>;
  createRole: (serverId: string, name: string, color?: string, permissions?: string) => Promise<Role>;
  updateRole: (serverId: string, roleId: string, fields: { name?: string; color?: string | null; permissions?: string }) => Promise<void>;
  deleteRole: (serverId: string, roleId: string) => Promise<void>;
  reorderRoles: (serverId: string, order: { id: string; position: number }[]) => Promise<void>;
  assignMemberRoles: (serverId: string, memberId: string, roleIds: string[]) => Promise<void>;
  handleRoleCreated: (serverId: string, role: Role) => void;
  handleRoleUpdated: (serverId: string, role: Role) => void;
  handleRoleDeleted: (serverId: string, roleId: string) => void;
  handleRoleReordered: (serverId: string, roles: { id: string; position: number }[]) => void;
  handleMemberRolesUpdated: (serverId: string, userId: string, roleIds: string[]) => void;

  // Channel permissions
  fetchChannelPermissions: (serverId: string, channelId: string) => Promise<ChannelPermissionOverride[]>;
  setChannelPermissionOverride: (serverId: string, channelId: string, roleId: string, allow: string, deny: string) => Promise<void>;
  deleteChannelPermissionOverride: (serverId: string, channelId: string, roleId: string) => Promise<void>;

  // Permission calculator
  fetchEffectivePermissions: (serverId: string, channelId?: string) => Promise<string>;

  // Nicknames
  setNickname: (serverId: string, nickname: string | null) => Promise<void>;
  setMemberNickname: (serverId: string, memberId: string, nickname: string | null) => Promise<void>;
  handleNicknameUpdated: (serverId: string, userId: string, nickname: string | null) => void;

  // Secure channels (invite-only E2E-encrypted). All mutating actions rely on
  // socket events for state — POST/DELETE responses never touch local state.
  /** Member lists per secure channel, filled by fetch + members_updated events. */
  secureChannelMembers: Record<string, SecureChannelMember[]>;
  createSecureChannel: (serverId: string, name: string, memberIds: string[], type?: 'text' | 'voice') => Promise<Channel>;
  renameSecureChannel: (serverId: string, channelId: string, name: string) => Promise<void>;
  inviteSecureChannelMember: (serverId: string, channelId: string, userId: string) => Promise<void>;
  removeSecureChannelMember: (serverId: string, channelId: string, userId: string) => Promise<void>;
  leaveSecureChannel: (serverId: string, channelId: string, selfUserId: string) => Promise<void>;
  fetchSecureChannelMembers: (serverId: string, channelId: string) => Promise<SecureChannelMember[]>;
  fetchSecureChannelCount: (serverId: string) => Promise<number>;
  handleChannelMembersUpdated: (payload: { channelId?: unknown; serverId?: unknown; members?: unknown }) => void;

  // Server discovery — the owner side (docs/local/server-discovery-plan.html).
  // Profile changes land through server:updated, never the PATCH response.
  /** Pending join requests per server, for the Members tab badge (moderators only). */
  joinRequestCounts: Record<string, number>;
  /** The loaded list (one server at a time) and whose it is. Components
   *  select the list ONLY when the id matches theirs (NO_JOIN_REQUESTS /
   *  NO_BANS otherwise): a fetch for another server must not show here. */
  joinRequests: ServerJoinRequest[];
  joinRequestsServerId: string | null;
  /** The loaded rows stop at the page cap while the badge carries the server's total. */
  joinRequestsTruncated: boolean;
  bans: ServerBan[];
  bansServerId: string | null;
  updateDiscovery: (serverId: string, fields: { discoverable?: boolean; joinMode?: ServerJoinMode; description?: string | null; tags?: string[] }) => Promise<void>;
  fetchDiscoveryInfo: (serverId: string) => Promise<ServerDiscoveryInfo>;
  fetchJoinRequests: (serverId: string) => Promise<void>;
  approveJoinRequest: (serverId: string, userId: string) => Promise<void>;
  declineJoinRequest: (serverId: string, userId: string) => Promise<void>;
  /** server:join_request — appends to the loaded list, bumps the badge.
   *  Shape-validated: a malformed payload is dropped, never rendered. */
  handleJoinRequest: (serverId: unknown, request: unknown) => void;
  /** server:join_request_resolved (any outcome) and our own approve/decline. */
  handleJoinRequestResolved: (serverId: unknown, userId: unknown) => void;
  fetchBans: (serverId: string) => Promise<void>;
  unbanMember: (serverId: string, userId: string) => Promise<void>;
}

// Dedup: prevent redundant mark-as-read API calls when multiple code paths
// fire within a short window (e.g. setActiveChannel + joinAndFetch on channel switch)
let _lastMarkedChannel = '';
let _lastMarkedAt = 0;

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  pinnedServerIds: loadPinnedServers(),

  togglePinServer: (serverId: string) => {
    set((state) => {
      const pinnedServerIds = state.pinnedServerIds.includes(serverId)
        ? state.pinnedServerIds.filter((id) => id !== serverId)
        : [...state.pinnedServerIds, serverId];
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify(pinnedServerIds));
      } catch { /* ignore storage errors */ }
      return { pinnedServerIds };
    });
  },
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

  fetchServers: async () => {
    try {
      const { data } = await api.get('/servers');
      set({ servers: data.data });
    } catch (err) {
      console.error('Failed to fetch servers:', err);
      toast.error('Failed to load servers');
    }
  },

  setActiveServer: async (serverId: string) => {
    // Mark the previous channel as read before switching servers
    const prevChannelId = get().activeChannelId;
    if (prevChannelId) {
      get().markChannelRead(prevChannelId);
    }

    // The known rows and the lookup memory belong to the server being left:
    // kept, they would answer for the next server until its slice lands.
    if (get().activeServerId !== serverId) {
      resetMemberLookupState();
      retireDirectory();
      set({ activeServerId: serverId, isLoading: true, members: [], people: EMPTY_PEOPLE });
    } else {
      set({ isLoading: true });
    }
    try {
      const { data } = await api.get(`/servers/${serverId}`);

      // Staleness guard: the user may have switched to ANOTHER server (or to the
      // DM view) while this request was in flight. Applying the response anyway
      // would render server A's channels under server B's header.
      if (get().activeServerId !== serverId) return;

      const channels = data.data.channels || [];
      const categories = data.data.categories || [];
      const roles = data.data.roles || [];
      const firstTextChannel = channels.find((c: Channel) => c.type === 'text');

      set({
        channels,
        categories,
        roles,
        activeChannelId: firstTextChannel?.id || null,
        isLoading: false,
      });

      // Clear unread and mark as read for the auto-selected first channel
      if (firstTextChannel) {
        get().clearUnread(firstTextChannel.id);
        get().markChannelRead(firstTextChannel.id);
      }

      // Fetch the People panel's slice in the background
      get().fetchPeople(serverId);
    } catch (err) {
      console.error('Failed to fetch server:', err);
      // Only surface the failure if this server is still the one being viewed
      if (get().activeServerId === serverId) {
        toast.error('Failed to load server');
        set({ isLoading: false });
      }
    }
  },

  setActiveChannel: (channelId: string) => {
    const prevChannelId = get().activeChannelId;
    // No-op if clicking the already-active channel
    if (prevChannelId === channelId) return;
    // Mark the previous channel as read (captures messages received while viewing)
    if (prevChannelId) {
      get().markChannelRead(prevChannelId);
    }
    set({ activeChannelId: channelId });
    get().clearUnread(channelId);
    get().markChannelRead(channelId);
  },

  createServer: async (name: string) => {
    const { data } = await api.post('/servers', { name });
    const server = data.data;
    set((state) => ({ servers: [...state.servers, server] }));
    return server;
  },

  createChannel: async (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string) => {
    const { data } = await api.post(`/servers/${serverId}/channels`, { name, type, categoryId });
    return data.data;
  },

  deleteChannel: async (serverId: string, channelId: string) => {
    await api.delete(`/servers/${serverId}/channels/${channelId}`);
  },

  createInvite: async (serverId: string) => {
    const { data } = await api.post(`/invites/servers/${serverId}`);
    return data.data.code;
  },

  joinServer: async (inviteCode: string) => {
    const { data } = await api.post(`/invites/${inviteCode}/join`);
    const server = data.data;
    set((state) => ({ servers: [...state.servers, server] }));
  },

  leaveServer: async (serverId: string) => {
    await api.post(`/servers/${serverId}/leave`);
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== serverId),
      activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
    }));
  },

  updateMemberStatus: (userId: string, status: UserStatus) => {
    // presence:update names everyone we share ANY server with and carries no
    // serverId; the rows here are the active server's.
    let lookup = false;
    set((state) => {
      const row = state.members.find((m) => m.userId === userId);
      const online = status !== 'offline';
      if (!row) {
        // On a big server the slice holds the online members only: someone we
        // have no row for coming online may be one of ours — the lookup says
        // (and counts them). With the slice cut at the cap they cannot be
        // shown anyway; on a small server everyone is already here.
        lookup = online && state.people.loaded && !state.people.full && !state.people.truncated;
        // A row the directory holds without a twin here (pruned from the
        // known rows) still follows the event
        const rows = patchRows(state.directory.rows, userId, (m) => ({ ...m, user: { ...m.user, status } }));
        return rows === state.directory.rows ? state : { directory: { ...state.directory, rows } };
      }
      const delta = (online ? 1 : 0) - (isOnline(row) ? 1 : 0);
      return {
        ...patchMemberEverywhere(state, userId, (m) => ({ ...m, user: { ...m.user, status } })),
        people: delta === 0 ? state.people : { ...state.people, onlineCount: Math.max(0, state.people.onlineCount + delta) },
      };
    });
    if (lookup) get().ensureMembers([userId]);
  },

  addMember: (serverId: string, user: PublicUser) => {
    if (get().activeServerId !== serverId) return;
    // A readmitted member was a lookup miss while they were out
    lookupMisses.delete(user.id);
    set((state) => {
      if (state.members.some((m) => m.userId === user.id)) return state;
      const newMember = memberFromJoin(serverId, user);
      const d = state.directory;
      const unfiltered = d.serverId === serverId && !d.q && !d.role;
      // The directory ends with the newest joiner: append only when the list
      // is complete, or the row would come again with the next page.
      const directory = !unfiltered ? d : {
        ...d,
        total: d.total + 1,
        rows: !d.hasMore && !d.rows.some((m) => m.userId === user.id) ? [...d.rows, newMember] : d.rows,
      };
      return {
        members: [...state.members, newMember],
        people: {
          ...state.people,
          memberCount: state.people.memberCount + 1,
          onlineCount: state.people.onlineCount + (isOnline(newMember) ? 1 : 0),
        },
        directory,
      };
    });
  },

  removeMember: (serverId: string, userId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => {
      const row = state.members.find((m) => m.userId === userId);
      const d = state.directory;
      const listed = d.serverId === serverId;
      const directory = !listed ? d : {
        ...d,
        rows: d.rows.filter((m) => m.userId !== userId),
        // Unfiltered, the total is the membership; filtered, we cannot tell
        // whether they counted
        total: !d.q && !d.role ? Math.max(0, d.total - 1) : d.total,
      };
      return {
        members: row ? state.members.filter((m) => m.userId !== userId) : state.members,
        people: {
          ...state.people,
          memberCount: Math.max(0, state.people.memberCount - 1),
          onlineCount: row && isOnline(row) ? Math.max(0, state.people.onlineCount - 1) : state.people.onlineCount,
        },
        directory,
      };
    });
  },

  addChannel: (channel: Channel) => {
    if (get().activeServerId !== channel.serverId) return;
    set((state) => {
      if (state.channels.some((c) => c.id === channel.id)) return state;
      return { channels: [...state.channels, channel] };
    });
  },

  removeChannel: (channelId: string, serverId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== channelId),
      activeChannelId: state.activeChannelId === channelId ? null : state.activeChannelId,
    }));
  },

  updateChannelData: (channel: Channel) => {
    if (get().activeServerId !== channel.serverId) return;
    set((state) => ({
      channels: state.channels.map((c) => (c.id === channel.id ? channel : c)),
    }));
  },

  addCategory: (category: Category) => {
    if (get().activeServerId !== category.serverId) return;
    set((state) => {
      if (state.categories.some((c) => c.id === category.id)) return state;
      return { categories: [...state.categories, category] };
    });
  },

  updateCategory: (category: Category) => {
    if (get().activeServerId !== category.serverId) return;
    set((state) => ({
      categories: state.categories.map((c) => (c.id === category.id ? category : c)),
    }));
  },

  removeCategory: (categoryId: string, serverId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      categories: state.categories.filter((c) => c.id !== categoryId),
    }));
  },

  createCategory: async (serverId: string, name: string) => {
    const { data } = await api.post(`/servers/${serverId}/categories`, { name });
    return data.data;
  },

  deleteCategory: async (serverId: string, categoryId: string) => {
    await api.delete(`/servers/${serverId}/categories/${categoryId}`);
  },

  renameCategory: async (serverId: string, categoryId: string, name: string) => {
    await api.patch(`/servers/${serverId}/categories/${categoryId}`, { name });
  },

  fetchPeople: async (serverId: string) => {
    try {
      const { data } = await api.get(`/servers/${serverId}/members/online`);
      // Staleness guard — a slow response for the previous server must not
      // overwrite the member list of the server now being viewed
      if (get().activeServerId !== serverId) return;
      const rows = Array.isArray(data.data) ? (data.data as ServerMember[]) : [];
      // The lookup queue stays: ids asked for while this was in flight still
      // go out (the flush skips the ones the fresh slice now holds), and the
      // misses are still non-members. A directory page in flight is still
      // this server's.
      set({
        members: rows,
        people: {
          full: data.full !== false,
          truncated: data.truncated === true,
          onlineCount: typeof data.onlineCount === 'number' ? data.onlineCount : rows.filter(isOnline).length,
          memberCount: typeof data.memberCount === 'number' ? data.memberCount : rows.length,
          loaded: true,
        },
      });
    } catch (err) {
      console.error('Failed to fetch members:', err);
      if (get().activeServerId === serverId) {
        toast.error('Failed to load members');
      }
    }
  },

  ensureMembers: (userIds: string[]) => {
    if (!get().activeServerId) return;
    const known = new Set(get().members.map((m) => m.userId));
    let queued = false;
    for (const id of userIds) {
      if (!id || known.has(id) || lookupMisses.has(id) || lookupPending.has(id) || lookupInFlight.has(id)) continue;
      lookupPending.add(id);
      queued = true;
    }
    if (!queued || lookupTimer) return;
    lookupTimer = setTimeout(() => { lookupTimer = null; void flushMemberLookups(); }, Math.max(MEMBER_LOOKUP_DEBOUNCE_MS, lookupBackoffUntil - Date.now()));

    async function flushMemberLookups(): Promise<void> {
      const serverId = get().activeServerId;
      if (!serverId) { lookupPending.clear(); return; }
      // Ids a request is already out for are not taken again; ids a fresh
      // slice brought in meanwhile need no request at all
      const known = new Set(get().members.map((m) => m.userId));
      for (const id of lookupPending) if (known.has(id)) lookupPending.delete(id);
      const ids = [...lookupPending].filter((id) => !lookupInFlight.has(id)).slice(0, MEMBER_LIST.LOOKUP_MAX_IDS);
      if (ids.length === 0) return;
      for (const id of ids) lookupInFlight.add(id);
      try {
        const { data } = await api.get(`/servers/${serverId}/members/lookup`, { params: { ids: ids.join(',') } });
        // A server switch meanwhile reset the queue; these rows are the old server's
        if (get().activeServerId !== serverId) return;
        const rows = Array.isArray(data.data) ? (data.data as ServerMember[]) : [];
        const found = new Set(rows.map((r) => r.userId));
        for (const id of ids) {
          lookupPending.delete(id);
          if (!found.has(id)) lookupMisses.add(id);
        }
        lookupFailures = 0;
        if (rows.length) {
          set((state) => mergeKnownMembers(state, rows));
        }
      } catch (err) {
        // Not misses, and still queued: the retry goes out after the back-off
        // (nothing re-asks for a row it is already waiting on). A server that
        // keeps failing is not asked forever.
        lookupFailures++;
        lookupBackoffUntil = Date.now() + MEMBER_LOOKUP_BACKOFF_MS;
        if (lookupFailures >= MEMBER_LOOKUP_MAX_FAILURES) {
          console.warn(`[Members] Lookup failed ${lookupFailures} times, giving up on ${lookupPending.size} id(s):`, err);
          lookupPending.clear();
          lookupFailures = 0;
        } else {
          console.warn('[Members] Lookup failed, retrying after the back-off:', err);
        }
      } finally {
        for (const id of ids) lookupInFlight.delete(id);
        if (lookupPending.size > lookupInFlight.size && !lookupTimer && get().activeServerId === serverId) {
          lookupTimer = setTimeout(() => { lookupTimer = null; void flushMemberLookups(); }, Math.max(MEMBER_LOOKUP_DEBOUNCE_MS, lookupBackoffUntil - Date.now()));
        }
      }
    }
  },

  fetchDirectory: async (serverId, { q, role }) => {
    const generation = ++directoryGeneration;
    set({ directory: { serverId, rows: [], total: 0, nextCursor: null, hasMore: false, q, role, loading: true, error: false } });
    try {
      const { data } = await api.get(`/servers/${serverId}/members`, {
        params: { limit: LIMITS.MEMBERS_PER_PAGE, ...(q ? { q } : {}), ...(role ? { role } : {}) },
      });
      // A newer first page (another server, another search) owns the list now
      if (generation !== directoryGeneration) return;
      const page = directoryPage(data);
      set((state) => ({
        directory: { ...state.directory, ...page, loading: false },
        ...mergeKnownMembers(state, page.rows),
      }));
    } catch (err) {
      if (generation === directoryGeneration) set((state) => ({ directory: { ...state.directory, loading: false, error: true } }));
      throw err;
    }
  },

  fetchDirectoryMore: async (serverId) => {
    const d = get().directory;
    if (d.serverId !== serverId || !d.nextCursor || d.loading) return;
    const generation = directoryGeneration;
    set({ directory: { ...d, loading: true, error: false } });
    try {
      const { data } = await api.get(`/servers/${serverId}/members`, {
        params: { limit: LIMITS.MEMBERS_PER_PAGE, cursor: d.nextCursor, ...(d.q ? { q: d.q } : {}), ...(d.role ? { role: d.role } : {}) },
      });
      if (generation !== directoryGeneration) return;
      const page = directoryPage(data);
      set((state) => {
        const seen = new Set(state.directory.rows.map((m) => m.userId));
        return {
          directory: { ...state.directory, ...page, rows: [...state.directory.rows, ...page.rows.filter((m) => !seen.has(m.userId))], loading: false },
          ...mergeKnownMembers(state, page.rows),
        };
      });
    } catch (err) {
      if (generation === directoryGeneration) set((state) => ({ directory: { ...state.directory, loading: false, error: true } }));
      throw err;
    }
  },

  incrementUnread: (channelId: string, serverId: string) => {
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] || 0) + 1,
      },
      serverUnreadCounts: {
        ...state.serverUnreadCounts,
        [serverId]: (state.serverUnreadCounts[serverId] || 0) + 1,
      },
    }));
  },

  clearUnread: (channelId: string) => {
    const count = get().unreadCounts[channelId];
    if (!count) return;
    // Find which server this channel belongs to
    const channel = get().channels.find((c) => c.id === channelId);
    set((state) => {
      const restUnread = { ...state.unreadCounts };
      delete restUnread[channelId];
      const newServerUnread = { ...state.serverUnreadCounts };
      const sid = channel?.serverId || state.activeServerId;
      if (sid && newServerUnread[sid]) {
        newServerUnread[sid] = Math.max(0, newServerUnread[sid] - count);
        if (newServerUnread[sid] === 0) delete newServerUnread[sid];
      }
      return { unreadCounts: restUnread, serverUnreadCounts: newServerUnread };
    });
  },

  initUnreadCounts: (unreads: UnreadCount[]) => {
    const unreadCounts: Record<string, number> = {};
    const serverUnreadCounts: Record<string, number> = {};
    for (const u of unreads) {
      unreadCounts[u.channelId] = u.count;
      serverUnreadCounts[u.serverId] = (serverUnreadCounts[u.serverId] || 0) + u.count;
    }
    set({ unreadCounts, serverUnreadCounts });
  },

  markChannelRead: (channelId: string, hintServerId?: string) => {
    // Dedup: skip if same channel was marked within the last 2s (multiple code paths
    // can trigger this near-simultaneously on channel switch and reconnect)
    const now = Date.now();
    if (channelId === _lastMarkedChannel && now - _lastMarkedAt < 2000) return;
    _lastMarkedChannel = channelId;
    _lastMarkedAt = now;
    // Find the serverId for this channel — use hint when channels array may have changed (e.g. after server switch)
    const channel = get().channels.find((c) => c.id === channelId);
    const serverId = channel?.serverId || hintServerId || get().activeServerId;
    if (!serverId) return;
    // Retry once on failure to prevent stale lastReadAt causing phantom unreads on reconnect
    const url = `/servers/${serverId}/channels/${channelId}/read`;
    api.post(url).catch(() => {
      setTimeout(() => api.post(url).catch((err) => { console.warn('[Server] Mark-read retry failed:', err); }), 2000);
    });
  },

  uploadServerIcon: async (serverId: string, file: File) => {
    // 1. Get presigned PUT URL
    const { data: presignData } = await api.post(`/uploads/presign/server-icon/${serverId}`);
    const { uploadUrl, key } = presignData.data;

    // 2. Client-side resize + WebP conversion
    const blob = await processImage(file);

    // 3. Direct upload to S3
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/webp' },
    });
    if (!uploadRes.ok) {
      throw new Error(`S3 upload failed: ${uploadRes.status}`);
    }

    // 4. Confirm in DB (triggers old icon cleanup + socket broadcast)
    await api.patch(`/servers/${serverId}`, { iconUrl: key });
    // Local state updated via server:updated socket event
  },

  updateServer: async (serverId: string, fields) => {
    await api.patch(`/servers/${serverId}`, fields);
    // Local state updated via server:updated socket event
  },

  updateServerData: (server: Server) => {
    set((state) => ({
      servers: state.servers.map((s) => (s.id === server.id ? server : s)),
    }));
  },

  updateMemberAvatar: (userId: string, avatarUrl: string | null) => {
    set((state) => patchMemberEverywhere(state, userId, (m) => ({ ...m, user: { ...m.user, avatarUrl } })));
  },

  updateMemberProfile: (userId: string, fields: Record<string, unknown>) => {
    set((state) => patchMemberEverywhere(state, userId, (m) => ({ ...m, user: { ...m.user, ...fields } })));
  },

  reorderCategories: async (serverId: string, order: { id: string; position: number }[]) => {
    const prev = get().categories;
    // Optimistic update
    set((state) => ({
      categories: state.categories.map((c) => {
        const o = order.find((o) => o.id === c.id);
        return o ? { ...c, position: o.position } : c;
      }),
    }));
    try {
      await api.put(`/servers/${serverId}/categories/reorder`, { order });
    } catch {
      // Revert on failure
      set({ categories: prev });
    }
  },

  reorderChannels: async (serverId: string, order: { id: string; position: number; categoryId: string | null }[]) => {
    const prev = get().channels;
    // Optimistic update
    set((state) => ({
      channels: state.channels.map((c) => {
        const o = order.find((o) => o.id === c.id);
        return o ? { ...c, position: o.position, categoryId: o.categoryId } : c;
      }),
    }));
    try {
      await api.put(`/servers/${serverId}/channels/reorder`, { order });
    } catch {
      // Revert on failure
      set({ channels: prev });
    }
  },

  updateMemberRole: async (serverId: string, memberId: string, role: MemberRole) => {
    await api.patch(`/servers/${serverId}/members/${memberId}/role`, { role });
  },

  kickMember: async (serverId: string, memberId: string, reason?: string) => {
    await api.post(`/servers/${serverId}/members/${memberId}/kick`, reason ? { reason } : {});
    // Every removal is a ban and no socket event carries bans: with that
    // server's Banned section open, refetch so the row shows at once.
    if (get().bansServerId === serverId) {
      await get().fetchBans(serverId).catch((err) => console.warn('[Members] Failed to refresh the banned list:', err));
    }
  },

  transferOwnership: async (serverId: string, targetUserId: string) => {
    await api.post(`/servers/${serverId}/transfer-ownership`, { targetUserId });
  },

  deleteServer: async (serverId: string) => {
    await api.delete(`/servers/${serverId}`);
    // No local state update — socket event is source of truth
  },

  toggleInvitesLock: async (serverId: string, locked: boolean) => {
    await api.patch(`/servers/${serverId}/invites-lock`, { locked });
    // Local state updated via server:updated socket event
  },

  handleMemberRoleUpdated: (serverId: string, userId: string, role: MemberRole) => {
    if (get().activeServerId !== serverId) return;
    set((state) => patchMemberEverywhere(state, userId, (m) => ({ ...m, role })));
  },

  handleMemberKicked: (serverId: string) => {
    if (get().activeServerId === serverId) resetMemberLookupState();
    if (get().directory.serverId === serverId) retireDirectory();
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== serverId),
      activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
      channels: state.activeServerId === serverId ? [] : state.channels,
      categories: state.activeServerId === serverId ? [] : state.categories,
      members: state.activeServerId === serverId ? [] : state.members,
      people: state.activeServerId === serverId ? EMPTY_PEOPLE : state.people,
      directory: state.directory.serverId === serverId ? EMPTY_DIRECTORY : state.directory,
      activeChannelId: state.activeServerId === serverId ? null : state.activeChannelId,
    }));
  },

  handleServerDeleted: (serverId: string) => {
    set((state) => {
      const isActive = state.activeServerId === serverId;

      // Clean up server-level unread count
      const restServerUnread = { ...state.serverUnreadCounts };
      delete restServerUnread[serverId];

      // Clean up channel-level unread counts if this was the active server
      let newUnreadCounts = state.unreadCounts;
      if (isActive && state.channels.length > 0) {
        newUnreadCounts = { ...state.unreadCounts };
        for (const ch of state.channels) {
          delete newUnreadCounts[ch.id];
        }
      }

      if (isActive) resetMemberLookupState();
      if (state.directory.serverId === serverId) retireDirectory();
      return {
        servers: state.servers.filter((s) => s.id !== serverId),
        activeServerId: isActive ? null : state.activeServerId,
        channels: isActive ? [] : state.channels,
        categories: isActive ? [] : state.categories,
        members: isActive ? [] : state.members,
        people: isActive ? EMPTY_PEOPLE : state.people,
        directory: state.directory.serverId === serverId ? EMPTY_DIRECTORY : state.directory,
        roles: isActive ? [] : state.roles,
        activeChannelId: isActive ? null : state.activeChannelId,
        unreadCounts: newUnreadCounts,
        serverUnreadCounts: restServerUnread,
      };
    });
  },

  // ─── Roles ──────────────────────────────────────────────────────────────────

  fetchRoles: async (serverId: string) => {
    try {
      const { data } = await api.get(`/servers/${serverId}/roles`);
      // Staleness guard — don't overwrite the currently-viewed server's roles
      if (get().activeServerId !== serverId) return;
      set({ roles: data.data });
    } catch (err) {
      console.error('Failed to fetch roles:', err);
    }
  },

  createRole: async (serverId: string, name: string, color?: string, permissions?: string) => {
    const { data } = await api.post(`/servers/${serverId}/roles`, { name, color, permissions });
    return data.data;
  },

  updateRole: async (serverId: string, roleId: string, fields) => {
    await api.patch(`/servers/${serverId}/roles/${roleId}`, fields);
  },

  deleteRole: async (serverId: string, roleId: string) => {
    await api.delete(`/servers/${serverId}/roles/${roleId}`);
  },

  reorderRoles: async (serverId: string, order) => {
    await api.put(`/servers/${serverId}/roles/reorder`, { order });
  },

  assignMemberRoles: async (serverId: string, memberId: string, roleIds: string[]) => {
    await api.patch(`/servers/${serverId}/roles/members/${memberId}`, { roleIds });
  },

  handleRoleCreated: (serverId: string, role: Role) => {
    if (get().activeServerId !== serverId) return;
    set((state) => {
      if (state.roles.some((r) => r.id === role.id)) return state;
      return { roles: [...state.roles, role].sort((a, b) => a.position - b.position) };
    });
  },

  handleRoleUpdated: (serverId: string, role: Role) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      roles: state.roles.map((r) => (r.id === role.id ? role : r)),
    }));
  },

  handleRoleDeleted: (serverId: string, roleId: string) => {
    if (get().activeServerId !== serverId) return;
    const strip = (m: ServerMember): ServerMember => ({ ...m, roles: m.roles?.filter((r) => r.id !== roleId) });
    set((state) => ({
      roles: state.roles.filter((r) => r.id !== roleId),
      // Remove role from members
      members: state.members.map(strip),
      directory: state.directory.serverId === serverId ? { ...state.directory, rows: state.directory.rows.map(strip) } : state.directory,
    }));
  },

  handleRoleReordered: (serverId: string, roles: { id: string; position: number }[]) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      roles: state.roles.map((r) => {
        const updated = roles.find((u) => u.id === r.id);
        return updated ? { ...r, position: updated.position } : r;
      }).sort((a, b) => a.position - b.position),
    }));
  },

  handleMemberRolesUpdated: (serverId: string, userId: string, roleIds: string[]) => {
    if (get().activeServerId !== serverId) return;
    const allRoles = get().roles;
    const assignedRoles = allRoles.filter((r) => roleIds.includes(r.id));
    set((state) => patchMemberEverywhere(state, userId, (m) => ({ ...m, roles: assignedRoles })));
  },

  // ─── Channel Permissions ──────────────────────────────────────────────────

  fetchChannelPermissions: async (serverId: string, channelId: string) => {
    const { data } = await api.get(`/servers/${serverId}/roles/channels/${channelId}/permissions`);
    return data.data;
  },

  setChannelPermissionOverride: async (serverId: string, channelId: string, roleId: string, allow: string, deny: string) => {
    await api.put(`/servers/${serverId}/roles/channels/${channelId}/permissions/${roleId}`, { allow, deny });
  },

  deleteChannelPermissionOverride: async (serverId: string, channelId: string, roleId: string) => {
    await api.delete(`/servers/${serverId}/roles/channels/${channelId}/permissions/${roleId}`);
  },

  fetchEffectivePermissions: async (serverId: string, channelId?: string) => {
    const params = channelId ? `?channelId=${channelId}` : '';
    const { data } = await api.get(`/servers/${serverId}/roles/permissions/effective${params}`);
    return data.data.permissions;
  },

  // ─── Nicknames ──────────────────────────────────────────────────────────────

  setNickname: async (serverId: string, nickname: string | null) => {
    await api.patch(`/servers/${serverId}/nickname`, { nickname });
  },

  setMemberNickname: async (serverId: string, memberId: string, nickname: string | null) => {
    await api.patch(`/servers/${serverId}/members/${memberId}/nickname`, { nickname });
  },

  handleNicknameUpdated: (serverId: string, userId: string, nickname: string | null) => {
    if (get().activeServerId !== serverId) return;
    set((state) => patchMemberEverywhere(state, userId, (m) => ({ ...m, nickname })));
  },

  // ─── Secure channels ────────────────────────────────────────────────────────

  secureChannelMembers: {},

  createSecureChannel: async (serverId: string, name: string, memberIds: string[], type: 'text' | 'voice' = 'text') => {
    const { data } = await api.post(`/servers/${serverId}/secure-channels`, { name, memberIds, type });
    // Sidebar entry arrives via the member-scoped channel:created event
    return data.data;
  },

  renameSecureChannel: async (serverId: string, channelId: string, name: string) => {
    await api.patch(`/servers/${serverId}/secure-channels/${channelId}`, { name });
  },

  inviteSecureChannelMember: async (serverId: string, channelId: string, userId: string) => {
    await api.post(`/servers/${serverId}/secure-channels/${channelId}/members`, { userId });
  },

  removeSecureChannelMember: async (serverId: string, channelId: string, userId: string) => {
    await api.delete(`/servers/${serverId}/secure-channels/${channelId}/members/${userId}`);
  },

  leaveSecureChannel: async (serverId: string, channelId: string, selfUserId: string) => {
    await api.delete(`/servers/${serverId}/secure-channels/${channelId}/members/${selfUserId}`);
    // Our own channel:deleted event removes the sidebar entry; drop the cached
    // member list now so a re-invite starts fresh
    set((state) => {
      const next = { ...state.secureChannelMembers };
      delete next[channelId];
      return { secureChannelMembers: next };
    });
  },

  fetchSecureChannelMembers: async (serverId: string, channelId: string) => {
    const { data } = await api.get(`/servers/${serverId}/secure-channels/${channelId}/members`);
    const members = data.data as SecureChannelMember[];
    set((state) => ({
      secureChannelMembers: { ...state.secureChannelMembers, [channelId]: members },
    }));
    return members;
  },

  fetchSecureChannelCount: async (serverId: string) => {
    const { data } = await api.get(`/servers/${serverId}/secure-channels/count`);
    return data.data.count as number;
  },

  // ─── Server discovery (owner side) ─────────────────────────────────────────

  joinRequestCounts: {},
  joinRequests: [],
  joinRequestsServerId: null,
  joinRequestsTruncated: false,
  bans: [],
  bansServerId: null,

  updateDiscovery: async (serverId, fields) => {
    await api.patch(`/servers/${serverId}/discovery`, fields);
    // Local state updated via server:updated socket event
  },

  fetchDiscoveryInfo: async (serverId) => {
    // The owner's endpoint: the member-facing detail route no longer carries
    // the curation state or the figures.
    const { data } = await api.get(`/servers/${serverId}/discovery`);
    const d = data.data;
    return {
      memberCount: typeof d.memberCount === 'number' ? d.memberCount : 0,
      onlineCount: typeof d.onlineCount === 'number' ? d.onlineCount : 0,
      weeklyMessages: typeof d.weeklyMessages === 'number' ? d.weeklyMessages : 0,
      statsRefreshedAt: d.statsRefreshedAt ?? null,
      discoveryListed: d.discoveryListed !== false,
      discoveryBlockedAt: d.discoveryBlockedAt ?? null,
      featuredAt: d.featuredAt ?? null,
      activityScore: typeof d.activityScore === 'number' ? d.activityScore : 0,
      tier: isDiscoveryTier(d.tier) ? d.tier : null,
      nextTier: d.nextTier && isDiscoveryTier(d.nextTier.tier) && typeof d.nextTier.score === 'number'
        ? { tier: d.nextTier.tier, score: d.nextTier.score }
        : null,
      tiersAvailable: d.tiersAvailable === true,
      tierThresholds: isTierThresholdMap(d.tierThresholds) ? d.tierThresholds : null,
    };
  },

  fetchJoinRequests: async (serverId) => {
    // Claim the list for this server BEFORE the request: a section that
    // opens for another server meanwhile wins, and this response is dropped
    // (same staleness rule as setActiveServer / fetchPeople).
    set((state) => (state.joinRequestsServerId === serverId ? state : { joinRequests: [], joinRequestsServerId: serverId, joinRequestsTruncated: false }));
    const { rows, total } = await fetchAllPages<ServerJoinRequest>(`/servers/${serverId}/join-requests`);
    set((state) => {
      if (state.joinRequestsServerId !== serverId) return state;
      return {
        joinRequests: rows,
        joinRequestsTruncated: total > rows.length,
        joinRequestCounts: { ...state.joinRequestCounts, [serverId]: total },
      };
    });
  },

  approveJoinRequest: async (serverId, userId) => {
    await decideJoinRequest(get, serverId, userId, 'approve');
  },

  declineJoinRequest: async (serverId, userId) => {
    await decideJoinRequest(get, serverId, userId, 'decline');
  },

  handleJoinRequest: (serverId, request) => {
    if (typeof serverId !== 'string' || !isServerJoinRequest(request) || request.serverId !== serverId) return;
    // A fresh request from someone we resolved earlier: the old mark is spent
    locallyResolved.delete(`${serverId}:${request.userId}`);
    set((state) => {
      const listed = state.joinRequestsServerId === serverId;
      const known = listed && state.joinRequests.some((r) => r.id === request.id || r.userId === request.userId);
      if (known) return state;
      return {
        joinRequests: listed ? [...state.joinRequests, request] : state.joinRequests,
        joinRequestCounts: { ...state.joinRequestCounts, [serverId]: (state.joinRequestCounts[serverId] || 0) + 1 },
      };
    });
  },

  handleJoinRequestResolved: (serverId, userId) => {
    if (typeof serverId !== 'string' || typeof userId !== 'string') return;
    const key = `${serverId}:${userId}`;
    set((state) => {
      const listed = state.joinRequestsServerId === serverId;
      const had = listed && state.joinRequests.some((r) => r.userId === userId);
      if (listed && !had) {
        // The socket echo of our own approve / decline: that row and its
        // count already moved when we applied it.
        if (locallyResolved.delete(key)) return state;
        // A complete list that never had this user: a stale event, not a row
        // we are missing. A list cut at the page cap can be missing it, and
        // then the badge (the server's total) still has to move.
        if (!state.joinRequestsTruncated) return state;
      }
      const next = Math.max(0, (state.joinRequestCounts[serverId] || 0) - 1);
      const joinRequestCounts = { ...state.joinRequestCounts };
      if (next === 0) delete joinRequestCounts[serverId]; else joinRequestCounts[serverId] = next;
      return {
        joinRequests: had ? state.joinRequests.filter((r) => r.userId !== userId) : state.joinRequests,
        joinRequestCounts,
      };
    });
  },

  fetchBans: async (serverId) => {
    set((state) => (state.bansServerId === serverId ? state : { bans: [], bansServerId: serverId }));
    const { rows } = await fetchAllPages<ServerBan>(`/servers/${serverId}/bans`);
    set((state) => (state.bansServerId !== serverId ? state : { bans: rows }));
  },

  unbanMember: async (serverId, userId) => {
    const drop = () => set((state) => (state.bansServerId !== serverId ? state : { bans: state.bans.filter((b) => b.userId !== userId) }));
    try {
      await api.delete(`/servers/${serverId}/bans/${userId}`);
    } catch (err) {
      // No event carries bans: a 404 means another moderator lifted it already
      if (axios.isAxiosError(err) && err.response?.status === 404) drop();
      throw err;
    }
    drop();
  },

  handleChannelMembersUpdated: (payload) => {
    // Socket payloads are unauthenticated JSON as far as this client knows —
    // validate shape before it can reach any component
    if (typeof payload?.channelId !== 'string' || typeof payload?.serverId !== 'string') return;
    if (!Array.isArray(payload.members)) return;
    const members = (payload.members as unknown[]).filter(
      (m): m is SecureChannelMember =>
        !!m && typeof m === 'object' &&
        typeof (m as SecureChannelMember).userId === 'string' &&
        typeof (m as SecureChannelMember).isCreator === 'boolean',
    );
    const channelId = payload.channelId;
    set((state) => ({
      secureChannelMembers: { ...state.secureChannelMembers, [channelId]: members },
    }));

    // Secure VOICE channels: a membership change is the rotation HINT — the
    // decision is confirmed against the authoritative endpoint inside
    // confirmMembership, never trusted from this socket event (spec §21).
    // No-op for channels without an active secure voice session.
    void import('../services/e2e/secureVoiceKeys')
      .then((m) => m.confirmMembership(channelId))
      .catch((err) => console.warn('[SecureVoice] Membership confirmation failed:', err));
  },
}));
