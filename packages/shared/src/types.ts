// ─── User ────────────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'admin' | 'superadmin';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
}

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** User without email — safe for broadcasting to other clients */
export type PublicUser = Omit<User, 'email'>;

export interface UserProfile extends User {
  bio: string | null;
  servers: ServerSummary[];
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}

// ─── Server ──────────────────────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  createdAt: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface ServerDetail extends Server {
  channels: Channel[];
  categories: Category[];
  memberCount: number;
}

export interface CreateServerRequest {
  name: string;
}

// ─── Category ───────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  serverId: string;
  position: number;
  createdAt: string;
}

// ─── Channel ─────────────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  serverId: string;
  categoryId: string | null;
  position: number;
  createdAt: string;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
  categoryId?: string;
}

// ─── Message ─────────────────────────────────────────────────────────────────

export interface ReactionGroup {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface Message {
  id: string;
  content: string;
  type?: string;
  channelId: string | null;
  conversationId?: string | null;
  replyToId?: string | null;
  replyTo?: {
    id: string;
    content: string;
    author: MessageAuthor;
  } | null;
  author: MessageAuthor;
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionGroup[];
}

export interface MessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SendMessageRequest {
  content: string;
}

// ─── Voice ───────────────────────────────────────────────────────────────────

export interface VoiceState {
  userId: string;
  channelId: string;
  serverId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface VoiceUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  speaking: boolean;
  screenSharing?: boolean;
}

// ─── Unread ─────────────────────────────────────────────────────────────────

export interface UnreadCount {
  channelId: string;
  serverId: string;
  count: number;
}

// ─── Direct Messages ────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  user1Id: string;
  user2Id: string;
  participant: MessageAuthor; // the OTHER user (populated at query time)
  lastMessage: { content: string; createdAt: string; authorId: string } | null;
  createdAt: string;
}

export interface DMUnreadCount {
  conversationId: string;
  count: number;
}

// ─── Friendships ────────────────────────────────────────────────────────────

export type FriendshipStatus = 'pending' | 'accepted';

export interface FriendUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: UserStatus;
}

export interface Friendship {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
  createdAt: string;
  user: FriendUser; // the OTHER user
}

// ─── WebSocket Events ────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'message:new': (message: Message) => void;
  'message:update': (message: Message) => void;
  'message:delete': (data: { messageId: string; channelId: string }) => void;
  'channel:created': (channel: Channel) => void;
  'channel:updated': (channel: Channel) => void;
  'channel:deleted': (data: { channelId: string; serverId: string }) => void;
  'category:created': (category: Category) => void;
  'category:updated': (category: Category) => void;
  'category:deleted': (data: { categoryId: string; serverId: string }) => void;
  'member:joined': (data: { serverId: string; user: PublicUser }) => void;
  'member:left': (data: { serverId: string; userId: string }) => void;
  'presence:update': (data: { userId: string; status: UserStatus }) => void;
  'voice:channel_users': (data: { channelId: string; users: VoiceUser[] }) => void;
  'voice:user_joined': (data: { channelId: string; user: VoiceUser }) => void;
  'voice:user_left': (data: { channelId: string; userId: string }) => void;
  'voice:state_update': (data: { channelId: string; userId: string; selfMute: boolean; selfDeaf: boolean }) => void;
  'voice:speaking': (data: { channelId: string; userId: string; speaking: boolean }) => void;
  'voice:signal': (data: { from: string; signal: unknown }) => void;
  'pong:latency': (timestamp: number) => void;
  'typing:start': (data: { channelId: string; userId: string; username: string }) => void;
  'typing:stop': (data: { channelId: string; userId: string }) => void;
  'message:reaction_update': (data: {
    messageId: string;
    channelId: string;
    emoji: string;
    userId: string;
    action: 'add' | 'remove';
    reactions: ReactionGroup[];
  }) => void;
  'server:updated': (server: Server) => void;
  'user:updated': (data: { userId: string; displayName: string; avatarUrl: string | null }) => void;
  'unread:init': (data: { unreads: UnreadCount[] }) => void;
  'dm:message:new': (message: Message) => void;
  'dm:message:update': (message: Message) => void;
  'dm:message:delete': (data: { messageId: string; conversationId: string }) => void;
  'dm:typing:start': (data: { conversationId: string; userId: string; username: string }) => void;
  'dm:typing:stop': (data: { conversationId: string; userId: string }) => void;
  'dm:message:reaction_update': (data: {
    messageId: string;
    conversationId: string;
    emoji: string;
    userId: string;
    action: 'add' | 'remove';
    reactions: ReactionGroup[];
  }) => void;
  'dm:unread:init': (data: { unreads: DMUnreadCount[] }) => void;
  'dm:voice:offer': (data: { conversationId: string; from: VoiceUser }) => void;
  'dm:voice:joined': (data: { conversationId: string; user: VoiceUser }) => void;
  'dm:voice:left': (data: { conversationId: string; userId: string }) => void;
  'dm:voice:state_update': (data: { conversationId: string; userId: string; selfMute: boolean; selfDeaf: boolean }) => void;
  'dm:voice:speaking': (data: { conversationId: string; userId: string; speaking: boolean }) => void;
  'dm:voice:signal': (data: { from: string; signal: unknown }) => void;
  'dm:voice:ended': (data: { conversationId: string }) => void;
  'dm:conversation:deleted': (data: { conversationId: string }) => void;
  'friend:request_received': (data: { friendship: Friendship }) => void;
  'friend:request_accepted': (data: { friendship: Friendship }) => void;
  'friend:removed': (data: { userId: string }) => void;
  'member:role_updated': (data: { serverId: string; userId: string; role: MemberRole }) => void;
  'member:kicked': (data: { serverId: string; userId: string }) => void;
  'server:deleted': (data: { serverId: string }) => void;
  'voice:screen_share:start': (data: { channelId: string; userId: string }) => void;
  'voice:screen_share:stop': (data: { channelId: string; userId: string }) => void;
  'voice:screen_share:state': (data: { channelId: string; sharingUserId: string | null }) => void;
  'admin:metrics': (data: AdminMetricsSnapshot) => void;
  'force:logout': (data: { reason: string }) => void;
}

