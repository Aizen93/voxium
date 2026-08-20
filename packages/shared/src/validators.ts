import { LIMITS, THEME_COLOR_KEYS, THEME_PATTERN_TYPES, THEME_PATTERN_AREAS } from './constants.js';
import { ROLE_COLOR_REGEX } from './permissions.js';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const RGBA_COLOR_RE = /^rgba\(\s*([01]?\d{1,2}|2[0-4]\d|25[0-5])\s*,\s*([01]?\d{1,2}|2[0-4]\d|25[0-5])\s*,\s*([01]?\d{1,2}|2[0-4]\d|25[0-5])\s*,\s*(?:0|1|0?\.\d+)\s*\)$/;

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
  // bcrypt silently truncates at 72 BYTES, not characters. Multi-byte input
  // (CJK, emoji) can pass a character-count check while exceeding 72 bytes —
  // then two different passwords sharing a 72-byte prefix authenticate
  // identically. TextEncoder is available in both Node 18+ and browsers.
  if (new TextEncoder().encode(password).length > LIMITS.PASSWORD_MAX) {
    return `Password must be at most ${LIMITS.PASSWORD_MAX} bytes (special characters and emoji count as multiple bytes)`;
  }
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

export function validateRoleName(name: string): string | null {
  if (name.length < LIMITS.ROLE_NAME_MIN) return `Role name must be at least ${LIMITS.ROLE_NAME_MIN} character`;
  if (name.length > LIMITS.ROLE_NAME_MAX) return `Role name must be at most ${LIMITS.ROLE_NAME_MAX} characters`;
  return null;
}

export function validateNickname(nickname: string): string | null {
  if (nickname.trim().length === 0) return 'Nickname cannot be empty';
  if (nickname.length > LIMITS.NICKNAME_MAX) return `Nickname must be at most ${LIMITS.NICKNAME_MAX} characters`;
  return null;
}

export function validateRoleColor(color: string): string | null {
  if (!ROLE_COLOR_REGEX.test(color)) return 'Color must be a valid hex color (e.g., #FF5733)';
  return null;
}

export function validateThemeName(name: string): string | null {
  if (name.length < LIMITS.THEME_NAME_MIN) return `Theme name must be at least ${LIMITS.THEME_NAME_MIN} characters`;
  if (name.length > LIMITS.THEME_NAME_MAX) return `Theme name must be at most ${LIMITS.THEME_NAME_MAX} characters`;
  return null;
}

export function validateThemeDescription(desc: string): string | null {
  if (desc.length > LIMITS.THEME_DESCRIPTION_MAX) return `Description must be at most ${LIMITS.THEME_DESCRIPTION_MAX} characters`;
  return null;
}

export function validateThemeTag(tag: string): string | null {
  if (tag.trim().length === 0) return 'Tag cannot be empty';
  if (tag.length > LIMITS.THEME_TAG_MAX_LENGTH) return `Tag must be at most ${LIMITS.THEME_TAG_MAX_LENGTH} characters`;
  if (!/^[a-zA-Z0-9 _-]+$/.test(tag)) return 'Tag can only contain letters, numbers, spaces, underscores, and hyphens';
  return null;
}

// ─── SVG Sanitization ────────────────────────────────────────────────────────

const SVG_SAFE_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'defs', 'use', 'symbol', 'clippath', 'mask',
]);
const SVG_SAFE_ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
  'transform', 'viewbox', 'xmlns', 'points', 'id', 'clip-path', 'mask',
  'fill-rule', 'clip-rule',
]);

/**
 * Sanitize SVG markup: strip dangerous elements/attributes, return safe SVG.
 * Returns null if the SVG is fundamentally invalid or contains only dangerous content.
 */
