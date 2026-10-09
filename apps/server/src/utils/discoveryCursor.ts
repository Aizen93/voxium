import crypto from 'crypto';
import { DISCOVERY_SORTS, type DiscoverySort } from '@voxium/shared';

/**
 * The directory pages with KEYSET cursors (Prisma `cursor` + `skip: 1`), never
 * OFFSET: page 40 costs the same as page 1 at any table size. The cursor the
 * client hands back is opaque and SIGNED so it cannot be edited into a
 * different query, a deeper page or an arbitrary id:
 *
 *   base64url(JSON) "." base64url(HMAC-SHA256(JSON))
 *
 * It is bound to the sort, the tag and the (hashed) search query it was
 * issued for, and carries the page number that enforces DISCOVERY_MAX_PAGES.
 * The key derives from JWT_SECRET like the registration PoW key: boot already
 * refuses to start without it, and no second secret to rotate.
 */
export interface DiscoveryCursor {
  sort: DiscoverySort;
  /** '' when no tag filter */
  tag: string;
  /** sha1 hex of the trimmed query, '' when none — never the query text */
  q: string;
  /** id of the last row of the previous page */
  id: string;
  /** 1-based number of the page this cursor opens */
  page: number;
}

const CURSOR_MAX_LEN = 512;

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

/**
 * Decode and verify a cursor against the query it must belong to. Null for
 * anything that is not a cursor this server issued for exactly this
 * sort/tag/query: malformed, bad signature, tampered, or borrowed from
 * another listing. A null is a 400 at the route — never a silent first page.
 */
export function decodeDiscoveryCursor(
  token: string,
  expected: { sort: DiscoverySort; tag: string; q: string },
): DiscoveryCursor | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > CURSOR_MAX_LEN) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const good = sign(payload);
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c.sort !== 'string' || !(DISCOVERY_SORTS as readonly string[]).includes(c.sort)) return null;
  if (typeof c.tag !== 'string' || typeof c.q !== 'string' || typeof c.id !== 'string' || c.id.length === 0) return null;
  if (typeof c.page !== 'number' || !Number.isInteger(c.page) || c.page < 2) return null;
  if (c.sort !== expected.sort || c.tag !== expected.tag || c.q !== expected.q) return null;
  return { sort: c.sort as DiscoverySort, tag: c.tag, q: c.q, id: c.id, page: c.page };
}