export interface ClientToServerEvents {
  'channel:join': (channelId: string) => void;
  'channel:leave': (channelId: string) => void;
  'voice:join': (channelId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => void;
  'voice:leave': () => void;
  'voice:mute': (muted: boolean) => void;
  'voice:deaf': (deafened: boolean) => void;
  'voice:speaking': (speaking: boolean) => void;
  'voice:signal': (data: { to: string; signal: unknown }) => void;
  'ping:latency': (timestamp: number) => void;
  'typing:start': (channelId: string) => void;
  'typing:stop': (channelId: string) => void;
  'dm:join': (conversationId: string) => void;
  'dm:typing:start': (conversationId: string) => void;
  'dm:typing:stop': (conversationId: string) => void;
  'dm:voice:join': (conversationId: string, state?: { selfMute: boolean; selfDeaf: boolean }) => void;
  'dm:voice:leave': (conversationId: string) => void;
  'dm:voice:mute': (muted: boolean) => void;
  'dm:voice:deaf': (deafened: boolean) => void;
  'dm:voice:speaking': (speaking: boolean) => void;
  'dm:voice:signal': (data: { to: string; signal: unknown }) => void;
  'dm:voice:decline': (conversationId: string) => void;
  'voice:screen_share:start': () => void;
  'voice:screen_share:stop': () => void;
  'admin:subscribe_metrics': () => void;
  'admin:unsubscribe_metrics': () => void;
}

// ─── API Response ────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// ─── Server Member ───────────────────────────────────────────────────────────

export type MemberRole = 'owner' | 'admin' | 'member';

export interface ServerMember {
  userId: string;
  serverId: string;
  role: MemberRole;
  joinedAt: string;
  user: PublicUser;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  content: string;
  type?: string;
  channelId: string | null;
  conversationId?: string | null;
  author: MessageAuthor;
  createdAt: string;
  editedAt: string | null;
  channelName?: string;
}

// ─── Invite ──────────────────────────────────────────────────────────────────

export interface Invite {
  code: string;
  serverId: string;
  createdBy: string;
  expiresAt: string | null;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  bannedAt: string | null;
  banReason: string | null;
  createdAt: string;
}

export interface AdminServer {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  ownerUsername: string;
  memberCount: number;
  channelCount: number;
  messageCount: number;
  createdAt: string;
}

export interface BanRecord {
  id: string;
  username: string;
  displayName: string;
  email: string;
  bannedAt: string;
  banReason: string | null;
}

export interface IpBanRecord {
  id: string;
  ip: string;
  reason: string | null;
  bannedBy: string;
  bannedByUsername: string;
  createdAt: string;
}

export interface AdminDashboardStats {
  totalUsers: number;
  totalServers: number;
  totalMessages: number;
  onlineUsers: number;
  bannedUsers: number;
}

export interface AdminMetricsSnapshot {
  onlineUsers: number;
  voiceChannels: number;
  voiceUsers: number;
  dmCalls: number;
  dmVoiceUsers: number;
  messagesLastHour: number;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  avatarCount: number;
  avatarSize: number;
  serverIconCount: number;
  serverIconSize: number;
  orphanCount: number;
  orphanSize: number;
}

export interface StorageFile {
  key: string;
  type: 'avatar' | 'server-icon';
  size: number;
  lastModified: string;
  linkedEntity: string | null;
  linkedEntityId: string | null;
  isOrphan: boolean;
}

export interface StorageTopUploader {
  entityId: string;
  entityName: string;
  type: 'user' | 'server';
  fileCount: number;
  totalSize: number;
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export type AuditAction =
  | 'user.ban' | 'user.unban' | 'user.delete' | 'user.role_change'
  | 'server.delete'
  | 'ip_ban.create' | 'ip_ban.delete'
  | 'storage.file_delete' | 'storage.cleanup_orphans';

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  action: AuditAction;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
