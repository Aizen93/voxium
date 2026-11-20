/*
 * The kinds of token this server signs with its two token secrets (the
 * access secret, JWT_SECRET, and the refresh secret, which only
 * services/sessionService.ts reads), before sign-in sessions existed and
 * since, and the rule that tells an access token from a refresh token by
 * its claims. A token is accepted only as the kind it was issued as,
 * whatever the two secrets are: the check of the signature says who signed
 * it, these say what it is.
 *
 *  kind                  secret    claims besides iat and exp
 *  access, before        access    userId username role tokenVersion
 *  access, sessions      access    userId username role tokenVersion sid
 *  refresh, before       refresh   userId username role tokenVersion
 *                                  rememberMe
 *  refresh, sessions     refresh   userId tokenVersion rememberMe sid gen
 *  two-factor challenge  access    userId purpose rememberMe [cl]
 *  trusted device        access    userId purpose tokenVersion
 *  mail-block link       access    purpose m
 *
 * What separates them:
 *  - only the challenge, the trusted device and the mail-block link carry
 *    `purpose`, and none of them is an access or a refresh token;
 *  - every refresh token carries `rememberMe` (the sign-in signed the value
 *    it was given, or true, since the first release; the refresh copied it
 *    on), and no access token ever has: the minting function of before took
 *    it out of the access token's claims;
 *  - only a refresh token of a session carries `gen`, and it never carries
 *    `username` or `role` (the renewal reads both from the account).
 * A refresh token signed by code older than the first release carried no
 * `rememberMe` and lived 7 days by default: refused as not being one.
 *
 * Pure functions over a verified payload: no I/O, nothing imported, so the
 * middleware, the socket handshake and the limiters can share them.
 */

type Claims = Record<string, unknown>;

/** True when a payload verified with the access secret is an access token. */
export function hasAccessTokenShape(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Claims;
  return p.purpose === undefined && p.rememberMe === undefined && p.gen === undefined;
}

/**
 * The era of a payload verified with the refresh secret: 'session' for a
 * refresh token of a session, 'legacy' for one issued before sessions, null
 * for anything that is not a refresh token. Says nothing about the claims'
 * values: the session service checks those.
 */
export function refreshTokenShape(payload: unknown): 'session' | 'legacy' | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Claims;
  if (p.purpose !== undefined || p.rememberMe === undefined) return null;
  if (p.sid === undefined) return p.gen === undefined ? 'legacy' : null;
  if (p.username !== undefined || p.role !== undefined) return null;
  return 'session';
}
