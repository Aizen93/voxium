import { LIMITS } from './constants.js';

export function validateUsername(username: string): string | null {
  if (username.length < LIMITS.USERNAME_MIN) return `Username must be at least ${LIMITS.USERNAME_MIN} characters`;
  if (username.length > LIMITS.USERNAME_MAX) return `Username must be at most ${LIMITS.USERNAME_MAX} characters`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username can only contain letters, numbers, underscores, dots, and hyphens';
  return null;
}

export function validateEmail(email: string): string | null {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return 'Invalid email address';
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < LIMITS.PASSWORD_MIN) return `Password must be at least ${LIMITS.PASSWORD_MIN} characters`;
  if (password.length > LIMITS.PASSWORD_MAX) return `Password must be at most ${LIMITS.PASSWORD_MAX} characters`;
  return null;
}

export function validateServerName(name: string): string | null {
  if (name.length < LIMITS.SERVER_NAME_MIN) return `Server name must be at least ${LIMITS.SERVER_NAME_MIN} characters`;
  if (name.length > LIMITS.SERVER_NAME_MAX) return `Server name must be at most ${LIMITS.SERVER_NAME_MAX} characters`;
  return null;
}

export function validateChannelName(name: string): string | null {
  if (name.length < LIMITS.CHANNEL_NAME_MIN) return `Channel name must be at least ${LIMITS.CHANNEL_NAME_MIN} character`;
  if (name.length > LIMITS.CHANNEL_NAME_MAX) return `Channel name must be at most ${LIMITS.CHANNEL_NAME_MAX} characters`;
  if (!/^[a-zA-Z0-9_-]+(?:\s[a-zA-Z0-9_-]+)*$/.test(name)) return 'Channel name contains invalid characters';
  return null;
}

export function validateMessageContent(content: string): string | null {
  if (content.trim().length === 0) return 'Message cannot be empty';
  if (content.length > LIMITS.MESSAGE_MAX) return `Message must be at most ${LIMITS.MESSAGE_MAX} characters`;
  return null;
}

export function validateEmoji(emoji: string): string | null {
  if (!emoji || emoji.trim().length === 0) return 'Emoji cannot be empty';
  if (emoji.length > LIMITS.MAX_EMOJI_LENGTH) return 'Emoji is too long';
  if (/^[\x20-\x7E]+$/.test(emoji)) return 'Invalid emoji';
  return null;
}

export function validateDisplayName(displayName: string): string | null {
  if (displayName.trim().length === 0) return 'Display name cannot be empty';
  if (displayName.length > LIMITS.DISPLAY_NAME_MAX) return `Display name must be at most ${LIMITS.DISPLAY_NAME_MAX} characters`;
  return null;
}

export function validateBio(bio: string): string | null {
  if (bio.length > LIMITS.BIO_MAX) return `Bio must be at most ${LIMITS.BIO_MAX} characters`;
  return null;
}

export function validateCategoryName(name: string): string | null {
  if (name.length < LIMITS.CATEGORY_NAME_MIN) return `Category name must be at least ${LIMITS.CATEGORY_NAME_MIN} character`;
  if (name.length > LIMITS.CATEGORY_NAME_MAX) return `Category name must be at most ${LIMITS.CATEGORY_NAME_MAX} characters`;
  return null;
}

export function validateSearchQuery(query: string): string | null {
  if (query.length < LIMITS.SEARCH_QUERY_MIN) return `Search query must be at least ${LIMITS.SEARCH_QUERY_MIN} characters`;
  if (query.length > LIMITS.SEARCH_QUERY_MAX) return `Search query must be at most ${LIMITS.SEARCH_QUERY_MAX} characters`;
  return null;
}
