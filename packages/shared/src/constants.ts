import pkg from '../package.json' with { type: 'json' };

export const APP_NAME = 'Voxium';
export const APP_VERSION = pkg.version;

export const API_VERSION = 'v1';

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  DISPLAY_NAME_MAX: 64,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 72,
  SERVER_NAME_MIN: 2,
  SERVER_NAME_MAX: 100,
  CHANNEL_NAME_MIN: 1,
  CHANNEL_NAME_MAX: 100,
  MESSAGE_MAX: 4000,
  BIO_MAX: 500,
  MESSAGES_PER_PAGE: 50,
  MEMBERS_PER_PAGE: 100,
  MAX_SERVERS_PER_USER: 5,
  MAX_CHANNELS_PER_SERVER: 20,
  MAX_VOICE_USERS_PER_CHANNEL: 12,
  MAX_REACTIONS_PER_MESSAGE: 20,
  MAX_EMOJI_LENGTH: 64,
  CATEGORY_NAME_MIN: 1,
  CATEGORY_NAME_MAX: 100,
  MAX_CATEGORIES_PER_SERVER: 12,
  SEARCH_QUERY_MIN: 2,
  SEARCH_QUERY_MAX: 200,
  SEARCH_RESULTS_PER_PAGE: 25,
  ANNOUNCEMENT_TITLE_MIN: 3,
  ANNOUNCEMENT_TITLE_MAX: 200,
  ANNOUNCEMENT_CONTENT_MAX: 2000,
  REPORT_REASON_MIN: 10,
  REPORT_REASON_MAX: 1000,
  SUPPORT_MESSAGE_MIN: 1,
  SUPPORT_MESSAGE_MAX: 2000,
  MAX_MENTIONS_PER_MESSAGE: 10,
  TOTP_CODE_LENGTH: 6,
  TOTP_BACKUP_CODE_COUNT: 8,
  MAX_ATTACHMENTS_PER_MESSAGE: 5,
  MAX_ATTACHMENT_SIZE: 8 * 1024 * 1024, // 8 MB (default for non-video files)
  MAX_VIDEO_ATTACHMENT_SIZE: 12 * 1024 * 1024, // 12 MB (for video files)
  ATTACHMENT_RETENTION_DAYS: 3,
  MAX_ROLES_PER_SERVER: 25,
  ROLE_NAME_MIN: 1,
  ROLE_NAME_MAX: 100,
  NICKNAME_MAX: 32,
  THEME_NAME_MIN: 2,
  THEME_NAME_MAX: 50,
  THEME_DESCRIPTION_MAX: 500,
  THEME_MAX_TAGS: 5,
  THEME_TAG_MAX_LENGTH: 20,
  THEME_MAX_PER_USER: 10,
  THEMES_PER_PAGE: 20,
  THEME_SVG_MAX_SIZE: 10_000, // 10KB max for custom SVG patterns
  MAX_CUSTOM_EMOJIS_PER_SERVER: 50,
  MAX_STICKER_PACKS_PER_SERVER: 5,
  MAX_STICKERS_PER_PACK: 30,
  MAX_PERSONAL_STICKER_PACKS: 3,
  MAX_EMOJI_FILE_SIZE: 256 * 1024,      // 256 KB
  MAX_STICKER_FILE_SIZE: 512 * 1024,    // 512 KB
  MAX_EMOJI_NAME_LENGTH: 32,
  MAX_STICKER_NAME_LENGTH: 32,
  MAX_STICKER_PACK_NAME_LENGTH: 50,
  MAX_STICKER_PACK_DESCRIPTION_LENGTH: 200,
  GIPHY_RESULTS_PER_PAGE: 20,
  MAX_GIF_FILE_SIZE: 8 * 1024 * 1024,     // 8 MB
  MAX_GIF_TAGS: 5,
  MAX_GIF_TAG_LENGTH: 30,
  MAX_GIFS_PER_USER: 50,
  MAX_COLLAB_UPDATE_SIZE: 512 * 1024,         // 512 KB per Yjs update
  MAX_COLLAB_SNAPSHOT_SIZE: 10 * 1024 * 1024,  // 10 MB max snapshot
} as const;

export const THEME_PATTERN_TYPES = ['none', 'stripes', 'grid', 'dots', 'crosshatch', 'custom-svg'] as const;
export type ThemePatternType = (typeof THEME_PATTERN_TYPES)[number];

export const THEME_PATTERN_AREAS = ['sidebar', 'channel', 'chat'] as const;
export type ThemePatternArea = (typeof THEME_PATTERN_AREAS)[number];

export const ALLOWED_ATTACHMENT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/csv',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/webm',
] as const;

