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
  totpEnabled: boolean;
  emailVerified: boolean;
  isSupporter: boolean;
  supporterTier: SupporterTier;
  createdAt: string;
}

export type SupporterTier = 'first' | 'top' | null;

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** User without private fields — safe for broadcasting to other clients */
export type PublicUser = Omit<User, 'email' | 'totpEnabled' | 'emailVerified'>;

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
  invitesLocked: boolean;
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

export interface Attachment {
  id: string;
  s3Key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  expired: boolean;
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
  mentions?: MessageAuthor[];
  attachments?: Attachment[];
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionGroup[];
}

export interface MessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role?: UserRole;
  isSupporter?: boolean;
  supporterTier?: SupporterTier;
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
  serverMuted: boolean;
  serverDeafened: boolean;
  speaking: boolean;
  screenSharing?: boolean;
}

// ─── mediasoup SFU ──────────────────────────────────────────────────────────

/**
 * Transport parameters sent from server to client on voice:transport_created.
 * Uses `unknown` for mediasoup internal types to avoid coupling shared package
 * to mediasoup — the client casts to mediasoup-client types, the server uses
 * mediasoup/node types.
 */
export interface TransportOptions {
  id: string;
  iceParameters: Record<string, unknown>;
  iceCandidates: Record<string, unknown>[];
  dtlsParameters: Record<string, unknown>;
}

export interface ConsumerOptions {
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: Record<string, unknown>;
  producerUserId: string;
  appData?: Record<string, unknown>;
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
  'voice:state_update': (data: { channelId: string; userId: string; selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean }) => void;
  'voice:speaking': (data: { channelId: string; userId: string; speaking: boolean }) => void;
  'voice:signal': (data: { from: string; signal: unknown }) => void;
  'voice:force_moved': (data: { channelId: string; userId: string; targetChannelId: string }) => void;
  'voice:error': (data: { message: string }) => void;
  'voice:transport_created': (data: {
    routerRtpCapabilities: unknown;
    sendTransport: TransportOptions;
    recvTransport: TransportOptions;
  }) => void;
  'voice:new_consumer': (data: ConsumerOptions) => void;
  'voice:producer_closed': (data: { consumerId: string; producerUserId: string }) => void;
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
  'user:updated': (data: { userId: string; displayName?: string; avatarUrl?: string | null; role?: string; isSupporter?: boolean; supporterTier?: string | null }) => void;
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
  'member:roles_updated': (data: { serverId: string; userId: string; roleIds: string[] }) => void;
  'role:created': (data: { serverId: string; role: Role }) => void;
  'role:updated': (data: { serverId: string; role: Role }) => void;
  'role:deleted': (data: { serverId: string; roleId: string }) => void;
  'role:reordered': (data: { serverId: string; roles: { id: string; position: number }[] }) => void;
  'channel:permissions_updated': (data: { serverId: string; channelId: string; overrides: ChannelPermissionOverride[] }) => void;
  'member:nickname_updated': (data: { serverId: string; userId: string; nickname: string | null }) => void;
  'member:kicked': (data: { serverId: string; userId: string }) => void;
  'server:deleted': (data: { serverId: string }) => void;
  'voice:screen_share:start': (data: { channelId: string; userId: string }) => void;
  'voice:screen_share:stop': (data: { channelId: string; userId: string }) => void;
  'voice:screen_share:state': (data: { channelId: string; sharingUserId: string | null }) => void;
  'announcement:new': (announcement: Announcement) => void;
  'announcement:init': (data: { announcements: Announcement[] }) => void;
  'admin:metrics': (data: AdminMetricsSnapshot) => void;
  'report:new': (data: { total: number }) => void;
  'force:logout': (data: { reason: string }) => void;
  'support:message:new': (message: SupportMessageData) => void;
  'support:status_change': (data: { ticketId: string; status: SupportTicketStatus; claimedById?: string; claimedByUsername?: string }) => void;
  'support:ticket:new': (data: { total: number }) => void;
  // Community Themes
  'theme:published': (theme: CommunityTheme) => void;
  'theme:updated': (theme: CommunityTheme) => void;
  'theme:removed': (data: { themeId: string }) => void;
  // Custom Emojis
  'emoji:init': (data: { emojis: CustomEmoji[] }) => void;
  'emoji:created': (data: { serverId: string; emoji: CustomEmoji }) => void;
  'emoji:deleted': (data: { serverId: string; emojiId: string }) => void;
  // Stickers
  'sticker:init': (data: { serverPacks: StickerPackData[]; personalPacks: StickerPackData[] }) => void;
  'sticker:pack_created': (data: { pack: StickerPackData }) => void;
  'sticker:pack_deleted': (data: { packId: string; serverId?: string }) => void;
  'sticker:added': (data: { packId: string; sticker: StickerData }) => void;
  'sticker:removed': (data: { packId: string; stickerId: string }) => void;
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
  'voice:transport:connect': (data: { transportId: string; dtlsParameters: unknown }, callback: (response: { error?: string }) => void) => void;
  'voice:produce': (
    data: { kind: 'audio' | 'video'; rtpParameters: unknown; appData?: Record<string, unknown> },
    callback: (response: { producerId: string }) => void,
  ) => void;
  'voice:consumer:resume': (data: { consumerId: string }) => void;
  'voice:rtp_capabilities': (data: { rtpCapabilities: unknown }) => void;
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
  'voice:server_mute': (data: { userId: string; muted: boolean }) => void;
  'voice:server_deafen': (data: { userId: string; deafened: boolean }) => void;
  'voice:force_move': (data: { userId: string; targetChannelId: string }) => void;
  'voice:screen_share:start': () => void;
  'voice:screen_share:stop': () => void;
  'admin:subscribe_metrics': () => void;
  'admin:unsubscribe_metrics': () => void;
  'admin:subscribe_reports': () => void;
  'admin:unsubscribe_reports': () => void;
  'admin:subscribe_support': () => void;
  'admin:unsubscribe_support': () => void;
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
  nickname: string | null;
  joinedAt: string;
  user: PublicUser;
  roles?: Role[];
}

