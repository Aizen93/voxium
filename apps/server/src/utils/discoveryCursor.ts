import crypto from 'crypto';
import { DISCOVERY_SORTS, DISCOVERY_MAX_PAGE_SIZE, type DiscoverySort } from '@voxium/shared';
import { encodeSignedCursor, decodeSignedCursor } from './signedCursor';

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
 * The signing lives in signedCursor.ts (one implementation for every
 * listing, each under its own scope); this module owns the discovery
 * payload and its validation.
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

const KEY_MAX_LEN = 256;
const SCOPE = 'discovery';

/** sha1 hex of a search query — the cursor binding and the cache key both use it. */
export function hashDiscoveryQuery(q: string): string {
  return q ? crypto.createHash('sha1').update(q).digest('hex') : '';
}

export function encodeDiscoveryCursor(cursor: DiscoveryCursor): string {
  return encodeSignedCursor(SCOPE, cursor);
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
  const c = decodeSignedCursor(SCOPE, token);
  if (!c) return null;
  if (typeof c.sort !== 'string' || !(DISCOVERY_SORTS as readonly string[]).includes(c.sort)) return null;
  const sort = c.sort as DiscoverySort;
  if (typeof c.tag !== 'string' || typeof c.q !== 'string' || typeof c.id !== 'string' || c.id.length === 0) return null;
  if (typeof c.page !== 'number' || !Number.isInteger(c.page) || c.page < 2) return null;
  if (typeof c.limit !== 'number' || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > DISCOVERY_MAX_PAGE_SIZE) return null;
  if (!validKey(sort, c.key)) return null;
  if (sort !== expected.sort || c.tag !== expected.tag || c.q !== expected.q || c.limit !== expected.limit) return null;
  return { sort, tag: c.tag, q: c.q, limit: c.limit, id: c.id, key: c.key, page: c.page };
}