export function getMaxAttachmentSize(mimeType: string): number {
  return mimeType.startsWith('video/') ? LIMITS.MAX_VIDEO_ATTACHMENT_SIZE : LIMITS.MAX_ATTACHMENT_SIZE;
}

export const INVITE_CODE_LENGTH = 8;

/** Regex to match @[userId] mention tokens in message content */
export const MENTION_RE = /@\[([^\]]{1,30})\]/g;

/** Regex to match custom emoji tokens <:name:id> in message content */
export const CUSTOM_EMOJI_RE = /<:([a-zA-Z0-9_]{1,32}):([a-zA-Z0-9]{10,30})>/g;

/** Allowed MIME types for custom emoji and sticker uploads */
export const ALLOWED_EMOJI_TYPES = ['image/png', 'image/webp', 'image/gif'] as const;

export const WS_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATE: 'message:update',
  MESSAGE_DELETE: 'message:delete',
  CHANNEL_CREATED: 'channel:created',
  CHANNEL_UPDATED: 'channel:updated',
  CHANNEL_DELETED: 'channel:deleted',
  CATEGORY_CREATED: 'category:created',
  CATEGORY_UPDATED: 'category:updated',
  CATEGORY_DELETED: 'category:deleted',
  MEMBER_JOINED: 'member:joined',
  MEMBER_LEFT: 'member:left',
  PRESENCE_UPDATE: 'presence:update',
  VOICE_CHANNEL_USERS: 'voice:channel_users',
  VOICE_USER_JOINED: 'voice:user_joined',
  VOICE_USER_LEFT: 'voice:user_left',
  VOICE_STATE_UPDATE: 'voice:state_update',
  VOICE_SPEAKING: 'voice:speaking',
  VOICE_SIGNAL: 'voice:signal',
  VOICE_ERROR: 'voice:error',
  VOICE_TRANSPORT_CREATED: 'voice:transport_created',
  VOICE_TRANSPORT_CONNECT: 'voice:transport:connect',
  VOICE_PRODUCE: 'voice:produce',
  VOICE_NEW_CONSUMER: 'voice:new_consumer',
  VOICE_CONSUMER_RESUME: 'voice:consumer:resume',
  VOICE_PRODUCER_CLOSED: 'voice:producer_closed',
  VOICE_RTP_CAPABILITIES: 'voice:rtp_capabilities',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_LEAVE: 'channel:leave',
  VOICE_JOIN: 'voice:join',
  VOICE_LEAVE: 'voice:leave',
  VOICE_MUTE: 'voice:mute',
  VOICE_DEAF: 'voice:deaf',
  MESSAGE_REACTION_UPDATE: 'message:reaction_update',
  SERVER_UPDATED: 'server:updated',
  USER_UPDATED: 'user:updated',
  UNREAD_INIT: 'unread:init',
  DM_MESSAGE_NEW: 'dm:message:new',
  DM_MESSAGE_UPDATE: 'dm:message:update',
  DM_MESSAGE_DELETE: 'dm:message:delete',
  DM_TYPING_START: 'dm:typing:start',
  DM_TYPING_STOP: 'dm:typing:stop',
  DM_JOIN: 'dm:join',
  DM_MESSAGE_REACTION_UPDATE: 'dm:message:reaction_update',
  DM_UNREAD_INIT: 'dm:unread:init',
  DM_VOICE_OFFER: 'dm:voice:offer',
  DM_VOICE_JOINED: 'dm:voice:joined',
  DM_VOICE_LEFT: 'dm:voice:left',
  DM_VOICE_STATE_UPDATE: 'dm:voice:state_update',
  DM_VOICE_SPEAKING: 'dm:voice:speaking',
  DM_VOICE_SIGNAL: 'dm:voice:signal',
  DM_VOICE_JOIN: 'dm:voice:join',
  DM_VOICE_LEAVE: 'dm:voice:leave',
  DM_VOICE_MUTE: 'dm:voice:mute',
  DM_VOICE_DEAF: 'dm:voice:deaf',
  DM_VOICE_ENDED: 'dm:voice:ended',
  DM_VOICE_DECLINE: 'dm:voice:decline',
  FRIEND_REQUEST_RECEIVED: 'friend:request_received',
  FRIEND_REQUEST_ACCEPTED: 'friend:request_accepted',
  FRIEND_REMOVED: 'friend:removed',
  DM_CONVERSATION_DELETED: 'dm:conversation:deleted',
  MEMBER_ROLE_UPDATED: 'member:role_updated',
  MEMBER_KICKED: 'member:kicked',
  SERVER_DELETED: 'server:deleted',
  VOICE_SERVER_MUTE: 'voice:server_mute',
  VOICE_SERVER_DEAFEN: 'voice:server_deafen',
  VOICE_FORCE_MOVE: 'voice:force_move',
  VOICE_FORCE_MOVED: 'voice:force_moved',
  VOICE_SCREEN_SHARE_START: 'voice:screen_share:start',
  VOICE_SCREEN_SHARE_STOP: 'voice:screen_share:stop',
  VOICE_SCREEN_SHARE_STATE: 'voice:screen_share:state',
  ADMIN_METRICS: 'admin:metrics',
  ADMIN_SUBSCRIBE_METRICS: 'admin:subscribe_metrics',
  ADMIN_UNSUBSCRIBE_METRICS: 'admin:unsubscribe_metrics',
  ANNOUNCEMENT_NEW: 'announcement:new',
  ANNOUNCEMENT_INIT: 'announcement:init',
  REPORT_NEW: 'report:new',
  ADMIN_SUBSCRIBE_REPORTS: 'admin:subscribe_reports',
  ADMIN_UNSUBSCRIBE_REPORTS: 'admin:unsubscribe_reports',
  SUPPORT_MESSAGE_NEW: 'support:message:new',
  SUPPORT_STATUS_CHANGE: 'support:status_change',
  SUPPORT_TICKET_NEW: 'support:ticket:new',
  ADMIN_SUBSCRIBE_SUPPORT: 'admin:subscribe_support',
  ADMIN_UNSUBSCRIBE_SUPPORT: 'admin:unsubscribe_support',
  FORCE_LOGOUT: 'force:logout',
  // Roles & Permissions
  ROLE_CREATED: 'role:created',
  ROLE_UPDATED: 'role:updated',
  ROLE_DELETED: 'role:deleted',
  ROLE_REORDERED: 'role:reordered',
  MEMBER_ROLES_UPDATED: 'member:roles_updated',
  CHANNEL_PERMISSIONS_UPDATED: 'channel:permissions_updated',
  MEMBER_NICKNAME_UPDATED: 'member:nickname_updated',
  // Community Themes
  THEME_PUBLISHED: 'theme:published',
  THEME_UPDATED: 'theme:updated',
  THEME_REMOVED: 'theme:removed',
  // Custom Emojis
  EMOJI_INIT: 'emoji:init',
  EMOJI_CREATED: 'emoji:created',
  EMOJI_DELETED: 'emoji:deleted',
  // Stickers
  STICKER_INIT: 'sticker:init',
  STICKER_PACK_CREATED: 'sticker:pack_created',
  STICKER_PACK_DELETED: 'sticker:pack_deleted',
  STICKER_ADDED: 'sticker:added',
  STICKER_REMOVED: 'sticker:removed',
  // Collaboration (Canvas/Code Channels)
  COLLAB_JOIN: 'collab:join',
  COLLAB_LEAVE: 'collab:leave',
  COLLAB_UPDATE: 'collab:update',
  COLLAB_SYNC: 'collab:sync',
  COLLAB_AWARENESS: 'collab:awareness',
  COLLAB_LANGUAGE_CHANGED: 'collab:language_changed',
} as const;

