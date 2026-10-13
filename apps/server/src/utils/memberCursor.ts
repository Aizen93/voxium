import crypto from 'crypto';
import { LIMITS } from '@voxium/shared';
import { encodeSignedCursor, decodeSignedCursor } from './signedCursor';

/**
 * The member directory (GET /servers/:id/members, keyset mode) pages in
 * (role rank, joined_at, user_id) order — owner, then admins, then everyone
 * by join date — and the cursor carries the last row's full key so the next
 * page is an explicit "strictly after" predicate, not an OFFSET that skips or
 * repeats rows when someone joins or leaves between two pages. It is bound to
 * the server, the (hashed) search text, the role filter and the page size it
 * was issued for.
 */
export interface MemberCursor {
  serverId: string;
  /** sha1 hex of the trimmed query, '' when none — never the text itself */
  q: string;
  /** '' when unfiltered; otherwise 'owner' | 'admin' | 'none' | a role id */
  role: string;
  limit: number;
  /** 0 owner, 1 admin, 2 member */
  rank: number;
  /** ISO timestamp of the last row's joined_at */
  joinedAt: string;
  /** the last row's user id */
  id: string;
}

const SCOPE = 'members';
const ID_MAX_LEN = 64;

/** The ORDER BY position of a coarse role: owner first, admins next. */
export function memberRoleRank(role: string): number {
  return role === 'owner' ? 0 : role === 'admin' ? 1 : 2;
}

export function hashMemberQuery(q: string): string {
  return q ? crypto.createHash('sha1').update(q).digest('hex') : '';
}

export function encodeMemberCursor(cursor: MemberCursor): string {
  return encodeSignedCursor(SCOPE, cursor);
}

/**
 * Null for anything that is not a cursor this server issued for exactly this
 * server/query/filter/page size. A null is a 400 at the route.
 */
export function decodeMemberCursor(
  token: unknown,
  expected: { serverId: string; q: string; role: string; limit: number },
): MemberCursor | null {
  const c = decodeSignedCursor(SCOPE, token);
  if (!c) return null;
  if (typeof c.serverId !== 'string' || typeof c.q !== 'string' || typeof c.role !== 'string') return null;
  if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > ID_MAX_LEN) return null;
  if (typeof c.rank !== 'number' || !Number.isInteger(c.rank) || c.rank < 0 || c.rank > 2) return null;
  if (typeof c.joinedAt !== 'string' || c.joinedAt.length > ID_MAX_LEN || Number.isNaN(new Date(c.joinedAt).getTime())) return null;
  if (typeof c.limit !== 'number' || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > LIMITS.MEMBERS_PER_PAGE) return null;
  if (c.serverId !== expected.serverId || c.q !== expected.q || c.role !== expected.role || c.limit !== expected.limit) return null;
  return { serverId: c.serverId, q: c.q, role: c.role, limit: c.limit, rank: c.rank, joinedAt: c.joinedAt, id: c.id };
}
