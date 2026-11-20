import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OPAQUE_ID_RE, SESSIONS, SESSION_ENDED_REASON } from '@voxium/shared';
import { TEST_JWT_SECRET, TEST_JWT_REFRESH_SECRET } from '../helpers/testSecrets';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// The statements are mocked (their SQL is pinned in sessionStore.test.ts and
// was run against a real PostgreSQL 16): what is under test is every decision
// the service makes on what they return.

const store = vi.hoisted(() => ({
  insertSession: vi.fn(),
  readSessionForRefresh: vi.fn(),
  rotateSession: vi.fn(),
  rekeySession: vi.fn(),
  deleteSession: vi.fn(),
  deleteStaleSession: vi.fn(),
  deleteExpiredSession: vi.fn(),
  evictSessionsBeyond: vi.fn(),
  readLegacyRedemption: vi.fn(),
  claimLegacyRedemption: vi.fn(),
  linkLegacyRedemption: vi.fn(),
  spendLegacyRedemption: vi.fn(),
  listLiveSessions: vi.fn(),
  deleteOtherSessions: vi.fn(),
}));
vi.mock('../../utils/sessionStore', () => store);

const flags = vi.hoisted(() => ({ enforce: false }));
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn((name: string) => (name === 'refresh_reuse_revocation' ? flags.enforce : false)),
}));

const revoke = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionRevocation', () => ({ revokeSessionSockets: (...a: unknown[]) => revoke(...a) }));

const db = vi.hoisted(() => {
  const tx = { tx: 'the transaction client' };
  return { tx, prisma: { user: { findUnique: vi.fn() }, $transaction: vi.fn() } };
});
vi.mock('../../utils/prisma', () => ({ prisma: db.prisma }));

import * as svc from '../../services/sessionService';
import { isFeatureEnabled } from '../../utils/featureFlags';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY = 86_400;
const SID = 'Qm9vdHN0cmFwU2Vzc2lvbg';
const LABEL = { kind: 'web', os: 'linux' } as const;
const ACCOUNT = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0 };
const nowS = () => Math.floor(Date.now() / 1000);

/** A refresh token as the service signs one. */
function refreshToken(over: Record<string, unknown> = {}, secret = TEST_JWT_REFRESH_SECRET, algorithm: jwt.Algorithm = 'HS256'): string {
  return jwt.sign({ userId: 'user-1', tokenVersion: 0, rememberMe: true, sid: SID, gen: 3, exp: nowS() + 30 * DAY, ...over }, secret, { algorithm });
}

/**
 * The refresh token the server issued BEFORE sessions: `generateTokens` as it
 * stood, copied here as the fixture (its access payload, rememberMe added,
 * JWT_REFRESH_EXPIRES_IN || '30d', signed with JWT_REFRESH_SECRET).
 */
function preSessionRefreshToken(payload = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0 }, rememberMe = true): string {
  const refreshExpiry = rememberMe ? (process.env.JWT_REFRESH_EXPIRES_IN || '30d') : '24h';
  return jwt.sign({ ...payload, rememberMe }, process.env.JWT_REFRESH_SECRET!, { expiresIn: refreshExpiry } as jwt.SignOptions);
}

function row(over: Record<string, unknown> = {}) {
  return {
    generation: 3, rowVersion: 0, rememberMe: true, clientKind: 'desktop', expired: false, withinGrace: false,
    secondsSinceRotation: 900, exp: nowS() + 29 * DAY, username: 'alice', role: 'user', accountVersion: 0, banned: false,
    ...over,
  };
}

const ctx = (over: Partial<svc.RefreshContext> = {}): svc.RefreshContext => ({
  isClientGone: () => false, hinted: false, label: LABEL, ...over,
});

const decode = (t: string) => jwt.decode(t) as Record<string, unknown>;
const verifyRefresh = (t: string) => jwt.verify(t, TEST_JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
const verifyAccess = (t: string) => jwt.verify(t, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;

async function refusal(p: Promise<unknown>): Promise<{ statusCode?: number; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { statusCode?: number; message: string };
  }
  throw new Error('expected a refusal');
}

/** A raw statement's foreign-key refusal, as the pg driver adapter reports it (measured). */
function rawFkError(constraint: string) {
  return Object.assign(new Error(`Raw query failed. Code: \`23503\`. Message: \`insert or update on table "sessions" violates foreign key constraint "${constraint}"\``), {
    code: 'P2010',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23503', kind: 'ForeignKeyConstraintViolation', constraint: { index: constraint } } } },
  });
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  flags.enforce = false;
  savedEnv.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;
  savedEnv.JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN;
  delete process.env.JWT_EXPIRES_IN;
  delete process.env.JWT_REFRESH_EXPIRES_IN;
  store.insertSession.mockImplementation(async (_db: unknown, r: { id: string; rememberMe: boolean; idleSeconds: number }) => ({ id: r.id, generation: 1, rememberMe: r.rememberMe, exp: nowS() + r.idleSeconds }));
  store.rotateSession.mockImplementation(async (_db: unknown, a: { sid: string; toGeneration: number; idleSeconds: number }) => ({ id: a.sid, generation: a.toGeneration, rememberMe: true, exp: nowS() + a.idleSeconds }));
  store.rekeySession.mockImplementation(async (_db: unknown, a: { sid: string }) => ({ id: a.sid, generation: 5, rememberMe: false, exp: nowS() + DAY }));
  store.deleteSession.mockResolvedValue(1);
  store.deleteStaleSession.mockResolvedValue(1);
  store.deleteExpiredSession.mockResolvedValue(1);
  store.evictSessionsBeyond.mockResolvedValue([]);
  store.readLegacyRedemption.mockResolvedValue(null);
  store.claimLegacyRedemption.mockResolvedValue(true);
  store.linkLegacyRedemption.mockResolvedValue(1);
  store.spendLegacyRedemption.mockResolvedValue([]);
  db.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db.tx));
  db.prisma.user.findUnique.mockResolvedValue({ id: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, bannedAt: null });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── Signing and lifetimes ──────────────────────────────────────────────────

