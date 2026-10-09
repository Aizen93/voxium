import { describe, it, expect } from 'vitest';
import {
  DISCOVERY_TAGS,
  DISCOVERY_SCORE_WEIGHTS,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_MAX_PAGE_SIZE,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_TOTAL_CAP,
  DISCOVERY_SEARCH_MIN,
  DISCOVERY_SEARCH_MAX,
  DISCOVERY_SORTS,
  SERVER_JOIN_MODES,
  DISCOVERY_TEXT_FORBIDDEN_RE,
  ANNOTATION_TEXT_FORBIDDEN_RE,
  JOIN_REQUEST_DECLINE_COOLDOWN_DAYS,
  JOIN_REQUEST_PENDING_TTL_DAYS,
  LIMITS,
  WS_EVENTS,
  PERMISSION_LIST,
  Permissions,
  ALL_PERMISSIONS,
  validateServerDescription,
  validateDiscoveryTags,
  dedupeDiscoveryTags,
  isDiscoveryTag,
  validateBanReason,
  validateJoinRequestMessage,
  validateDiscoveryQuery,
} from '@voxium/shared';

// Characters built programmatically: a literal escape in a test file is a
// raw-byte accident waiting to happen (see the project's gotcha list).
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Server discovery — shared constants', () => {
  it('the tag vocabulary is the 12 agreed tags, unique and lowercase-kebab', () => {
    expect(DISCOVERY_TAGS).toEqual([
      'gaming', 'esports', 'open-source', 'programming', 'science', 'education',
      'languages', 'music', 'art', 'film-tv', 'creators', 'community',
    ]);
    expect(new Set(DISCOVERY_TAGS).size).toBe(DISCOVERY_TAGS.length);
    for (const tag of DISCOVERY_TAGS) expect(tag).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('the Active-sort weights are positive integers and online weighs 10', () => {
    expect(DISCOVERY_SCORE_WEIGHTS).toEqual({ online: 10, messages: 1, members: 1 });
    for (const w of Object.values(DISCOVERY_SCORE_WEIGHTS)) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });

  it('paging, depth, total cap and search bounds are the plan\'s numbers and mutually consistent', () => {
    expect(DISCOVERY_PAGE_SIZE).toBe(24);
    expect(DISCOVERY_MAX_PAGE_SIZE).toBe(48);
    expect(DISCOVERY_PAGE_SIZE).toBeLessThanOrEqual(DISCOVERY_MAX_PAGE_SIZE);
    expect(DISCOVERY_MAX_PAGES).toBe(50);
    expect(DISCOVERY_TOTAL_CAP).toBe(1000);
    expect(DISCOVERY_SEARCH_MIN).toBe(3);
    expect(DISCOVERY_SEARCH_MAX).toBe(64);
    expect(DISCOVERY_SEARCH_MIN).toBeLessThan(DISCOVERY_SEARCH_MAX);
  });

  it('the four transparent sorts and the two join modes, approval first (the default)', () => {
    expect(DISCOVERY_SORTS).toEqual(['active', 'members', 'newest', 'name']);
    expect(SERVER_JOIN_MODES).toEqual(['approval', 'open']);
  });

  it('join-request housekeeping windows', () => {
    expect(JOIN_REQUEST_DECLINE_COOLDOWN_DAYS).toBe(7);
    expect(JOIN_REQUEST_PENDING_TTL_DAYS).toBe(30);
  });

  it('the text caps all live in LIMITS', () => {
    expect(LIMITS.SERVER_DESCRIPTION_MAX).toBe(300);
    expect(LIMITS.DISCOVERY_MAX_TAGS).toBe(5);
    expect(LIMITS.SERVER_BAN_REASON_MAX).toBe(300);
    expect(LIMITS.JOIN_REQUEST_MESSAGE_MAX).toBe(300);
  });

  it('the four join-request events are named and distinct', () => {
    expect(WS_EVENTS.SERVER_JOIN_REQUEST).toBe('server:join_request');
    expect(WS_EVENTS.SERVER_JOIN_REQUEST_RESOLVED).toBe('server:join_request_resolved');
    expect(WS_EVENTS.SERVER_JOIN_APPROVED).toBe('server:join_approved');
    expect(WS_EVENTS.SERVER_JOIN_DECLINED).toBe('server:join_declined');
    expect(new Set(Object.values(WS_EVENTS)).size).toBe(Object.values(WS_EVENTS).length);
  });

  it('the forbidden-character class is the annotation set minus the newline, and non-global', () => {
    expect(DISCOVERY_TEXT_FORBIDDEN_RE.global).toBe(false);
    expect(DISCOVERY_TEXT_FORBIDDEN_RE.test('plain text, accents é, emoji 🎉')).toBe(false);
    expect(DISCOVERY_TEXT_FORBIDDEN_RE.test('line one\nline two')).toBe(false);
    expect(ANNOTATION_TEXT_FORBIDDEN_RE.test('\n')).toBe(true); // what the annotation set rejects and this one allows
    for (const ch of [BIDI_OVERRIDE, ZERO_WIDTH_SPACE, BOM, NUL, TAB]) {
      expect(DISCOVERY_TEXT_FORBIDDEN_RE.test(`a${ch}b`)).toBe(true);
      expect(ANNOTATION_TEXT_FORBIDDEN_RE.test(`a${ch}b`)).toBe(true);
    }
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe('Server discovery — KICK_MEMBERS is now "Manage members", no new bit', () => {
  it('rewords the entry and keeps the flag', () => {
    const entry = PERMISSION_LIST.find((p) => p.key === 'KICK_MEMBERS')!;
    expect(entry.flag).toBe(Permissions.KICK_MEMBERS);
    expect(Permissions.KICK_MEMBERS).toBe(1n << 6n);
    expect(entry.category).toBe('membership');
    expect(entry.name).toBe('Manage Members');
    expect(entry.description).toMatch(/remove and ban/);
    expect(entry.description).toMatch(/unban/);
    expect(entry.description).toMatch(/join requests/);
  });

  it('adds no permission flag — the directory reuses KICK_MEMBERS for all membership moderation', () => {
    expect(Object.keys(Permissions)).toHaveLength(21);
    expect(ALL_PERMISSIONS).toBe((1n << 21n) - 1n);
    expect(PERMISSION_LIST).toHaveLength(21);
  });
});

// ─── Validators ─────────────────────────────────────────────────────────────

describe('validateServerDescription', () => {
  it('accepts an empty, a short and a multi-line description up to the cap', () => {
    expect(validateServerDescription('')).toBeNull();
    expect(validateServerDescription('EU-evening raid group.\nNew players welcome.')).toBeNull();
    expect(validateServerDescription('x'.repeat(LIMITS.SERVER_DESCRIPTION_MAX))).toBeNull();
  });

  it('rejects one over the cap', () => {
    expect(validateServerDescription('x'.repeat(LIMITS.SERVER_DESCRIPTION_MAX + 1))).toMatch(/at most 300/);
  });

  it('rejects bidi overrides, zero-width and control characters (shown to strangers)', () => {
    for (const ch of [BIDI_OVERRIDE, ZERO_WIDTH_SPACE, BOM, NUL, TAB]) {
      expect(validateServerDescription(`Free ${ch}stuff`)).toMatch(/unsupported characters/);
    }
  });
});

describe('validateDiscoveryTags / dedupeDiscoveryTags / isDiscoveryTag', () => {
  it('accepts an empty list and up to five vocabulary tags', () => {
    expect(validateDiscoveryTags([])).toBeNull();
    expect(validateDiscoveryTags(['gaming'])).toBeNull();
    expect(validateDiscoveryTags(['gaming', 'esports', 'music', 'art', 'community'])).toBeNull();
  });

  it('rejects a non-array and any value outside the vocabulary, without echoing it', () => {
    expect(validateDiscoveryTags('gaming')).toBe('Tags must be an array');
    expect(validateDiscoveryTags(null)).toBe('Tags must be an array');
    const err = validateDiscoveryTags(['gaming', '<script>']);
    expect(err).toMatch(/supported list/);
    expect(err).not.toContain('<script>');
    expect(validateDiscoveryTags(['Gaming'])).toMatch(/supported list/); // case-sensitive: the vocabulary is lowercase
    expect(validateDiscoveryTags([42])).toMatch(/supported list/);
  });

  it('caps at five DISTINCT tags — duplicates collapse and do not count', () => {
    expect(validateDiscoveryTags(['gaming', 'gaming', 'gaming', 'gaming', 'gaming', 'gaming'])).toBeNull();
    expect(validateDiscoveryTags(['gaming', 'esports', 'music', 'art', 'community', 'science'])).toMatch(/At most 5 tags/);
  });

  it('dedupe keeps first occurrence order and drops anything outside the vocabulary', () => {
    expect(dedupeDiscoveryTags(['music', 'gaming', 'music', 'nope', 'gaming', 'art'])).toEqual(['music', 'gaming', 'art']);
    expect(dedupeDiscoveryTags([])).toEqual([]);
  });

  it('isDiscoveryTag is a type guard over the vocabulary', () => {
    expect(isDiscoveryTag('film-tv')).toBe(true);
    expect(isDiscoveryTag('film_tv')).toBe(false);
    expect(isDiscoveryTag(undefined)).toBe(false);
    expect(isDiscoveryTag({ toString: () => 'gaming' })).toBe(false);
  });
});

describe('validateBanReason / validateJoinRequestMessage', () => {
  it('both are optional (empty passes) and capped at 300', () => {
    expect(validateBanReason('')).toBeNull();
    expect(validateJoinRequestMessage('')).toBeNull();
    expect(validateBanReason('x'.repeat(300))).toBeNull();
    expect(validateJoinRequestMessage('x'.repeat(300))).toBeNull();
    expect(validateBanReason('x'.repeat(301))).toMatch(/at most 300/);
    expect(validateJoinRequestMessage('x'.repeat(301))).toMatch(/at most 300/);
  });

  it('both reject the invisible/bidi characters', () => {
    expect(validateBanReason(`spam${BIDI_OVERRIDE}`)).toMatch(/unsupported characters/);
    expect(validateJoinRequestMessage(`hi${ZERO_WIDTH_SPACE}`)).toMatch(/unsupported characters/);
  });
});

describe('validateDiscoveryQuery', () => {
  it('needs three characters after trimming (the trigram minimum) and at most 64', () => {
    expect(validateDiscoveryQuery('ab')).toMatch(/at least 3/);
    expect(validateDiscoveryQuery('  ab  ')).toMatch(/at least 3/);
    expect(validateDiscoveryQuery('abc')).toBeNull();
    expect(validateDiscoveryQuery('  abc  ')).toBeNull();
    expect(validateDiscoveryQuery('x'.repeat(64))).toBeNull();
    expect(validateDiscoveryQuery('x'.repeat(65))).toMatch(/at most 64/);
  });
});