// ─── Roles & Permissions ────────────────────────────────────────────────────

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: string; // bigint as decimal string
  isDefault: boolean;
  createdAt: string;
}

export interface ChannelPermissionOverride {
  id: string;
  channelId: string;
  roleId: string;
  allow: string; // bigint as decimal string
  deny: string;  // bigint as decimal string
  role?: Role;
}

export interface EffectivePermissions {
  permissions: string; // bigint as decimal string
  source: 'owner' | 'computed';
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
  isSupporter: boolean;
  supporterTier: SupporterTier;
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
  pendingReports: number;
  openTickets: number;
  totalConversations: number;
  totalFriendships: number;
}

export interface GeoStat {
  countryCode: string;
  country: string;
  count: number;
}

export interface AdminMetricsSnapshot {
  onlineUsers: number;
  voiceChannels: number;
  voiceUsers: number;
  dmCalls: number;
  dmVoiceUsers: number;
  messagesLastHour: number;
}

export interface SfuWorkerStats {
  pid: number;
  routerCount: number;
  transportCount: number;
  /** User CPU time in ms */
  cpuUser: number;
  /** System CPU time in ms */
  cpuSystem: number;
  /** Max resident set size in KB */
  memoryRss: number;
}

export interface SfuStats {
  workers: SfuWorkerStats[];
  totalRouters: number;
  portRange: { min: number; max: number; total: number };
}

export interface SfuMediaCounts {
  totalTransports: number;
  totalProducers: number;
  totalConsumers: number;
}

// ─── Infrastructure Server Locations ─────────────────────────────────────

export interface InfraServer {
  id: string;
  name: string;
  country: string;
  city: string;
  provider: string;
  latitude: number;
  longitude: number;
  createdAt: string;
}

// ─── Resource Limits ─────────────────────────────────────────────────────

export interface ResourceLimits {
  maxChannelsPerServer: number;
  maxVoiceUsersPerChannel: number;
  maxCategoriesPerServer: number;
  maxMembersPerServer: number; // 0 = unlimited
}

export interface ServerResourceLimits {
  maxChannelsPerServer: number | null;
  maxVoiceUsersPerChannel: number | null;
  maxCategoriesPerServer: number | null;
  maxMembersPerServer: number | null;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  avatarCount: number;
  avatarSize: number;
  serverIconCount: number;
  serverIconSize: number;
  attachmentCount: number;
  attachmentSize: number;
  emojiCount: number;
  emojiSize: number;
  stickerCount: number;
  stickerSize: number;
  gifCount: number;
  gifSize: number;
  orphanCount: number;
  orphanSize: number;
}

