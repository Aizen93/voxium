export const APP_NAME = 'Voxium';
export const APP_VERSION = '0.2.8';

export const API_VERSION = 'v1';

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  DISPLAY_NAME_MAX: 64,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 128,
  SERVER_NAME_MIN: 2,
  SERVER_NAME_MAX: 100,
  CHANNEL_NAME_MIN: 1,
  CHANNEL_NAME_MAX: 100,
  MESSAGE_MAX: 4000,
  BIO_MAX: 500,
  MESSAGES_PER_PAGE: 50,
  MEMBERS_PER_PAGE: 100,
  MAX_SERVERS_PER_USER: 100,
  MAX_CHANNELS_PER_SERVER: 500,
  MAX_VOICE_USERS_PER_CHANNEL: 99,
  MAX_REACTIONS_PER_MESSAGE: 20,
  MAX_EMOJI_LENGTH: 32,
} as const;

export const INVITE_CODE_LENGTH = 8;

export const WS_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATE: 'message:update',
  MESSAGE_DELETE: 'message:delete',
  CHANNEL_CREATED: 'channel:created',
  CHANNEL_DELETED: 'channel:deleted',
  MEMBER_JOINED: 'member:joined',
  MEMBER_LEFT: 'member:left',
  PRESENCE_UPDATE: 'presence:update',
  VOICE_USER_JOINED: 'voice:user_joined',
  VOICE_USER_LEFT: 'voice:user_left',
  VOICE_STATE_UPDATE: 'voice:state_update',
  VOICE_SPEAKING: 'voice:speaking',
  VOICE_SIGNAL: 'voice:signal',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_LEAVE: 'channel:leave',
  VOICE_JOIN: 'voice:join',
  VOICE_LEAVE: 'voice:leave',
  VOICE_MUTE: 'voice:mute',
  VOICE_DEAF: 'voice:deaf',
  MESSAGE_REACTION_UPDATE: 'message:reaction_update',
} as const;
