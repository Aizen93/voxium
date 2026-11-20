import { describe, it, expect } from 'vitest';
import { hasAccessTokenShape, refreshTokenShape } from '../../utils/tokenShapes';

/**
 * One case per kind of token the server has signed, before sign-in sessions
 * and since (the table in utils/tokenShapes.ts), with the claims each one
 * carries after jsonwebtoken added iat and exp. Every token a correct
 * deployment issued is accepted as its own kind and refused as the other,
 * whatever the two secrets are.
 */
const iatExp = { iat: 1_790_000_000, exp: 1_790_000_900 };
const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';

const SHAPES = {
  'access, before sessions': { userId: 'u', username: 'alice', role: 'user', tokenVersion: 3, ...iatExp },
  'access, sessions': { userId: 'u', username: 'alice', role: 'user', tokenVersion: 3, sid: SID, ...iatExp },
  'refresh, before sessions': { userId: 'u', username: 'alice', role: 'user', tokenVersion: 3, rememberMe: true, ...iatExp },
  'refresh, before sessions, not remembered': { userId: 'u', username: 'alice', role: 'user', tokenVersion: 3, rememberMe: false, ...iatExp },
  // The sign-in signed the body's value as it came: null and other values exist
  'refresh, before sessions, rememberMe null': { userId: 'u', username: 'alice', role: 'user', tokenVersion: 3, rememberMe: null, ...iatExp },
  'refresh, sessions': { userId: 'u', tokenVersion: 3, rememberMe: true, sid: SID, gen: 4, ...iatExp },
  'two-factor challenge': { userId: 'u', purpose: 'totp-verify', rememberMe: true, cl: { k: 'web', o: 'linux' }, iat: 1, exp: 301 },
  'two-factor challenge, before labels': { userId: 'u', purpose: 'totp-verify', rememberMe: true, iat: 1, exp: 301 },
  'trusted device': { userId: 'u', purpose: 'trusted-device', tokenVersion: 3, ...iatExp },
  'mail-block link': { purpose: 'mail-block', m: 'a'.repeat(64), ...iatExp },
} as const;

describe('tokenShapes — every kind of token, before sessions and since', () => {
  it.each([
    ['access, before sessions', true, null],
    ['access, sessions', true, null],
    ['refresh, before sessions', false, 'legacy'],
    ['refresh, before sessions, not remembered', false, 'legacy'],
    ['refresh, before sessions, rememberMe null', false, 'legacy'],
    ['refresh, sessions', false, 'session'],
    ['two-factor challenge', false, null],
    ['two-factor challenge, before labels', false, null],
    ['trusted device', false, null],
    ['mail-block link', false, null],
  ] as const)('%s: an access token %s, a refresh token of era %s', (kind, access, refresh) => {
    const payload = SHAPES[kind];
    expect(hasAccessTokenShape(payload)).toBe(access);
    expect(refreshTokenShape(payload)).toBe(refresh);
  });

  it('a refresh shape of a session that also carries the access token\'s claims is neither', () => {
    for (const extra of [{ username: 'alice' }, { role: 'admin' }]) {
      const payload = { ...SHAPES['refresh, sessions'], ...extra };
      expect(refreshTokenShape(payload)).toBeNull();
      expect(hasAccessTokenShape(payload)).toBe(false);
    }
  });

  it('a generation without a session id is not a refresh token, and never an access token', () => {
    const payload = { ...SHAPES['refresh, before sessions'], gen: 1 };
    expect(refreshTokenShape(payload)).toBeNull();
    expect(hasAccessTokenShape({ ...SHAPES['access, sessions'], gen: 1 })).toBe(false);
  });

  it('an access shape carrying rememberMe (only a refresh token does) is not an access token', () => {
    expect(hasAccessTokenShape({ ...SHAPES['access, before sessions'], rememberMe: false })).toBe(false);
  });

  it('a refresh token signed by code older than the first release (no rememberMe) is not taken for one', () => {
    expect(refreshTokenShape({ userId: 'u', username: 'alice', ...iatExp })).toBeNull();
  });

  it('anything that is not an object is neither', () => {
    for (const p of [null, undefined, 'token', 7, true]) {
      expect(hasAccessTokenShape(p)).toBe(false);
      expect(refreshTokenShape(p)).toBeNull();
    }
  });
});