export type StorageFileType = 'avatar' | 'server-icon' | 'attachment' | 'emoji' | 'sticker' | 'gif';

export interface StorageFile {
  key: string;
  type: StorageFileType;
  size: number;
  lastModified: string | null;
  linkedEntity: string | null;
  linkedEntityId: string | null;
  isOrphan: boolean;
  isExpired?: boolean;
}

export interface StorageTopUploader {
  entityId: string;
  entityName: string;
  type: 'user' | 'server';
  fileCount: number;
  totalSize: number;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export type ReportStatus = 'pending' | 'resolved' | 'dismissed';
export type ReportType = 'message' | 'user';

export interface Report {
  id: string;
  type: ReportType;
  status: ReportStatus;
  reason: string;
  reporterId: string;
  reporterUsername: string;
  reportedUserId: string;
  reportedUsername: string;
  messageId: string | null;
  messageContent: string | null;
  channelId: string | null;
  conversationId: string | null;
  serverId: string | null;
  resolvedById: string | null;
  resolvedByUsername: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ─── Support Tickets ────────────────────────────────────────────────────────

export type SupportTicketStatus = 'open' | 'claimed' | 'closed';

export interface SupportTicket {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: SupportTicketStatus;
  claimedById: string | null;
  claimedByUsername: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessageData {
  id: string;
  ticketId: string;
  authorId: string;
  content: string;
  type: 'user' | 'system';
  createdAt: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: UserRole;
  };
}

// ─── Community Themes ────────────────────────────────────────────────────────

export type ThemeColors = Record<import('./constants.js').ThemeColorKey, string>;

export type ThemeStatus = 'draft' | 'published' | 'removed';

export interface ThemePattern {
  type: import('./constants.js').ThemePatternType;
  color: string;
  opacity: number;
  size?: number;
  angle?: number;
  svgData?: string;
}

export type ThemePatterns = Partial<Record<import('./constants.js').ThemePatternArea, ThemePattern>>;

export interface CommunityThemeData {
  name: string;
  description: string;
  tags: string[];
  colors: ThemeColors;
  patterns?: ThemePatterns;
  version: number;
}

export interface CommunityTheme extends CommunityThemeData {
  id: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  status: ThemeStatus;
  installCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Custom Emojis ──────────────────────────────────────────────────────────

export interface CustomEmoji {
  id: string;
  serverId: string;
  name: string;
  s3Key: string;
  animated: boolean;
  creatorId: string;
  createdAt: string;
}

// ─── Stickers ───────────────────────────────────────────────────────────────

export interface StickerData {
  id: string;
  packId: string;
  name: string;
  s3Key: string;
  createdAt: string;
}

export interface StickerPackData {
  id: string;
  name: string;
  description: string;
  serverId: string | null;
  userId: string | null;
  stickers: StickerData[];
  createdAt: string;
}

// ─── GIFs ───────────────────────────────────────────────────────────────────

export interface GiphyGif {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface GifUploadData {
  id: string;
  s3Key: string;
  fileName: string;
  fileSize: number;
  tags: string[];
  uploaderId: string;
  createdAt: string;
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export type AuditAction =
  | 'user.ban' | 'user.unban' | 'user.delete' | 'user.role_change'
  | 'server.delete'
  | 'ip_ban.create' | 'ip_ban.delete'
  | 'storage.file_delete' | 'storage.cleanup_orphans'
  | 'announcement.create' | 'announcement.publish' | 'announcement.delete'
  | 'report.resolve' | 'report.dismiss'
  | 'support.claim' | 'support.close'
  | 'ratelimit.update' | 'ratelimit.reset' | 'ratelimit.clear_user'
  | 'feature_flag.update' | 'feature_flag.reset';

// ─── Announcements ─────────────────────────────────────────────────────────

export type AnnouncementType = 'info' | 'warning' | 'maintenance';
export type AnnouncementScope = 'global' | 'servers';

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  scope: AnnouncementScope;
  serverIds: string[];
  createdById: string;
  createdByUsername: string;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

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
