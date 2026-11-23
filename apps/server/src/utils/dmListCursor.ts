import crypto from 'crypto';
import { encodeSignedCursor, decodeSignedCursor } from './signedCursor';

/**
 * The conversation list (GET /dm, paged mode) pages in (updated_at, id)
 * order, newest first. The cursor carries the last row's full key, so the
 * next page is an explicit "strictly after" predicate, never an OFFSET or a
 * Prisma cursor, and it is bound to the account it was issued to by a digest
 * of the account id (the other side of a conversation never enters it).
 */
export interface DmListCursor {
  /** first 32 hex digits of the SHA-256 of the account the page was served to */
  a: string;
  /** ISO time of the last row's updated_at */
  updatedAt: string;
  /** the last conversation's id */
  id: string;
}

const SCOPE = 'dm-list';
const ID_MAX_LEN = 64;
const ACCOUNT_DIGEST_RE = /^[0-9a-f]{32}$/;

export function dmListAccountDigest(userId: string): string {
  return crypto.createHash('sha256').update(`dm-list:${userId}`).digest('hex').slice(0, 32);
}

export function encodeDmListCursor(userId: string, key: { updatedAt: Date; id: string }): string {
  const cursor: DmListCursor = { a: dmListAccountDigest(userId), updatedAt: key.updatedAt.toISOString(), id: key.id };
  return encodeSignedCursor(SCOPE, cursor);
}

/** Null for anything that is not a cursor this server issued to this account for this list. A null is a 400 at the route. */
export function decodeDmListCursor(token: unknown, userId: string): { updatedAt: Date; id: string } | null {
  const c = decodeSignedCursor(SCOPE, token);
  if (!c) return null;
  if (typeof c.a !== 'string' || !ACCOUNT_DIGEST_RE.test(c.a) || c.a !== dmListAccountDigest(userId)) return null;
  if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > ID_MAX_LEN) return null;
  if (typeof c.updatedAt !== 'string' || c.updatedAt.length > ID_MAX_LEN) return null;
  const at = new Date(c.updatedAt);
  if (Number.isNaN(at.getTime())) return null;
  return { updatedAt: at, id: c.id };
}