describe('sessionService — the tokens it signs', () => {
  it('a sign-in writes generation 1 of a new session and signs its pair: access names the session, refresh its generation', async () => {
    const opened = await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });

    const access = verifyAccess(opened.tokens.accessToken);
    const refresh = verifyRefresh(opened.tokens.refreshToken);
    expect(access).toMatchObject({ userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, sid: opened.sessionId });
    expect(access.exp as number - (access.iat as number)).toBe(15 * 60);
    // Only what a renewal reads: no username, no role (re-read from the account)
    expect(Object.keys(refresh).sort()).toEqual(['exp', 'gen', 'iat', 'rememberMe', 'sid', 'tokenVersion', 'userId']);
    expect(refresh).toMatchObject({ userId: 'user-1', tokenVersion: 0, rememberMe: true, sid: opened.sessionId, gen: 1 });
    // The token's exp IS the row's expiry
    const inserted = await store.insertSession.mock.results[0].value;
    expect(refresh.exp).toBe(inserted.exp);
  });

  it('a session id is 128 random bits in base64url, within OPAQUE_ID_RE, and never repeats', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { sessionId } = await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(OPAQUE_ID_RE.test(sessionId)).toBe(true);
      ids.add(sessionId);
    }
    expect(ids.size).toBe(50);
  });

  it('the row is written with the idle window of its "Remember me" (30 days, 24 hours) and the 365-day cap', async () => {
    await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });
    await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: false, label: { kind: 'desktop', os: 'windows' }, accountGoneMessage: 'x' });

    expect(store.insertSession.mock.calls[0][1]).toMatchObject({
      userId: 'user-1', rememberMe: true, tokenVersion: 0, clientKind: 'web', clientOs: 'linux',
      idleSeconds: 30 * DAY, maxAgeSeconds: SESSIONS.MAX_AGE_DAYS * DAY,
    });
    expect(store.insertSession.mock.calls[1][1]).toMatchObject({ rememberMe: false, idleSeconds: DAY, clientKind: 'desktop', clientOs: 'windows' });
  });

  it('JWT_REFRESH_EXPIRES_IN and JWT_EXPIRES_IN are read in jsonwebtoken\'s own notation', async () => {
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.JWT_EXPIRES_IN = '5m';
    const opened = await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });
    expect(store.insertSession.mock.calls[0][1].idleSeconds).toBe(7 * DAY);
    const access = verifyAccess(opened.tokens.accessToken);
    expect(access.exp as number - (access.iat as number)).toBe(300);

    process.env.JWT_REFRESH_EXPIRES_IN = '2 days';
    await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });
    expect(store.insertSession.mock.calls[1][1].idleSeconds).toBe(2 * DAY);
    // "Remember me" off ignores the setting, as before
    await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: false, label: LABEL, accountGoneMessage: 'x' });
    expect(store.insertSession.mock.calls[2][1].idleSeconds).toBe(DAY);
  });

  it('a lifetime jsonwebtoken cannot read fails the sign-in (500), as it always did, and writes nothing', async () => {
    process.env.JWT_REFRESH_EXPIRES_IN = 'forever';
    await expect(svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' })).rejects.not.toMatchObject({ statusCode: 401 });
    expect(store.insertSession).not.toHaveBeenCalled();
  });

  it('an account deleted while the sign-in ran (the insert\'s key to it refused) answers the sign-in\'s own 401', async () => {
    store.insertSession.mockRejectedValueOnce(rawFkError('sessions_user_id_fkey'));
    const err = await refusal(svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'Invalid credentials' }));
    expect(err).toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
  });

  it('any other failure of the insert is thrown as it is (500, never 401)', async () => {
    for (const failure of [rawFkError('some_other_fkey'), new Error('connection reset'), Object.assign(new Error('Raw query failed. Code: `57014`.'), { code: 'P2010' })]) {
      store.insertSession.mockRejectedValueOnce(failure);
      const err = await refusal(svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'Invalid credentials' }));
      expect(err).toBe(failure);
      expect(err.statusCode).toBeUndefined();
    }
  });
});

