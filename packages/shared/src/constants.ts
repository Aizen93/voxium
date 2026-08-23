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
  MAX_EMOJI_LENGTH: 32,
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
} as const;

/**
 * Max serialized dm:voice:signal payload the server will relay (UTF-16 chars,
 * matching the JSON.stringify length check). Signals are opaque olm1 envelopes
 * after the E2E cutover — the cap must fit a base64-inflated audio SDP with
 * envelope framing, with generous headroom.
 */
export const DM_SIGNAL_MAX = 65_536;

// ─── Screen-share annotations (sharer-drawn overlays, session-only) ──────────
// Serialized-length caps use UTF-16 char counts (JSON.stringify().length),
// matching the DM_SIGNAL_MAX convention. All must stay well under the 1MB
// engine.io frame default.

/** Max serialized chars of one voice:annotation:ops batch (fits one max-size image op). */
export const ANNOTATION_OPS_MAX = 400_000;
/** Max ops per batch. */
export const ANNOTATION_MAX_OPS_PER_BATCH = 64;
/** Max serialized chars of the whole scene (= Redis value cap = snapshot emit cap). */
export const ANNOTATION_SCENE_MAX = 800_000;
/** Max objects in a scene (bounds viewer redraw cost). */
export const ANNOTATION_MAX_OBJECTS = 300;
/** Max points per stroke, appends included. */
export const ANNOTATION_STROKE_MAX_POINTS = 2_000;
/** Max chars for a text overlay. */
export const ANNOTATION_TEXT_MAX = 200;
/** Characters a text overlay may never carry: control chars, and the
 *  bidi-override / zero-width / invisible format characters that let a caption
 *  visually read as something it is not (U+202E flips the rest of the line).
 *  The server REJECTS the whole batch on a hit; the editor strips them before
 *  committing so a pasted tab never desyncs the viewers. Non-global on
 *  purpose (`.test()` on a /g regex mutates lastIndex) — build a /g copy to
 *  strip. */
// eslint-disable-next-line no-control-regex
export const ANNOTATION_TEXT_FORBIDDEN_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
/** Max chars for an image overlay data-URL (≈256KB decoded after base64 inflation). */
export const ANNOTATION_IMAGE_DATAURL_MAX = 360_000;
/** Client-side resize target for overlay images (px, longest edge). */
export const ANNOTATION_IMAGE_MAX_EDGE = 512;
/** Hard cap on an overlay image's DECODED pixel edge, enforced server-side by
 *  header parsing and client-side at decode — a small-byte "image bomb" can
 *  otherwise declare a multi-gigabyte bitmap and crash every viewer. */
export const ANNOTATION_IMAGE_MAX_DECODED_EDGE = 4096;
/** Total stroke points allowed in a scene (all strokes combined) — bounds the
 *  per-frame redraw cost a hostile sharer can impose on every viewer. */
export const ANNOTATION_MAX_SCENE_POINTS = 20_000;
/** Client op-flush throttle — ≤ ~7 batches/s while actively drawing. */
export const ANNOTATION_BATCH_INTERVAL_MS = 150;
/** socketRateLimit bucket for voice:annotation:ops (150ms flush ⇒ ≤400/min + headroom). */
export const ANNOTATION_RATE_PER_MIN = 600;
/** Serialized ops chars a sharer may send per minute — the request-count
 *  limiter alone would allow 600 × 400K chars/min of Redis write amplification. */
export const ANNOTATION_BYTES_PER_MIN = 2_000_000;
/** Client-side wait for a batch ack before sending the next chunk (keeps the
 *  server's read-modify-write single-writer without wedging the queue). */
export const ANNOTATION_ACK_TIMEOUT_MS = 3_000;
/** Undo/redo history depth on the sharer (entries, one per gesture). */
export const ANNOTATION_HISTORY_MAX = 100;

// ─── voice:annotation:live — the ephemeral sibling of :ops ───────────────────
// Fire-and-forget, no Redis, no rev, no ack, no hydration. Each kind has its
// own socketRateLimit bucket so a reaction burst cannot starve the sharer's
// pointer, and none of them shares the :ops bucket.

/** Laser pointer: 20 Hz is 1200/min; the rest is headroom for pointer-off. */
export const ANNOTATION_LIVE_POINTER_RATE_PER_MIN = 1500;
/** Client-side throttle for pointer moves (ms). */
export const ANNOTATION_LIVE_POINTER_INTERVAL_MS = 50;
/** Reactions per socket per minute. */
export const ANNOTATION_LIVE_REACTION_RATE_PER_MIN = 10;
/** Snapshot notices per socket per minute. */
export const ANNOTATION_LIVE_SNAPSHOT_RATE_PER_MIN = 5;
/** Serialized chars of one live event — a pointer is ~60. */
export const ANNOTATION_LIVE_MAX = 256;
/** The only emoji a reaction may carry — the wire sends an INDEX into this
 *  list, never a string, so no arbitrary Unicode crosses it. Order is wire
 *  format: append only. */
export const ANNOTATION_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥', '👏', '🤔'] as const;
/** How long a viewer keeps painting a laser dot after the last update. */
export const ANNOTATION_LIVE_POINTER_FADE_MS = 700;

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

export const WS_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATE: 'message:update',
  MESSAGE_DELETE: 'message:delete',
  CHANNEL_CREATED: 'channel:created',
  CHANNEL_UPDATED: 'channel:updated',
  CHANNEL_DELETED: 'channel:deleted',
  // Secure channels only — emitted to the channel:{id} room on invite/remove/
  // leave so member lists refresh and clients re-key on next send. Secure
  // channel events NEVER go to server:{id} (non-members must learn nothing).
  CHANNEL_MEMBERS_UPDATED: 'channel:members_updated',
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
  VOICE_E2E_KEY: 'voice:e2e:key',
  VOICE_E2E_KEY_REQUEST: 'voice:e2e:key_request',
  VOICE_ERROR: 'voice:error',
  VOICE_TRANSPORT_CREATED: 'voice:transport_created',
  VOICE_TRANSPORT_CONNECT: 'voice:transport:connect',
  VOICE_PRODUCE: 'voice:produce',
  VOICE_NEW_CONSUMER: 'voice:new_consumer',
  VOICE_CONSUMER_RESUME: 'voice:consumer:resume',
  VOICE_PRODUCER_CLOSE: 'voice:producer:close',
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
  VOICE_ANNOTATION_OPS: 'voice:annotation:ops',
  VOICE_ANNOTATION_STATE: 'voice:annotation:state',
  VOICE_ANNOTATION_LIVE: 'voice:annotation:live',
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

/**
 * The theme keys that paint ON another surface instead of BEING one, where an
 * alpha channel is meaningful — and, since the 2026 redesign, the norm: hover,
 * active, hairline borders and scrollbars are mixed from the accent family into
 * transparency, which is what keeps a dark theme tinted rather than grey.
 *
 * Everything else is an opaque surface. Alpha on those would let whatever sits
 * behind show through a panel that is supposed to be solid, so the validator
 * keeps them hex-only — see `isValidThemeColorValue`.
 */
export const TRANSLUCENT_THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
  'bg-hover',
  'bg-active',
  'border',
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
  'selection-bg',
  'selection-text',
] as const;

export const BUILT_IN_THEME_IDS = ['dark', 'light', 'midnight', 'tactical'] as const;