export function sanitizeSvg(raw: string): string | null {
  // Quick reject: must start with <svg or whitespace then <svg
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('<svg')) return null;

  // Reject if contains script, event handlers, or external references
  const lower = trimmed.toLowerCase();
  if (/on\w+\s*=/i.test(lower)) return null; // event handlers
  if (/<script/i.test(lower)) return null;
  if (/<foreignobject/i.test(lower)) return null;
  if (/javascript:/i.test(lower)) return null;
  if (/<iframe/i.test(lower)) return null;
  if (/xlink:href\s*=\s*["'][^#]/i.test(lower)) return null; // external xlink refs (allow internal #id)
  if (/href\s*=\s*["'](?!#)/i.test(lower)) return null; // external href

  // Parse and rebuild using regex (no DOM dependency for shared package)
  // Strip all tags that aren't in the safe list
  const result = trimmed.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\/?>/g, (match, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    if (!SVG_SAFE_TAGS.has(tag)) return '';

    // For closing tags, just pass through
    if (match.startsWith('</')) return `</${tag}>`;

    // Filter attributes
    const safeAttrs: string[] = [];
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrVal = attrMatch[2] ?? attrMatch[3];
      if (SVG_SAFE_ATTRS.has(attrName)) {
        safeAttrs.push(`${attrName}="${attrVal.replace(/"/g, '&quot;')}"`);
      }
    }

    const selfClosing = match.endsWith('/>');
    return `<${tag}${safeAttrs.length ? ' ' + safeAttrs.join(' ') : ''}${selfClosing ? '/>' : '>'}`;
  });

  // Must still contain <svg
  if (!result.toLowerCase().includes('<svg')) return null;

  return result;
}

function validateThemePattern(pattern: Record<string, unknown>): string | null {
  if (!pattern || typeof pattern !== 'object') return 'Pattern must be an object';

  const type = pattern.type;
  if (typeof type !== 'string' || !(THEME_PATTERN_TYPES as readonly string[]).includes(type)) {
    return `Invalid pattern type: must be one of ${THEME_PATTERN_TYPES.join(', ')}`;
  }

  if (type === 'none') return null; // no further validation needed

  // color
  const color = pattern.color;
  if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) {
    return 'Pattern color must be a valid hex color (#RRGGBB)';
  }

  // opacity
  const opacity = pattern.opacity;
  if (typeof opacity !== 'number' || opacity < 0 || opacity > 1) {
    return 'Pattern opacity must be a number between 0 and 1';
  }

  // size (optional)
  if (pattern.size !== undefined) {
    if (typeof pattern.size !== 'number' || pattern.size < 4 || pattern.size > 400) {
      return 'Pattern size must be a number between 4 and 400';
    }
  }

  // angle (optional)
  if (pattern.angle !== undefined) {
    if (typeof pattern.angle !== 'number' || pattern.angle < -180 || pattern.angle > 180) {
      return 'Pattern angle must be a number between -180 and 180';
    }
  }

  // custom SVG data
  if (type === 'custom-svg') {
    if (typeof pattern.svgData !== 'string' || !pattern.svgData.trim()) {
      return 'Custom SVG pattern requires svgData';
    }
    if (pattern.svgData.length > LIMITS.THEME_SVG_MAX_SIZE) {
      return `SVG data must be at most ${LIMITS.THEME_SVG_MAX_SIZE} characters`;
    }
    const sanitized = sanitizeSvg(pattern.svgData);
    if (!sanitized) {
      return 'Invalid or unsafe SVG markup';
    }
  }

  return null;
}

export function validateThemePatterns(patterns: Record<string, unknown>): string | null {
  if (!patterns || typeof patterns !== 'object') return 'Patterns must be an object';

  const validAreas = THEME_PATTERN_AREAS as readonly string[];
  for (const key of Object.keys(patterns)) {
    if (!validAreas.includes(key)) return `Unknown pattern area: "${key}"`;
    const pattern = patterns[key];
    if (pattern !== undefined && pattern !== null) {
      const err = validateThemePattern(pattern as Record<string, unknown>);
      if (err) return `Pattern "${key}": ${err}`;
    }
  }
  return null;
}

/**
 * Build a sanitized copy of a patterns object: strips unknown properties
 * and replaces raw svgData with the sanitized output from sanitizeSvg().
 * Call AFTER validateThemePatterns() passes — assumes input is valid.
 */
export function sanitizeThemePatterns(patterns: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const validAreas = THEME_PATTERN_AREAS as readonly string[];
  for (const area of validAreas) {
    const raw = patterns[area] as Record<string, unknown> | undefined;
    if (!raw) continue;
    if (raw.type === 'none') {
      clean[area] = { type: 'none' };
      continue;
    }
    const entry: Record<string, unknown> = { type: raw.type, color: raw.color, opacity: raw.opacity };
    if (raw.size !== undefined) entry.size = raw.size;
    if (raw.angle !== undefined) entry.angle = raw.angle;
    if (raw.type === 'custom-svg' && typeof raw.svgData === 'string') {
      entry.svgData = sanitizeSvg(raw.svgData) ?? '';
    }
    clean[area] = entry;
  }
  return clean;
}