describe('sessionService — the cap', () => {
  it('createSession keeps the account at the cap: the others beyond 24 go, the new one never, their sockets are ended', async () => {
    store.evictSessionsBeyond.mockResolvedValueOnce(['old-1', 'old-2']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const tokens = await svc.createSession(ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });

    const sid = decode(tokens.refreshToken).sid;
    expect(store.evictSessionsBeyond).toHaveBeenCalledWith(db.prisma, 'user-1', sid, SESSIONS.MAX_PER_ACCOUNT - 1);
    // One call for the account: the evicted sessions' rooms, and its sockets
    // that name no session (sessionRevocation.ts)
    expect(revoke.mock.calls).toEqual([['user-1', ['old-1', 'old-2'], SESSION_ENDED_REASON]]);
    // The trim follows the write
    expect(store.insertSession.mock.invocationCallOrder[0]).toBeLessThan(store.evictSessionsBeyond.mock.invocationCallOrder[0]);
    log.mockRestore();
  });

  it('a trim that fails is logged and never refuses the sign-in', async () => {
    store.evictSessionsBeyond.mockRejectedValueOnce(new Error('deadlock detected'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(svc.createSession(ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' })).resolves.toHaveProperty('accessToken');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not trim'), 'deadlock detected');
    expect(revoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── Labels ─────────────────────────────────────────────────────────────────

describe('sessionService — the label of a session', () => {
  it('the client\'s own hint wins, from the closed list; anything else is ignored, never refused', () => {
    expect(svc.deriveSessionLabel({ hint: 'admin', origin: 'https://tauri.localhost' }).kind).toBe('admin');
    for (const hint of ['ios', 'android', 'desktop', 'web']) expect(svc.deriveSessionLabel({ hint }).kind).toBe(hint);
    for (const hint of ['unknown', 'Desktop', 'watch', 42, {}, ['web'], null]) {
      expect(svc.deriveSessionLabel({ hint, origin: 'https://app.example.org' }).kind, JSON.stringify(hint)).toBe('web');
    }
    expect(svc.readClientHint('web')).toBe('web');
    expect(svc.readClientHint('unknown')).toBeNull();
  });

  it('without a hint: the desktop webview\'s origins mean desktop, any other origin web, none unknown', () => {
    for (const origin of ['https://tauri.localhost', 'http://tauri.localhost', 'tauri://localhost', 'HTTPS://TAURI.LOCALHOST']) {
      expect(svc.deriveSessionLabel({ origin }).kind, origin).toBe('desktop');
    }
    expect(svc.deriveSessionLabel({ origin: 'https://chat.example.org' }).kind).toBe('web');
    for (const origin of [undefined, '', 'null', 7]) expect(svc.deriveSessionLabel({ origin }).kind, String(origin)).toBe('unknown');
  });

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'macos'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'linux'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', 'android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'ios'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 'ios'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36', 'other'],
    ['curl/8.0', 'other'],
    ['', 'other'],
  ])('the system of %s is %s', (userAgent, os) => {
    expect(svc.deriveSessionLabel({ userAgent }).os).toBe(os);
  });

  it('reads no further than the first 512 characters of a user agent, and nothing that is not a string', () => {
    expect(svc.deriveSessionLabel({ userAgent: `${'x'.repeat(512)} Windows NT 10.0` }).os).toBe('other');
    expect(svc.deriveSessionLabel({ userAgent: ['Windows'] }).os).toBe('other');
  });

  it('the user agent and the origin are never kept: the row gets the two values of the lists, and nothing is logged', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Fingerprint/1.2.3 SecretBuild-ABCDEF';
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const label = svc.deriveSessionLabel({ origin: 'https://chat.example.org', userAgent: ua });
    await svc.createSession(ACCOUNT, { rememberMe: true, label, accountGoneMessage: 'x' });

    const written = store.insertSession.mock.calls[0][1];
    expect(written).toMatchObject({ clientKind: 'web', clientOs: 'windows' });
    expect(JSON.stringify(written)).not.toContain('Fingerprint');
    expect(JSON.stringify(written)).not.toContain('chat.example.org');
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('Fingerprint');
      spy.mockRestore();
    }
  });

  it('a two-factor challenge carries the label as { k, o }; one off the lists reads as none', () => {
    expect(svc.carriedLabel({ kind: 'desktop', os: 'macos' })).toEqual({ k: 'desktop', o: 'macos' });
    expect(svc.readCarriedLabel({ k: 'desktop', o: 'macos' })).toEqual({ kind: 'desktop', os: 'macos' });
    for (const bad of [undefined, null, 'desktop', { k: 'desktop' }, { k: 'tv', o: 'linux' }, { k: 'web', o: 'Windows' }, { k: 1, o: 2 }]) {
      expect(svc.readCarriedLabel(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

// ─── The renewal ────────────────────────────────────────────────────────────

describe('sessionService — renewal', () => {
  it('the current generation: ONE conditional update from it to the next, and the pair for that generation', async () => {
    store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 3 }));

    const tokens = await svc.refreshSession(refreshToken({ gen: 3 }), ctx());

    expect(store.readSessionForRefresh).toHaveBeenCalledWith(db.prisma, SID, 'user-1', SESSIONS.REUSE_GRACE_SECONDS);
    expect(store.rotateSession).toHaveBeenCalledTimes(1);
    expect(store.rotateSession).toHaveBeenCalledWith(db.prisma, { sid: SID, fromGeneration: 3, toGeneration: 4, idleSeconds: 30 * DAY, maxAgeSeconds: SESSIONS.MAX_AGE_DAYS * DAY });
    const refresh = verifyRefresh(tokens!.refreshToken);
    expect(refresh).toMatchObject({ sid: SID, gen: 4, userId: 'user-1', tokenVersion: 0, rememberMe: true });
    expect(refresh.exp).toBe((await store.rotateSession.mock.results[0].value).exp);
    expect(verifyAccess(tokens!.accessToken)).toMatchObject({ userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, sid: SID });
  });

  it('a session without "Remember me" slides by 24 hours, and the username and role come from the account read', async () => {
    store.readSessionForRefresh.mockResolvedValueOnce(row({ rememberMe: false, username: 'renamed', role: 'admin' }));
    store.rotateSession.mockImplementationOnce(async (_d: unknown, a: { sid: string; toGeneration: number }) => ({ id: a.sid, generation: a.toGeneration, rememberMe: false, exp: nowS() + DAY }));

    const tokens = await svc.refreshSession(refreshToken({ gen: 3, rememberMe: false }), ctx());

    expect(store.rotateSession.mock.calls[0][1].idleSeconds).toBe(DAY);
    expect(verifyAccess(tokens!.accessToken)).toMatchObject({ username: 'renamed', role: 'admin' });
    expect(verifyRefresh(tokens!.refreshToken).rememberMe).toBe(false);
  });

  it('a generation AHEAD of the row (a database restored from a backup) is accepted and rotated past it', async () => {
    store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 2 }));

    const tokens = await svc.refreshSession(refreshToken({ gen: 9 }), ctx());

    expect(store.rotateSession.mock.calls[0][1]).toMatchObject({ fromGeneration: 2, toGeneration: 10 });
    expect(verifyRefresh(tokens!.refreshToken).gen).toBe(10);
  });

  it('the token just replaced, inside the grace window: the current generation again, nothing written', async () => {
    const r = row({ generation: 4, withinGrace: true, secondsSinceRotation: 3 });
    store.readSessionForRefresh.mockResolvedValueOnce(r);

    const tokens = await svc.refreshSession(refreshToken({ gen: 3 }), ctx());

    expect(store.rotateSession).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
    const refresh = verifyRefresh(tokens!.refreshToken);
    expect(refresh).toMatchObject({ sid: SID, gen: 4, exp: r.exp });
  });

  describe('reuse: the replaced token after the grace window, or an older one', () => {
    const cases = [
      ['the token just replaced, after the window', 3, row({ generation: 4, withinGrace: false, secondsSinceRotation: 121 })],
      ['an older one, even inside the window', 1, row({ generation: 4, withinGrace: true, secondsSinceRotation: 5 })],
    ] as const;

    it.each(cases)('%s, observe mode: logged, then renewed as the current generation; nothing ended', async (_what, k, r) => {
      store.readSessionForRefresh.mockResolvedValueOnce(r);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const token = refreshToken({ gen: k });

      const tokens = await svc.refreshSession(token, ctx({ hinted: true }));

      expect(isFeatureEnabled).toHaveBeenCalledWith('refresh_reuse_revocation');
      expect(store.rotateSession.mock.calls[0][1]).toMatchObject({ fromGeneration: 4, toGeneration: 5 });
      expect(verifyRefresh(tokens!.refreshToken).gen).toBe(5);
      expect(store.deleteSession).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0][0] as string;
      expect(line).toMatch(/^\[Sessions\] Refresh token reuse \(observe\)/);
      expect(line).toContain(`generation ${k} presented, 4 current, ${r.secondsSinceRotation} s after the last rotation`);
      expect(line).toContain('client desktop, client field present');
      // The id's first characters only; never the token
      expect(line).toContain(SID.slice(0, 6));
      expect(line).not.toContain(SID);
      expect(line).not.toContain(token);
      expect(line).not.toContain(token.split('.')[2]);
      warn.mockRestore();
    });

    it.each(cases)('%s, enforce mode: the session deleted, its sockets ended, then the one 401', async (_what, k, r) => {
      flags.enforce = true;
      store.readSessionForRefresh.mockResolvedValueOnce(r);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const err = await refusal(svc.refreshSession(refreshToken({ gen: k }), ctx()));

      expect(err).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
      expect(store.deleteSession).toHaveBeenCalledWith(db.prisma, SID, 'user-1');
      expect(revoke).toHaveBeenCalledWith('user-1', SID, SESSION_ENDED_REASON);
      expect(store.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0]);
      expect(store.rotateSession).not.toHaveBeenCalled();
      expect(warn.mock.calls[0][0]).toMatch(/^\[Sessions\] Refresh token reuse \(enforce\)/);
      expect(warn.mock.calls[0][0]).toContain('client field absent');
      warn.mockRestore();
    });

    it('enforce mode, the delete fails: thrown as it is (500, never the 401), and no socket is ended', async () => {
      flags.enforce = true;
      store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 4 }));
      store.deleteSession.mockRejectedValueOnce(new Error('connection lost'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const err = await refusal(svc.refreshSession(refreshToken({ gen: 1 }), ctx()));

      expect(err.message).toBe('connection lost');
      expect(err.statusCode).toBeUndefined();
      expect(revoke).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('the refusals: each the one 401 \'Invalid refresh token\'', () => {
    it('no row (signed out, ended, evicted, swept, or the account is gone)', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(null);
      expect(await refusal(svc.refreshSession(refreshToken(), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
      expect(store.rotateSession).not.toHaveBeenCalled();
    });

    it('a banned account (401 as before sessions, never 403)', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row({ banned: true }));
      expect(await refusal(svc.refreshSession(refreshToken(), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
      expect(store.rotateSession).not.toHaveBeenCalled();
    });

    it('a row a version bump left behind: deleted (only while it still holds that version), then refused', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row({ rowVersion: 1, accountVersion: 2 }));
      expect(await refusal(svc.refreshSession(refreshToken({ tokenVersion: 1 }), ctx()))).toMatchObject({ statusCode: 401 });
      expect(store.deleteStaleSession).toHaveBeenCalledWith(db.prisma, SID, 1);
      expect(store.rotateSession).not.toHaveBeenCalled();
    });

    it('a token minted before its own row was re-keyed (password change): refused, the row KEPT', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row({ rowVersion: 2, accountVersion: 2 }));
      expect(await refusal(svc.refreshSession(refreshToken({ tokenVersion: 1 }), ctx()))).toMatchObject({ statusCode: 401 });
      expect(store.deleteStaleSession).not.toHaveBeenCalled();
      expect(store.deleteSession).not.toHaveBeenCalled();
      expect(store.deleteExpiredSession).not.toHaveBeenCalled();
    });

    it('an expired row (decided on the database\'s clock): deleted while it still is, then refused', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row({ expired: true }));
      expect(await refusal(svc.refreshSession(refreshToken(), ctx()))).toMatchObject({ statusCode: 401 });
      expect(store.deleteExpiredSession).toHaveBeenCalledWith(db.prisma, SID);
      expect(store.rotateSession).not.toHaveBeenCalled();
    });

    it('a token jsonwebtoken refuses: forged, expired, garbage, another algorithm, an access token', async () => {
      const tokens = [
        refreshToken({}, 'not-the-refresh-secret'),
        refreshToken({ exp: nowS() - 10 }),
        'not.a.token',
        'garbage',
        refreshToken({}, TEST_JWT_REFRESH_SECRET, 'HS512'),
        refreshToken({}, TEST_JWT_SECRET),
        jwt.sign({ userId: 'user-1', sid: SID, gen: 1 }, '', { algorithm: 'none' } as jwt.SignOptions),
      ];
      for (const token of tokens) {
        expect(await refusal(svc.refreshSession(token, ctx())), token.slice(0, 20)).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
      }
      expect(store.readSessionForRefresh).not.toHaveBeenCalled();
      expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a verified token of a shape no signer of ours writes', async () => {
      for (const over of [{ sid: 'has:colon' }, { sid: 7 }, { sid: SID, gen: -1 }, { sid: SID, gen: 1.5 }, { sid: SID, gen: undefined }, { sid: SID, gen: '2' }, { userId: '' }, { userId: undefined }, { tokenVersion: 'x' }, { tokenVersion: 1.5 }]) {
        expect(await refusal(svc.refreshSession(refreshToken(over), ctx())), JSON.stringify(over)).toMatchObject({ statusCode: 401 });
      }
      expect(store.readSessionForRefresh).not.toHaveBeenCalled();
    });
  });

  describe('failures of the server: thrown as they are (500), never the 401', () => {
    it('the read', async () => {
      const failure = Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError' });
      store.readSessionForRefresh.mockRejectedValueOnce(failure);
      expect(await refusal(svc.refreshSession(refreshToken(), ctx()))).toBe(failure);
    });

    it('the rotation', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row());
      store.rotateSession.mockRejectedValueOnce(new Error('statement timeout'));
      const err = await refusal(svc.refreshSession(refreshToken(), ctx()));
      expect(err.message).toBe('statement timeout');
      expect(err.statusCode).toBeUndefined();
    });

    it('the delete of a row left behind, and of an expired one', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row({ rowVersion: 0, accountVersion: 1 }));
      store.deleteStaleSession.mockRejectedValueOnce(new Error('pool exhausted'));
      expect((await refusal(svc.refreshSession(refreshToken(), ctx()))).statusCode).toBeUndefined();

      store.readSessionForRefresh.mockResolvedValueOnce(row({ expired: true }));
      store.deleteExpiredSession.mockRejectedValueOnce(new Error('pool exhausted'));
      expect((await refusal(svc.refreshSession(refreshToken(), ctx()))).statusCode).toBeUndefined();
    });
  });

  describe('two presentations of one token racing on the conditional update', () => {
    it('the loser reads again and gets the winner\'s generation inside the grace window: both answered, one rotation', async () => {
      store.readSessionForRefresh
        .mockResolvedValueOnce(row({ generation: 3 }))
        .mockResolvedValueOnce(row({ generation: 4, withinGrace: true, secondsSinceRotation: 0 }));
      store.rotateSession.mockResolvedValueOnce(null);

      const tokens = await svc.refreshSession(refreshToken({ gen: 3 }), ctx());

      expect(store.rotateSession).toHaveBeenCalledTimes(1);
      expect(store.readSessionForRefresh).toHaveBeenCalledTimes(2);
      expect(verifyRefresh(tokens!.refreshToken).gen).toBe(4);
    });

    it('a second lost race is a 500 (the client asks again), never a loop and never a 401', async () => {
      store.readSessionForRefresh.mockResolvedValue(row({ generation: 3 }));
      store.rotateSession.mockResolvedValue(null);

      const err = await refusal(svc.refreshSession(refreshToken({ gen: 3 }), ctx()));

      expect(err.statusCode).toBeUndefined();
      expect(err.message).toMatch(/lost the race twice/);
      expect(store.rotateSession).toHaveBeenCalledTimes(2);
    });

    it('the row gone between the read and the update (a sign-out): read again, refused', async () => {
      store.readSessionForRefresh.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
      store.rotateSession.mockResolvedValueOnce(null);
      expect(await refusal(svc.refreshSession(refreshToken(), ctx()))).toMatchObject({ statusCode: 401 });
    });
  });

  it('a client already gone: nothing rotated, nothing answered (null)', async () => {
    store.readSessionForRefresh.mockResolvedValueOnce(row());
    await expect(svc.refreshSession(refreshToken(), ctx({ isClientGone: () => true }))).resolves.toBeNull();
    expect(store.rotateSession).not.toHaveBeenCalled();
  });
});

