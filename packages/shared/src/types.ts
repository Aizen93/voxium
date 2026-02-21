// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  status: UserStatus;
  createdAt: string;
}

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

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
  memberCount: number;
}

export interface CreateServerRequest {
  name: string;
}

// ─── Channel ─────────────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  serverId: string;
  position: number;
  createdAt: string;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
}

// ─── Message ─────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  content: string;
  channelId: string;
  author: MessageAuthor;
  createdAt: string;
  updatedAt: string | null;
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
}

// ─── WebSocket Events ────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'message:new': (message: Message) => void;
  'message:update': (message: Message) => void;
  'message:delete': (data: { messageId: string; channelId: string }) => void;
  'channel:created': (channel: Channel) => void;
  'channel:deleted': (data: { channelId: string; serverId: string }) => void;
  'member:joined': (data: { serverId: string; user: User }) => void;
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
}

export interface ClientToServerEvents {
  'channel:join': (channelId: string) => void;
  'channel:leave': (channelId: string) => void;
  'voice:join': (channelId: string) => void;
  'voice:leave': (channelId: string) => void;
  'voice:mute': (muted: boolean) => void;
  'voice:deaf': (deafened: boolean) => void;
  'voice:speaking': (speaking: boolean) => void;
  'voice:signal': (data: { to: string; signal: unknown }) => void;
  'ping:latency': (timestamp: number) => void;
  'typing:start': (channelId: string) => void;
  'typing:stop': (channelId: string) => void;
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
  user: User;
}

// ─── Invite ──────────────────────────────────────────────────────────────────

export interface Invite {
  code: string;
  serverId: string;
  createdBy: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
}
