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

  it('a token issued before sessions matches a pair of its account only for an end of the whole account', () => {
    const pair = { accessToken: jwt({ userId: 'u', sid: 's-1' }), refreshToken: jwt({ userId: 'u', sid: 's-1', gen: 4 }) };
    const beforeSessions = jwt({ userId: 'u', exp: 10 });

    // one session ended: a token that names none cannot be told to be this one
    expect(isSameSession(pair, beforeSessions)).toBe(false);
    expect(isSameSession(pair, beforeSessions, { accountWide: false })).toBe(false);
    // the whole account ended (a ban, a deletion): the account's stored pair is that token's session
    expect(isSameSession(pair, beforeSessions, { accountWide: true })).toBe(true);
    // never another account's, never one that names no account, never one it cannot read
    expect(isSameSession(pair, jwt({ userId: 'v', exp: 10 }), { accountWide: true })).toBe(false);
    expect(isSameSession(pair, jwt({ exp: 10 }), { accountWide: true })).toBe(false);
    expect(isSameSession(pair, 'opaque-legacy', { accountWide: true })).toBe(false);
    expect(isSameSession({ accessToken: 'a-opaque', refreshToken: 'r-opaque' }, beforeSessions, { accountWide: true })).toBe(false);
  });

  it('an end of the whole account matches any pair of that account, a token of another of its sessions included', () => {
    const pair = { accessToken: jwt({ userId: 'u', sid: 's-1' }), refreshToken: jwt({ userId: 'u', sid: 's-1', gen: 4 }) };
    const ofAnotherSession = jwt({ userId: 'u', sid: 's-2', gen: 1 });

    // one session ended: another session of the account is not it
    expect(isSameSession(pair, ofAnotherSession)).toBe(false);
    // the account ended: every session of it ended, the one this pair is of included
    expect(isSameSession(pair, ofAnotherSession, { accountWide: true })).toBe(true);
    // ... never another account's session
    expect(isSameSession(pair, jwt({ userId: 'v', sid: 's-1', gen: 1 }), { accountWide: true })).toBe(false);
  });

  it('an end of the whole account reads the account from either token of the pair', () => {
    const ended = jwt({ userId: 'u', sid: 's-2', gen: 1 });
    // only the refresh token names the account
    expect(isSameSession({ accessToken: 'opaque', refreshToken: jwt({ userId: 'u', sid: 's-9', gen: 1 }) }, ended, { accountWide: true })).toBe(true);
    // only the access token names it
    expect(isSameSession({ accessToken: jwt({ userId: 'u', sid: 's-9' }), refreshToken: 'opaque' }, ended, { accountWide: true })).toBe(true);
    // neither names it
    expect(isSameSession({ accessToken: jwt({ userId: 'v', sid: 's-9' }), refreshToken: 'opaque' }, ended, { accountWide: true })).toBe(false);
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