// ─── Tokens issued before sessions ───────────────────────────────────────────

describe('sessionService — a refresh token issued before sessions (no sid)', () => {
  const digestOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

  it('the token today\'s server mints is upgraded, once, into a new session at generation 1, in one transaction', async () => {
    const token = preSessionRefreshToken();
    const claims = decode(token);

    const tokens = await svc.refreshSession(token, ctx({ label: { kind: 'admin', os: 'macos' } }));

    // Today's checks first, on the account
    expect(db.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { id: true, username: true, role: true, tokenVersion: true, bannedAt: true } });
    expect(store.readLegacyRedemption).toHaveBeenCalledWith(db.prisma, digestOf(token));
    // The claim, the session and the link: all on the transaction's client
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(store.claimLegacyRedemption).toHaveBeenCalledWith(db.tx, digestOf(token), claims.exp);
    expect(store.insertSession).toHaveBeenCalledWith(db.tx, expect.objectContaining({ userId: 'user-1', rememberMe: true, tokenVersion: 0, clientKind: 'admin', clientOs: 'macos', idleSeconds: 30 * DAY }));
    const refresh = verifyRefresh(tokens!.refreshToken);
    expect(refresh).toMatchObject({ userId: 'user-1', tokenVersion: 0, rememberMe: true, gen: 1 });
    expect(store.linkLegacyRedemption).toHaveBeenCalledWith(db.tx, digestOf(token), refresh.sid);
    expect(store.evictSessionsBeyond).toHaveBeenCalledWith(db.prisma, 'user-1', refresh.sid, SESSIONS.MAX_PER_ACCOUNT - 1);
    expect(verifyAccess(tokens!.accessToken)).toMatchObject({ userId: 'user-1', username: 'alice', sid: refresh.sid });
  });

  it('reads "Remember me" as before sessions: absent or null means yes, otherwise its truthiness (the sign-in signed whatever the body held)', async () => {
    const cases: Array<[unknown, boolean]> = [[null, true], ['true', true], ['false', true], [1, true], [0, false], ['', false], [false, false]];
    for (const [rememberMe, remembered] of cases) {
      store.insertSession.mockClear();
      const token = jwt.sign({ userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, rememberMe }, TEST_JWT_REFRESH_SECRET, { expiresIn: '30d' });
      const tokens = await svc.refreshSession(token, ctx());
      expect(store.insertSession.mock.calls[0][1].rememberMe, JSON.stringify(rememberMe)).toBe(remembered);
      expect(store.insertSession.mock.calls[0][1].idleSeconds, JSON.stringify(rememberMe)).toBe(remembered ? 30 * DAY : DAY);
      expect(verifyRefresh(tokens!.refreshToken).rememberMe).toBe(remembered);
    }
  });

  it('a token version claim of null reads as 0 (as before), one that is not a whole number is refused (it never matched)', async () => {
    const nullVersion = jwt.sign({ userId: 'user-1', tokenVersion: null, rememberMe: true }, TEST_JWT_REFRESH_SECRET, { expiresIn: '30d' });
    await expect(svc.refreshSession(nullVersion, ctx())).resolves.not.toBeNull();
    const stringVersion = jwt.sign({ userId: 'user-1', tokenVersion: '0', rememberMe: true }, TEST_JWT_REFRESH_SECRET, { expiresIn: '30d' });
    expect(await refusal(svc.refreshSession(stringVersion, ctx()))).toMatchObject({ statusCode: 401 });
  });

  it('keeps today\'s defaults: no tokenVersion claim is version 0, a null rememberMe is remembered; a 24-hour one stays 24 hours', async () => {
    const noVersion = jwt.sign({ userId: 'user-1', username: 'alice', role: 'user', rememberMe: null }, TEST_JWT_REFRESH_SECRET, { expiresIn: '30d' });
    await expect(svc.refreshSession(noVersion, ctx())).resolves.not.toBeNull();
    expect(store.insertSession.mock.calls[0][1]).toMatchObject({ rememberMe: true, tokenVersion: 0 });

    await svc.refreshSession(preSessionRefreshToken(undefined, false), ctx());
    expect(store.insertSession.mock.calls[1][1]).toMatchObject({ rememberMe: false, idleSeconds: DAY });
  });

  it('a payload with no rememberMe claim is not a refresh token (an access token of before carries none): refused, nothing written', async () => {
    // Every refresh token a release signed carries the claim; this shape is
    // an access token of before, or code older than the first release
    const accessShaped = jwt.sign({ userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0 }, TEST_JWT_REFRESH_SECRET, { expiresIn: '15m' });
    expect(await refusal(svc.refreshSession(accessShaped, ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    await expect(svc.endSessionWithRefreshToken(accessShaped)).resolves.toBeUndefined();
    expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('presented again within the grace window of its upgrade: generation 1 again, no second session', async () => {
    const token = preSessionRefreshToken();
    store.readLegacyRedemption.mockResolvedValueOnce({ sessionId: SID });
    store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 1, withinGrace: true, secondsSinceRotation: 2 }));

    const tokens = await svc.refreshSession(token, ctx());

    expect(store.readSessionForRefresh).toHaveBeenCalledWith(db.prisma, SID, 'user-1', SESSIONS.REUSE_GRACE_SECONDS);
    expect(verifyRefresh(tokens!.refreshToken)).toMatchObject({ sid: SID, gen: 1 });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(store.insertSession).not.toHaveBeenCalled();
    expect(store.rotateSession).not.toHaveBeenCalled();
  });

  it('presented again after the window (or after the session renewed): generation 0 is reuse; enforce mode ends the session', async () => {
    flags.enforce = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.readLegacyRedemption.mockResolvedValueOnce({ sessionId: SID });
    store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 1, withinGrace: false }));

    expect(await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).toMatchObject({ statusCode: 401 });
    expect(store.deleteSession).toHaveBeenCalledWith(db.prisma, SID, 'user-1');
    expect(warn.mock.calls[0][0]).toContain('generation 0 presented, 1 current');
    warn.mockRestore();
  });

  it('a digest spent (signed out with it, or its session ended): refused for good', async () => {
    store.readLegacyRedemption.mockResolvedValueOnce({ sessionId: null });
    expect(await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a concurrent first presentation claimed the digest first: this one reads the winner\'s session and is answered from it', async () => {
    store.claimLegacyRedemption.mockResolvedValueOnce(false);
    store.readLegacyRedemption.mockResolvedValueOnce(null).mockResolvedValueOnce({ sessionId: SID });
    store.readSessionForRefresh.mockResolvedValueOnce(row({ generation: 1, withinGrace: true }));

    const tokens = await svc.refreshSession(preSessionRefreshToken(), ctx());

    // The losing transaction wrote nothing (ON CONFLICT DO NOTHING, then returned)
    expect(store.insertSession).not.toHaveBeenCalled();
    expect(store.linkLegacyRedemption).not.toHaveBeenCalled();
    expect(verifyRefresh(tokens!.refreshToken)).toMatchObject({ sid: SID, gen: 1 });
  });

  it('a lost claim whose winner\'s record is not there is a 500, never a 401', async () => {
    store.claimLegacyRedemption.mockResolvedValueOnce(false);
    store.readLegacyRedemption.mockResolvedValue(null);
    expect((await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).statusCode).toBeUndefined();
  });

  it('today\'s refusals: account gone, banned, another token version: 401, nothing written', async () => {
    for (const user of [null, { id: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, bannedAt: new Date() }, { id: 'user-1', username: 'alice', role: 'user', tokenVersion: 1, bannedAt: null }]) {
      db.prisma.user.findUnique.mockResolvedValueOnce(user);
      expect(await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    }
    expect(store.readLegacyRedemption).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the account deleted during the upgrade (the session\'s key refused): 401, and the claim rolls back with it', async () => {
    store.insertSession.mockRejectedValueOnce(rawFkError('sessions_user_id_fkey'));
    expect(await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    expect(store.linkLegacyRedemption).not.toHaveBeenCalled();
  });

  it('a failure of the account read or of the upgrade transaction is a 500: the client keeps the token and asks again', async () => {
    db.prisma.user.findUnique.mockRejectedValueOnce(new Error('connection refused'));
    expect((await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).statusCode).toBeUndefined();

    db.prisma.$transaction.mockRejectedValueOnce(new Error('transaction timeout'));
    expect((await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()))).statusCode).toBeUndefined();
  });

  it('the upgrade transaction keeps the default budget of Prisma, and its expiry behind an account deletion (P2028) is thrown as itself: never retried, never the 401', async () => {
    await svc.refreshSession(preSessionRefreshToken(), ctx());
    // One argument: the callback, no options (the default 5 s budget)
    expect(db.prisma.$transaction.mock.calls[0]).toHaveLength(1);

    db.prisma.$transaction.mockClear();
    const expired = Object.assign(new Error('A query cannot be executed on an expired transaction'), { code: 'P2028' });
    db.prisma.$transaction.mockRejectedValueOnce(expired);
    const err = await refusal(svc.refreshSession(preSessionRefreshToken(), ctx()));
    expect(err).toBe(expired);
    expect(err.statusCode).toBeUndefined();
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('a deadlock victim of the upgrade runs again whole', async () => {
    db.prisma.$transaction
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }))
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(db.tx));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.refreshSession(preSessionRefreshToken(), ctx())).resolves.not.toBeNull();
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a client already gone: no upgrade, nothing answered', async () => {
    await expect(svc.refreshSession(preSessionRefreshToken(), ctx({ isClientGone: () => true }))).resolves.toBeNull();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── Sign-out ───────────────────────────────────────────────────────────────

describe('sessionService — sign-out with a refresh token', () => {
  it('ends the session the token names, whatever its generation, and its sockets', async () => {
    for (const gen of [1, 3, 99]) {
      vi.clearAllMocks();
      store.deleteSession.mockResolvedValueOnce(1);
      await svc.endSessionWithRefreshToken(refreshToken({ gen }));
      expect(store.deleteSession).toHaveBeenCalledWith(db.prisma, SID, 'user-1');
      expect(revoke).toHaveBeenCalledWith('user-1', SID, SESSION_ENDED_REASON);
    }
  });

  it('whatever its token version (a re-keyed or bumped session is ended all the same)', async () => {
    await svc.endSessionWithRefreshToken(refreshToken({ tokenVersion: 7 }));
    expect(store.deleteSession).toHaveBeenCalledWith(db.prisma, SID, 'user-1');
  });

  it('a session already gone: nothing to end, no sockets touched, no error', async () => {
    store.deleteSession.mockResolvedValueOnce(0);
    await expect(svc.endSessionWithRefreshToken(refreshToken())).resolves.toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('a token jsonwebtoken refuses, or a shape no signer writes: nothing at all, no error', async () => {
    for (const token of [refreshToken({}, 'forged'), refreshToken({ exp: nowS() - 5 }), 'garbage', refreshToken({ sid: 'x:y' }), refreshToken({}, TEST_JWT_SECRET)]) {
      await expect(svc.endSessionWithRefreshToken(token)).resolves.toBeUndefined();
    }
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a token issued before sessions: its digest spent in one transaction, the session it became ended', async () => {
    const token = preSessionRefreshToken();
    store.spendLegacyRedemption.mockResolvedValueOnce([SID]);

    await svc.endSessionWithRefreshToken(token);

    expect(store.spendLegacyRedemption).toHaveBeenCalledWith(db.tx, crypto.createHash('sha256').update(token).digest('hex'), decode(token).exp, 'user-1');
    expect(revoke).toHaveBeenCalledWith('user-1', [SID], SESSION_ENDED_REASON);
  });

  it('a token issued before sessions and never redeemed: spent, no socket to end', async () => {
    await svc.endSessionWithRefreshToken(preSessionRefreshToken());
    expect(store.spendLegacyRedemption).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('a failing statement is thrown (500: the sign-out did not happen)', async () => {
    store.deleteSession.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.endSessionWithRefreshToken(refreshToken())).rejects.toThrow('connection lost');
    db.prisma.$transaction.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.endSessionWithRefreshToken(preSessionRefreshToken())).rejects.toThrow('connection lost');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokeSession ends one session of one account with the reason given', async () => {
    await expect(svc.revokeSession('user-1', SID, 'You were signed out from another device')).resolves.toBe(true);
    expect(store.deleteSession).toHaveBeenCalledWith(db.prisma, SID, 'user-1');
    expect(revoke).toHaveBeenCalledWith('user-1', SID, 'You were signed out from another device');
    store.deleteSession.mockResolvedValueOnce(0);
    await expect(svc.revokeSession('user-1', 'other', 'x')).resolves.toBe(false);
  });
});

// ─── Re-key (password change) ────────────────────────────────────────────────

describe('sessionService — re-keying the caller\'s session', () => {
  it('moves the row from the admitted version to the new one and a new generation, and signs that generation at that version', async () => {
    const tokens = await svc.rekeySession(db.tx as never, { ...ACCOUNT, tokenVersion: 3 }, SID, 2);

    expect(store.rekeySession).toHaveBeenCalledTimes(1);
    expect(store.rekeySession.mock.calls[0]).toStrictEqual([db.tx, {
      sid: SID, userId: 'user-1', fromTokenVersion: 2, tokenVersion: 3,
      rememberIdleSeconds: 30 * DAY, sessionIdleSeconds: DAY, maxAgeSeconds: SESSIONS.MAX_AGE_DAYS * DAY,
    }]);
    expect(verifyRefresh(tokens.refreshToken)).toMatchObject({ sid: SID, gen: 5, tokenVersion: 3, rememberMe: false });
    expect(verifyAccess(tokens.accessToken)).toMatchObject({ sid: SID, tokenVersion: 3 });
  });

  it('a row gone, expired or no longer at the admitted version refuses with \'Session invalidated\'', async () => {
    store.rekeySession.mockResolvedValueOnce(null);
    expect(await refusal(svc.rekeySession(db.tx as never, ACCOUNT, SID, 0))).toMatchObject({ statusCode: 401, message: 'Session invalidated' });
  });
});

// ─── The kinds of token ─────────────────────────────────────────────────────
// A token is accepted only as the kind it was issued as, whatever the two
// secrets are (utils/tokenShapes.ts): these sign with the REFRESH secret
// payloads of every other kind, as equal secrets would let them arrive.

describe('sessionService — a refresh token is one by its claims too', () => {
  const asRefresh = (payload: Record<string, unknown>) => jwt.sign(payload, TEST_JWT_REFRESH_SECRET, { expiresIn: '1h' });

  it.each([
    ['an access token of a session', { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, sid: SID }],
    ['an access token of before', { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0 }],
    ['a two-factor challenge', { userId: 'user-1', purpose: 'totp-verify', rememberMe: true }],
    ['a trusted-device token', { userId: 'user-1', purpose: 'trusted-device', tokenVersion: 0 }],
    ['a mail-block link', { purpose: 'mail-block', m: 'a'.repeat(64) }],
    ['a session refresh shape carrying username', { userId: 'user-1', username: 'alice', tokenVersion: 0, rememberMe: true, sid: SID, gen: 1 }],
    ['a session refresh shape carrying role', { userId: 'user-1', role: 'admin', tokenVersion: 0, rememberMe: true, sid: SID, gen: 1 }],
    ['a generation without a session', { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, rememberMe: true, gen: 1 }],
    ['a purpose on a refresh shape', { userId: 'user-1', tokenVersion: 0, rememberMe: true, sid: SID, gen: 1, purpose: 'x' }],
  ])('%s: refused like any malformed token (401), nothing read or written; a sign-out with it ends nothing', async (_what, payload) => {
    const token = asRefresh(payload);
    expect(await refusal(svc.refreshSession(token, ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    await expect(svc.endSessionWithRefreshToken(token)).resolves.toBeUndefined();
    expect(store.readSessionForRefresh).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('every token a correct deployment issued still renews: the session shape and the shape of before (fixture: the minting function as it stood)', async () => {
    store.readSessionForRefresh.mockResolvedValue(row({ generation: 3 }));
    await expect(svc.refreshSession(refreshToken({ gen: 3 }), ctx())).resolves.not.toBeNull();
    await expect(svc.refreshSession(preSessionRefreshToken(), ctx())).resolves.not.toBeNull();
    await expect(svc.refreshSession(preSessionRefreshToken(undefined, false), ctx())).resolves.not.toBeNull();
  });

  it('the generation: a whole number from 0 to the 32-bit maximum; anything larger or fractional is refused (401, never a 500)', async () => {
    expect(svc.GENERATION_MAX).toBe(2 ** 31 - 1);
    for (const gen of [svc.GENERATION_MAX + 1, 2 ** 53, 1.5, -1, '3']) {
      store.readSessionForRefresh.mockClear();
      expect(await refusal(svc.refreshSession(refreshToken({ gen }), ctx()))).toMatchObject({ statusCode: 401 });
      expect(store.readSessionForRefresh).not.toHaveBeenCalled();
    }
  });

  it('a session at the column\'s last generation cannot rotate: the renewal is refused (401) rather than overflowing the column (a 500)', async () => {
    store.readSessionForRefresh.mockResolvedValue(row({ generation: svc.GENERATION_MAX }));
    expect(await refusal(svc.refreshSession(refreshToken({ gen: svc.GENERATION_MAX }), ctx()))).toMatchObject({ statusCode: 401, message: 'Invalid refresh token' });
    expect(store.rotateSession).not.toHaveBeenCalled();

    // The generation before it still rotates to it
    store.readSessionForRefresh.mockResolvedValue(row({ generation: svc.GENERATION_MAX - 1 }));
    await expect(svc.refreshSession(refreshToken({ gen: svc.GENERATION_MAX - 1 }), ctx())).resolves.not.toBeNull();
    expect(store.rotateSession.mock.calls[0][1]).toMatchObject({ toGeneration: svc.GENERATION_MAX });
  });
});

describe('sessionService — the two secrets', () => {
  const saved = { a: process.env.JWT_SECRET, r: process.env.JWT_REFRESH_SECRET };
  afterEach(() => {
    process.env.JWT_SECRET = saved.a;
    process.env.JWT_REFRESH_SECRET = saved.r;
  });

  it('two different values: nothing to say', () => {
    expect(svc.tokenSecretsWarning()).toBeNull();
  });

  it('the same value: one line naming the two settings and never the value', () => {
    process.env.JWT_SECRET = 'one-shared-secret-value-1234567890';
    process.env.JWT_REFRESH_SECRET = 'one-shared-secret-value-1234567890';
    const line = svc.tokenSecretsWarning();
    expect(line).toContain('JWT_SECRET and JWT_REFRESH_SECRET hold the same value');
    expect(line).not.toContain('one-shared-secret-value');
  });

  it('the same value: an access token is still not a refresh token, nor the reverse (the claims decide)', async () => {
    process.env.JWT_SECRET = 'one-shared-secret-value-1234567890';
    process.env.JWT_REFRESH_SECRET = 'one-shared-secret-value-1234567890';
    const opened = await svc.openSession(db.prisma as never, ACCOUNT, { rememberMe: true, label: LABEL, accountGoneMessage: 'x' });
    expect(await refusal(svc.refreshSession(opened.tokens.accessToken, ctx()))).toMatchObject({ statusCode: 401 });
    expect(store.readSessionForRefresh).not.toHaveBeenCalled();
  });
});

// ─── The access check ───────────────────────────────────────────────────────

describe('sessionService — the access check', () => {
  const ACCOUNT_GATE_SELECT = { bannedAt: true, tokenVersion: true, role: true, emailVerified: true, termsAcceptedAt: true, privacyAcceptedAt: true };
  const account = { bannedAt: null, tokenVersion: 2, role: 'user', emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0) };

  it('a token that names no session: the account read alone, as before (sessionLive null)', async () => {
    db.prisma.user.findUnique.mockResolvedValueOnce(account);
    await expect(svc.loadAccessState('user-1', undefined)).resolves.toEqual({ ...account, sessionLive: null });
    expect(db.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: ACCOUNT_GATE_SELECT });
  });

  it('a token naming a session: the account and that session in one statement (a relation join)', async () => {
    db.prisma.user.findUnique.mockResolvedValueOnce({ ...account, sessions: [{ tokenVersion: 2, expiresAt: new Date(Date.now() + 60_000) }] });
    await expect(svc.loadAccessState('user-1', SID)).resolves.toEqual({ ...account, sessionLive: true });
    expect(db.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { ...ACCOUNT_GATE_SELECT, sessions: { where: { id: SID }, select: { tokenVersion: true, expiresAt: true }, take: 1 } },
    });
  });

  it.each([
    ['gone', []],
    ['below the account\'s version', [{ tokenVersion: 1, expiresAt: new Date(Date.now() + 60_000) }]],
    ['expired', [{ tokenVersion: 2, expiresAt: new Date(Date.now() - 1) }]],
  ])('a session %s is not live', async (_what, sessions) => {
    db.prisma.user.findUnique.mockResolvedValueOnce({ ...account, sessions });
    await expect(svc.loadAccessState('user-1', SID)).resolves.toMatchObject({ sessionLive: false });
  });

  it('the expiry of the session is judged on the clock of this node: live until the instant it passes', async () => {
    vi.useFakeTimers();
    try {
      const expiresAt = new Date(Date.UTC(2026, 10, 20, 12, 0, 0));
      vi.setSystemTime(expiresAt.getTime() - 1);
      db.prisma.user.findUnique.mockResolvedValueOnce({ ...account, sessions: [{ tokenVersion: 2, expiresAt }] });
      await expect(svc.loadAccessState('user-1', SID)).resolves.toMatchObject({ sessionLive: true });
      vi.setSystemTime(expiresAt.getTime());
      db.prisma.user.findUnique.mockResolvedValueOnce({ ...account, sessions: [{ tokenVersion: 2, expiresAt }] });
      await expect(svc.loadAccessState('user-1', SID)).resolves.toMatchObject({ sessionLive: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an account gone reads null; a failing lookup is thrown, never a refusal', async () => {
    db.prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(svc.loadAccessState('user-1', SID)).resolves.toBeNull();
    db.prisma.user.findUnique.mockRejectedValueOnce(new Error('pool timeout'));
    await expect(svc.loadAccessState('user-1', SID)).rejects.toThrow('pool timeout');
  });

  it('readAccessSessionId: none, an id, or null for a value no signer writes', () => {
    expect(svc.readAccessSessionId({})).toBeUndefined();
    expect(svc.readAccessSessionId({ sid: SID })).toBe(SID);
    for (const sid of ['', 'a:b', 'x'.repeat(65), 5, null, {}]) expect(svc.readAccessSessionId({ sid }), String(sid)).toBeNull();
  });
});

// ─── The list and the other sessions ────────────────────────────────────────

describe('sessionService — the list of the account\'s sessions', () => {
  const hour = (h: number) => Date.UTC(2026, 10, 20, h) / 1000;

  it('each live session as its label, the day it was signed in and the hour it last renewed (ISO, UTC), and whether it is the caller\'s', async () => {
    store.listLiveSessions.mockResolvedValueOnce([
      { id: SID, clientKind: 'desktop', clientOs: 'windows', signedInAt: hour(0), lastActiveAt: hour(14) },
      { id: 'other-session-0000000', clientKind: 'web', clientOs: 'linux', signedInAt: hour(0) - 86_400, lastActiveAt: hour(2) },
    ]);
    const list = await svc.listSessions('user-1', SID);
    expect(store.listLiveSessions).toHaveBeenCalledWith(db.prisma, 'user-1', SID, SESSIONS.MAX_PER_ACCOUNT * 2);
    expect(list).toEqual([
      { id: SID, clientKind: 'desktop', clientOs: 'windows', signedInAt: '2026-11-20T00:00:00.000Z', lastActiveAt: '2026-11-20T14:00:00.000Z', current: true },
      { id: 'other-session-0000000', clientKind: 'web', clientOs: 'linux', signedInAt: '2026-11-19T00:00:00.000Z', lastActiveAt: '2026-11-20T02:00:00.000Z', current: false },
    ]);
    expect(svc.SESSION_LIST_MAX).toBe(50);
  });

  it('a caller whose token names no session: none is marked, and the statement is told so', async () => {
    store.listLiveSessions.mockResolvedValueOnce([{ id: SID, clientKind: 'web', clientOs: 'other', signedInAt: hour(1), lastActiveAt: hour(1) }]);
    const list = await svc.listSessions('user-1', undefined);
    expect(store.listLiveSessions).toHaveBeenCalledWith(db.prisma, 'user-1', null, 50);
    expect(list[0].current).toBe(false);
  });

  it('a label outside the closed lists is shown as unknown / other, never as stored', async () => {
    store.listLiveSessions.mockResolvedValueOnce([{ id: SID, clientKind: '<b>tv</b>', clientOs: 'plan9', signedInAt: hour(1), lastActiveAt: hour(1) }]);
    const [row] = await svc.listSessions('user-1', SID);
    expect(row).toMatchObject({ clientKind: 'unknown', clientOs: 'other' });
  });

  it('a failing statement is thrown as it is (500), never an empty list', async () => {
    store.listLiveSessions.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.listSessions('user-1', SID)).rejects.toThrow('connection lost');
  });
});

describe('sessionService — ending the other sessions in the bump\'s transaction', () => {
  it('deletes every session but the kept one on the transaction\'s client; the ids, and how many were live at the version before', async () => {
    store.deleteOtherSessions.mockResolvedValueOnce([{ id: 'a', live: true }, { id: 'b', live: false }, { id: 'c', live: true }]);
    await expect(svc.endOtherSessions(db.tx as never, 'user-1', SID, 3)).resolves.toEqual({ ended: ['a', 'b', 'c'], live: 2 });
    expect(store.deleteOtherSessions).toHaveBeenCalledWith(db.tx, 'user-1', SID, 3);
    // Their sockets are the caller's to end, after the commit
    expect(revoke).not.toHaveBeenCalled();
  });
});
