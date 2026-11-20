import { describe, it, expect, afterEach } from 'vitest';
import { readTokenClaims, sessionIdOf, userIdOf, isSameSession } from '../../services/tokenClaims';
import { sessionClientHint } from '../../services/sessionClient';

/** A JWT-shaped string carrying `claims` (unsigned: only the claims are read). */
function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

describe('tokenClaims — reading our own tokens for routing, never for trust', () => {
  it('reads exp, iat, userId, sid and gen', () => {
    expect(readTokenClaims(jwt({ exp: 10, iat: 5, userId: 'u-1', sid: 's-1', gen: 3 }))).toEqual({ exp: 10, iat: 5, userId: 'u-1', sid: 's-1', gen: 3 });
  });

  it('leaves out claims of the wrong type, and answers null for anything that is not a three-part token with a JSON object', () => {
    expect(readTokenClaims(jwt({ exp: 'soon', userId: 7, sid: '', gen: 'two' }))).toEqual({ exp: undefined, iat: undefined, userId: undefined, sid: undefined, gen: undefined });
    expect(readTokenClaims('not-a-jwt')).toBeNull();
    expect(readTokenClaims('a.b.c')).toBeNull();
    expect(readTokenClaims(`h.${btoa('"text"')}.s`)).toBeNull();
    expect(readTokenClaims(null)).toBeNull();
  });

  it('a token issued before sessions names no session', () => {
    expect(sessionIdOf(jwt({ userId: 'u-1' }))).toBeNull();
    expect(userIdOf(jwt({ userId: 'u-1' }))).toBe('u-1');
    expect(userIdOf('garbage')).toBeNull();
  });

  it('isSameSession: the same sid (any generation, access or refresh token), or the very same string', () => {
    const pair = { accessToken: jwt({ userId: 'u', sid: 's-1' }), refreshToken: jwt({ userId: 'u', sid: 's-1', gen: 4 }) };
    expect(isSameSession(pair, jwt({ userId: 'u', sid: 's-1', gen: 2 }))).toBe(true);
    expect(isSameSession(pair, pair.accessToken)).toBe(true);
    expect(isSameSession(pair, jwt({ userId: 'u', sid: 's-2', gen: 4 }))).toBe(false);
    expect(isSameSession(pair, null)).toBe(false);

    // Without a sid only the string identifies the session
    const legacy = { accessToken: 'a-legacy', refreshToken: 'r-legacy' };
    expect(isSameSession(legacy, 'r-legacy')).toBe(true);
    expect(isSameSession(legacy, 'r-other')).toBe(false);
    expect(isSameSession(legacy, jwt({ sid: 's-1' }))).toBe(false);
  });
});

describe('sessionClientHint — the kind of app the sign-in and renewal bodies name', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("is 'web' in a browser and 'desktop' in the Tauri app, read at each call", () => {
    expect(sessionClientHint()).toBe('web');
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(sessionClientHint()).toBe('desktop');
  });
});