export function validateThemeColors(colors: Record<string, string>): string | null {
  if (!colors || typeof colors !== 'object') return 'Colors must be an object';
  const keys = Object.keys(colors);
  const expected = THEME_COLOR_KEYS as readonly string[];
  if (keys.length !== expected.length) return `Colors must have exactly ${expected.length} keys`;
  for (const key of expected) {
    if (!(key in colors)) return `Missing color key: ${key}`;
    const val = colors[key];
    if (typeof val !== 'string') return `Color value for "${key}" must be a string`;
    // selection-bg and selection-text allow rgba()
    if (key === 'selection-bg' || key === 'selection-text') {
      if (!HEX_COLOR_RE.test(val) && !RGBA_COLOR_RE.test(val)) {
        return `Invalid color value for "${key}": must be hex (#RRGGBB) or rgba()`;
      }
    } else {
      if (!HEX_COLOR_RE.test(val)) {
        return `Invalid color value for "${key}": must be hex (#RRGGBB)`;
      }
    }
  }
  return null;
}

// ─── Registration abuse defenses ─────────────────────────────────────────────

/**
 * Providers that ignore dots in the local part and route `+tag` to the same
 * inbox. Canonicalization is provider-SPECIFIC on purpose: dots are
 * significant at most providers, and +tags are a legitimate habit we only
 * police where bots actually exploit them.
 */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The duplicate-detection form of an email. NOT for display and NOT for
 * delivery — the address as typed stays the address of record. One canonical
 * form = one account, which is what kills the dotted-gmail alias vector
 * (j.o.h.n+x@gmail.com and john@gmail.com are the same inbox).
 */
export function canonicalizeEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  const at = normalized.lastIndexOf('@');
  if (at === -1) return normalized;
  let local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/**
 * Vendored blocklist of high-volume disposable-email providers — a static,
 * in-repo set so no lookup ever leaves our infrastructure (privacy rule: no
 * third-party services at runtime). Deliberately the short head of the
 * distribution, not an exhaustive list: additions are one line each, and the
 * unverified-account sweep catches what this misses.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', 'guerrillamail.com', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  'mailinator.com', 'mailinator.net', 'maildrop.cc', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'temp-mail.org', 'temp-mail.io', 'tempmail.dev', 'tempmailo.com',
  'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email',
  'dispostable.com', 'mintemail.com', 'mohmal.com', 'tempinbox.com', 'fakeinbox.com',
  'spamgourmet.com', 'mytemp.email', 'burnermail.io', 'emailondeck.com',
  'mail-temp.com', 'moakt.com', 'tmpmail.org', 'tmpmail.net', 'tmails.net',
  'disposablemail.com', 'mailsac.com', 'inboxkitten.com', 'harakirimail.com',
]);

/** True when the address's domain is a known disposable-email provider. */
export function isDisposableEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase().trim());
}

/**
 * Large consumer mail providers, exempt from the novel-domain registration
 * cap: gmail.com legitimately produces unbounded signups per day, while a
 * $10 catch-all domain minting its 11th account of the day is not organic.
 * French providers are listed deliberately — that is where the user base is.
 */
const COMMON_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com',
  'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'yahoo.com', 'yahoo.fr',
  'ymail.com', 'proton.me', 'protonmail.com', 'pm.me', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'gmx.com', 'gmx.de', 'gmx.net', 'gmx.fr', 'web.de',
  'mail.com', 'zoho.com', 'fastmail.com', 'tuta.com', 'tutanota.com',
  'tutamail.com', 'mailbox.org', 'posteo.de', 'orange.fr', 'wanadoo.fr',
  'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net', 'bbox.fr', 'numericable.fr',
]);

/** The domain part of an email, lowercased — '' when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase().trim();
}

/** True when the domain is a major consumer provider (exempt from the
 *  novel-domain registration cap). */
export function isCommonEmailProvider(domain: string): boolean {
  return COMMON_EMAIL_PROVIDERS.has(domain);
}
