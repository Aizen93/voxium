import crypto from 'crypto';
import { DISCOVERY_SORTS, DISCOVERY_MAX_PAGE_SIZE, type DiscoverySort } from '@voxium/shared';

/**
 * The directory pages with KEYSET cursors, never OFFSET: page 40 costs the
 * same as page 1 at any table size. The cursor the client hands back is
 * opaque and SIGNED so it cannot be edited into a different query, a deeper
 * page or an arbitrary position:
 *
 *   base64url(JSON) "." base64url(HMAC-SHA256(JSON))
 *
 * It is bound to the sort, the tag, the (hashed) search query and the page
 * size it was issued for, carries the page number that enforces the depth
 * cap, and carries the SORT KEY of the last row of the previous page next to
 * its id. The route turns the pair into an explicit "(key, id) after the
 * cursor" predicate rather than Prisma's `cursor` + `skip: 1`, which keys on
 * the id alone and then has no position to continue from when that row was
 * deleted, hidden or re-ranked between two pages (an activity score is
 * rewritten by the stats cycle, a member count moves on every join).
 *
 * The key derives from JWT_SECRET like the registration PoW key: boot
 * already refuses to start without it, and no second secret to rotate.
 */
export interface DiscoveryCursor {
  sort: DiscoverySort;
  /** '' when no tag filter */
  tag: string;
  /** sha1 hex of the trimmed query, '' when none — never the query text */
  q: string;
  /** Page size the cursor was issued for — the depth cap counts ROWS */
  limit: number;
  /** id of the last row of the previous page */
  id: string;
  /** that row's sort-key value: a score or count, an ISO date, or a name */
  key: string | number;
  /** 1-based number of the page this cursor opens */
  page: number;
}

const CURSOR_MAX_LEN = 512;
const KEY_MAX_LEN = 256;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function cursorKey(): Buffer {
  return crypto.createHash('sha256').update(`voxium-discovery-cursor:${process.env.JWT_SECRET!}`).digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', cursorKey()).update(payload).digest('base64url');
}

/** sha1 hex of a search query — the cursor binding and the cache key both use it. */
export function hashDiscoveryQuery(q: string): string {
  return q ? crypto.createHash('sha1').update(q).digest('hex') : '';
}

export function encodeDiscoveryCursor(cursor: DiscoveryCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validKey(sort: DiscoverySort, key: unknown): key is string | number {
  switch (sort) {
    case 'active':
    case 'members':
      return typeof key === 'number' && Number.isInteger(key);
    case 'newest':
      return typeof key === 'string' && key.length <= KEY_MAX_LEN && !Number.isNaN(new Date(key).getTime());
    case 'name':
    default:
      return typeof key === 'string' && key.length <= KEY_MAX_LEN;
  }
}

/**
 * Decode and verify a cursor against the query it must belong to. Null for
 * anything that is not a cursor this server issued for exactly this
 * sort/tag/query/page size: malformed, bad signature, tampered, or borrowed
 * from another listing. A null is a 400 at the route — never a silent first
 * page.
 */
export function decodeDiscoveryCursor(
  token: string,
  expected: { sort: DiscoverySort; tag: string; q: string; limit: number },
): DiscoveryCursor | null {
  // Charset first: only base64url and one dot can be ours, and it keeps the
  // signature compare on equal BYTE lengths (a multi-byte character has the
  // same string length as an ASCII one and would make timingSafeEqual throw).
  if (typeof token !== 'string' || token.length === 0 || token.length > CURSOR_MAX_LEN || !TOKEN_RE.test(token)) return null;
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'utf8');
  const good = Buffer.from(sign(payload), 'utf8');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(mac, good)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c.sort !== 'string' || !(DISCOVERY_SORTS as readonly string[]).includes(c.sort)) return null;
  const sort = c.sort as DiscoverySort;
  if (typeof c.tag !== 'string' || typeof c.q !== 'string' || typeof c.id !== 'string' || c.id.length === 0) return null;
  if (typeof c.page !== 'number' || !Number.isInteger(c.page) || c.page < 2) return null;
  if (typeof c.limit !== 'number' || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > DISCOVERY_MAX_PAGE_SIZE) return null;
  if (!validKey(sort, c.key)) return null;
  if (sort !== expected.sort || c.tag !== expected.tag || c.q !== expected.q || c.limit !== expected.limit) return null;
  return { sort, tag: c.tag, q: c.q, limit: c.limit, id: c.id, key: c.key, page: c.page };
}
