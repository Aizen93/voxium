// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isAuthRefusal } from '../../services/authRefusal';
import { SessionLostError } from '../../services/session';

// The one test of "signed out" for an answer of the REST client, shared by
// the session restore (authStore) and the screen of a tab that waited for its
// vault (VaultOwnershipGate).

const answer = (status: number, config: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status }, config });

describe('isAuthRefusal', () => {
  it('is a refusal: a 401 or a 403, and a renewal refused for good', () => {
    expect(isAuthRefusal(answer(401))).toBe(true);
    expect(isAuthRefusal(answer(403))).toBe(true);
    expect(isAuthRefusal(answer(403, { _renewalFailed: true }))).toBe(true);
    expect(isAuthRefusal(new SessionLostError('Refresh refused'))).toBe(true);
  });

  it('is no refusal: a 401 to a request sent after its renewal failed for a passing reason (the refresh token never judged)', () => {
    expect(isAuthRefusal(answer(401, { _renewalFailed: true }))).toBe(false);
  });

  it('is no refusal: no answer, another status, or nothing at all', () => {
    expect(isAuthRefusal(new Error('Network Error'))).toBe(false);
    expect(isAuthRefusal(answer(429))).toBe(false);
    expect(isAuthRefusal(answer(503))).toBe(false);
    expect(isAuthRefusal(null)).toBe(false);
    expect(isAuthRefusal(undefined)).toBe(false);
  });
});
