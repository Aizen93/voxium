import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { TEST_JWT_SECRET } from '../helpers/testSecrets';

// `authenticate` for an access token that names its sign-in session (`sid`):
// the session row is read with the account, in one statement, and a session
// that ended refuses the token at once instead of letting it live out its
// minutes. A token issued before sessions keeps the account checks alone.

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../../utils/prisma', () => ({ prisma: { user: { findUnique } } }));

import { authenticate } from '../../middleware/auth';

const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';
const ACCOUNT_GATE_SELECT = { bannedAt: true, tokenVersion: true, role: true, emailVerified: true, termsAcceptedAt: true, privacyAcceptedAt: true };
const account = { bannedAt: null, tokenVersion: 2, role: 'admin', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) };

function token(over: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 2, sid: SID, ...over }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
}

async function run(bearer: string) {
  const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as Request;
  const next = vi.fn();
  await authenticate(req, {} as Response, next as unknown as NextFunction);
  return { req, err: next.mock.calls[0]?.[0] as { statusCode?: number; message?: string } | undefined, next };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authenticate — the session an access token names', () => {
  it('a live session: one read of the account and that session; req.user carries the session id', async () => {
    findUnique.mockResolvedValueOnce({ ...account, sessions: [{ tokenVersion: 2, expiresAt: new Date(Date.now() + 3_600_000) }] });

    const { req, err, next } = await run(token());

    expect(next).toHaveBeenCalledWith();
    expect(err).toBeUndefined();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { ...ACCOUNT_GATE_SELECT, sessions: { where: { id: SID }, select: { tokenVersion: true, expiresAt: true }, take: 1 } },
    });
    expect(req.user).toMatchObject({ userId: 'user-1', sid: SID, role: 'admin', emailVerified: true, consentRequired: false });
  });

  it.each([
    ['ended (signed out, a reused refresh token, the cap)', []],
    ['left behind by a version bump', [{ tokenVersion: 1, expiresAt: new Date(Date.now() + 3_600_000) }]],
    ['expired', [{ tokenVersion: 2, expiresAt: new Date(Date.now() - 1000) }]],
  ])("a session %s: 401 'Session invalidated' (the client renews, is refused, signs out)", async (_what, sessions) => {
    findUnique.mockResolvedValueOnce({ ...account, sessions });
    const { err, req } = await run(token());
    expect(err).toMatchObject({ statusCode: 401, message: 'Session invalidated' });
    expect(req.user).toBeUndefined();
  });

  it('a token issued before sessions (no sid): the account read alone, as before; no session refusal', async () => {
    findUnique.mockResolvedValueOnce(account);
    const { err, req } = await run(token({ sid: undefined }));
    expect(err).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: ACCOUNT_GATE_SELECT });
    expect(req.user?.sid).toBeUndefined();
  });

  it('a session id no signer of ours writes: refused as an unusable token, nothing read', async () => {
    for (const sid of ['', 'a:b', 7, { id: SID }, 'x'.repeat(65)]) {
      const { err } = await run(token({ sid }));
      expect(err, JSON.stringify(sid)).toMatchObject({ statusCode: 401, message: 'Invalid or expired token' });
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('the account checks come first, as before: gone 401, banned 403, another token version 401', async () => {
    findUnique.mockResolvedValueOnce(null);
    expect((await run(token())).err).toMatchObject({ statusCode: 401, message: 'User not found' });
    findUnique.mockResolvedValueOnce({ ...account, bannedAt: new Date(), sessions: [] });
    expect((await run(token())).err).toMatchObject({ statusCode: 403 });
    findUnique.mockResolvedValueOnce({ ...account, tokenVersion: 3, sessions: [{ tokenVersion: 3, expiresAt: new Date(Date.now() + 60_000) }] });
    expect((await run(token())).err).toMatchObject({ statusCode: 401, message: 'Session invalidated' });
  });

  it('a failing lookup is passed on as the error it is: never a 401, never a session refusal', async () => {
    const failure = Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError' });
    findUnique.mockRejectedValueOnce(failure);
    const { err } = await run(token());
    expect(err).toBe(failure);
    expect(err?.statusCode).toBeUndefined();
  });

  it('a token with a purpose (trusted device, two-factor challenge) stays refused, sid or not', async () => {
    for (const purpose of ['trusted-device', 'totp-verify']) {
      const { err } = await run(token({ purpose }));
      expect(err).toMatchObject({ statusCode: 401, message: 'Invalid token type' });
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('a refresh token is never an access token, whatever the secrets (signed here with the access secret, as equal secrets would)', async () => {
    const refreshShapes = [
      // a session's: rememberMe and gen, no username or role
      { userId: 'user-1', tokenVersion: 2, rememberMe: true, sid: SID, gen: 3 },
      // one of before sessions: the access claims and rememberMe
      { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 2, rememberMe: true },
      { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 2, rememberMe: false },
    ];
    for (const payload of refreshShapes) {
      const bearer = jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
      const { err, req } = await run(bearer);
      expect(err, JSON.stringify(payload)).toMatchObject({ statusCode: 401, message: 'Invalid token type' });
      expect(req.user).toBeUndefined();
    }
    // A gen alone is enough to refuse it
    expect((await run(token({ gen: 1 }))).err).toMatchObject({ statusCode: 401, message: 'Invalid token type' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('every access token a correct deployment issued is accepted: the shape of before and the session shape', async () => {
    findUnique.mockResolvedValueOnce(account);
    expect((await run(token({ sid: undefined }))).err).toBeUndefined();
    findUnique.mockResolvedValueOnce({ ...account, sessions: [{ tokenVersion: 2, expiresAt: new Date(Date.now() + 60_000) }] });
    expect((await run(token())).err).toBeUndefined();
  });
});
