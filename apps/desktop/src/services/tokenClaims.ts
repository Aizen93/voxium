/**
 * The claims of one of our own tokens, read WITHOUT checking its signature:
 * for scheduling a renewal and for routing between the tabs of one browser,
 * never for a decision the server has to make (the server verifies every
 * request). Its own module, free of imports, so the session storage and the
 * renewal can both read a token without an import cycle.
 *
 * - `exp`, `iat`: when the token expires, and the server's "now" when it was
 *   issued (services/session.ts schedules renewals on them);
 * - `userId`: whose session the token belongs to;
 * - `sid`, `gen`: the session the token belongs to and, on a refresh token,
 *   the generation it was issued as. Tokens issued before sessions carry
 *   neither.
 */
export interface TokenClaims {
  exp?: number;
  iat?: number;
  userId?: string;
  sid?: string;
  gen?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The claims of a JWT, or null when the token cannot be decoded. */
export function readTokenClaims(token: string | null | undefined): TokenClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as unknown;
    if (typeof payload !== 'object' || payload === null) return null;
    const claims = payload as Record<string, unknown>;
    return {
      exp: num(claims.exp),
      iat: num(claims.iat),
      userId: str(claims.userId),
      sid: str(claims.sid),
      gen: num(claims.gen),
    };
  } catch {
    // Not an error to report: an undecodable token is sent as is, and the
    // server's answer is the signal (logging it here would be once per
    // request, and the message would quote the token)
    return null;
  }
}

/** The session a token names (`sid`), or null for a token issued before sessions or one that cannot be decoded. */
export function sessionIdOf(token: string | null | undefined): string | null {
  return readTokenClaims(token)?.sid ?? null;
}

/** The account a token belongs to (`userId`), or null when it cannot be decoded. */
export function userIdOf(token: string | null | undefined): string | null {
  return readTokenClaims(token)?.userId ?? null;
}

/**
 * Whether `token` (an access or a refresh token) belongs to the session of
 * the pair: the same `sid` when both name one, else the very same string.
 * A token that names no session is matched by string only, so a pair it
 * cannot be told apart from reads as ANOTHER session: the callers keep that
 * pair rather than remove a session they cannot identify.
 */
export function isSameSession(pair: { accessToken: string; refreshToken: string }, token: string | null | undefined): boolean {
  if (typeof token !== 'string') return false;
  if (token === pair.refreshToken || token === pair.accessToken) return true;
  const sid = sessionIdOf(token);
  if (sid === null) return false;
  return sessionIdOf(pair.refreshToken) === sid || sessionIdOf(pair.accessToken) === sid;
}