export const THEME_COLOR_KEYS = [
  'bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-active', 'bg-floating',
  'sidebar', 'channel', 'chat',
  'text-primary', 'text-secondary', 'text-muted', 'text-link',
  'accent-primary', 'accent-hover', 'accent-success', 'accent-warning', 'accent-danger', 'accent-info',
  'border',
  'voice-connected', 'voice-speaking', 'voice-muted',
  'scrollbar-thumb', 'scrollbar-thumb-hover',
  'selection-bg', 'selection-text',
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export const THEME_COLOR_GROUPS: Record<string, readonly ThemeColorKey[]> = {
  'Backgrounds': ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-active', 'bg-floating'],
  'Layout': ['sidebar', 'channel', 'chat'],
  'Text': ['text-primary', 'text-secondary', 'text-muted', 'text-link'],
  'Accents': ['accent-primary', 'accent-hover', 'accent-success', 'accent-warning', 'accent-danger', 'accent-info'],
  'Borders': ['border'],
  'Voice': ['voice-connected', 'voice-speaking', 'voice-muted'],
  'Scrollbar': ['scrollbar-thumb', 'scrollbar-thumb-hover'],
  'Selection': ['selection-bg', 'selection-text'],
} as const;

export const BUILT_IN_THEME_IDS = ['dark', 'light', 'midnight', 'tactical'] as const;

export const CODE_LANGUAGES = [
  'typescript', 'javascript', 'java', 'rust', 'python',
  'go', 'cpp', 'csharp', 'html', 'css', 'sql', 'plaintext',
] as const;

export const VALID_CHANNEL_TYPES = ['text', 'voice', 'canvas', 'code'] as const;
