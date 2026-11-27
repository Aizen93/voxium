import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  OPAQUE_ID_RE, SESSIONS, SESSION_CLIENT_HINTS, SESSION_CLIENT_KINDS, SESSION_CLIENT_OSES, SESSION_ENDED_REASON,
  type SessionClientHint, type SessionClientKind, type SessionClientOs, type SessionSummary,
} from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { UnauthorizedError } from '../utils/errors';
import { isJwtVerifyError } from '../utils/jwtErrors';
import { isFeatureEnabled } from '../utils/featureFlags';
import { revokeSessionSockets } from '../utils/sessionRevocation';
import { retryOnTransactionConflict } from '../utils/transactionRetry';
import { refreshTokenShape } from '../utils/tokenShapes';
import * as store from '../utils/sessionStore';
import type { IssuedSessionRow, SessionDb } from '../utils/sessionStore';
import { describeCaughtError } from '../utils/loggableError';

/*
 * Sign-in sessions: one row per signed-in device or browser (the `sessions`
 * table), and the ONE place that mints the tokens that open one. Nothing else
 * signs with JWT_REFRESH_SECRET or signs an access token
 * (__tests__/meta/sessionTokenMinting.test.ts).
 *
 * Tokens.
 *  - access (JWT_SECRET, JWT_EXPIRES_IN): userId, username, role,
 *    tokenVersion, sid. `authenticate` and the socket handshake refuse it
 *    once its session row is gone (loadAccessState).
 *  - refresh (JWT_REFRESH_SECRET): userId, tokenVersion, rememberMe, sid,
 *    gen, exp. `gen` is the generation it was issued as; `exp` is its row's
 *    expires_at. Every claim the server read before sessions existed is
 *    still there, so a server rolled back to that code accepts these tokens.
 *  - tokenVersion stays the account-wide switch: a password change or reset
 *    and both ban paths bump it, and every token and row of an older version
 *    is dead. Deleting a row ends one session.
 *
 * Renewal (refreshSession): every refresh rotates the row to a new
 * generation with one conditional UPDATE; the token just replaced is
 * answered again for SESSIONS.REUSE_GRACE_SECONDS (the database's clock);
 * after that, or for anything older, presenting it is reuse. Reuse ends the
 * session when the `refresh_reuse_revocation` flag is on, and is only logged
 * (the session rotated and kept) while it is off.
 *
 * What answers 401: only the refusals named in this file (each throws the
 * one 'Invalid refresh token'), and a token jsonwebtoken refused. Anything
 * else (a statement that fails, a timeout, a bug) surfaces as the 500 it is:
 * the client keeps its tokens and asks again, so a fault here is an outage,
 * never a mass sign-out.
 *
 * Refresh tokens issued before sessions (no `sid`) are upgraded on first use
 * into a new session, as its generation 0 (refreshLegacy); none is issued any
 * more, and each expires by itself.
 */

// ─── Lifetimes ───────────────────────────────────────────────────────────────

/** The access token's lifetime, in jsonwebtoken's notation. */
function accessTokenLifetime(): string {
  return process.env.JWT_EXPIRES_IN || '15m';
}

/** A session's idle window from its last renewal, in jsonwebtoken's notation. */
function refreshIdleLifetime(rememberMe: boolean): string {
  return rememberMe
    ? (process.env.JWT_REFRESH_EXPIRES_IN || '30d')
    : '24h';
}

const MAX_AGE_SECONDS = SESSIONS.MAX_AGE_DAYS * 24 * 60 * 60;

const lifetimeSecondsCache = new Map<string, number>();

/**
 * A lifetime in seconds, read the way jsonwebtoken reads `expiresIn` (a
 * number of seconds, or a time span such as '30d'): the row's expiry is
 * computed in SQL from this figure, and must mean what the setting meant
 * when jsonwebtoken applied it to the token itself. Read by signing a
 * throwaway token with it, so the notation is jsonwebtoken's own, then cached.
 */
function lifetimeSeconds(lifetime: string): number {
  const cached = lifetimeSecondsCache.get(lifetime);
  if (cached !== undefined) return cached;
  const probe = jwt.decode(
    jwt.sign({}, 'lifetime-probe', { expiresIn: lifetime, algorithm: 'HS256' } as jwt.SignOptions),
  ) as { iat: number; exp: number };
  const seconds = probe.exp - probe.iat;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('A session lifetime must be a positive time span (JWT_REFRESH_EXPIRES_IN)');
  }
  lifetimeSecondsCache.set(lifetime, seconds);
  return seconds;
}

function idleSeconds(rememberMe: boolean): number {
  return lifetimeSeconds(refreshIdleLifetime(rememberMe));
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export interface SessionLabel {
  kind: SessionClientKind;
  os: SessionClientOs;
}

/** The origins of the desktop app's webview (Windows, with either scheme; macOS and Linux). */
const DESKTOP_ORIGINS = new Set(['https://tauri.localhost', 'http://tauri.localhost', 'tauri://localhost']);

/** Never read past this much of a user agent: the label needs its first words. */
const USER_AGENT_READ_MAX = 512;

/** A `client` value of a sign-in or refresh body, or null for anything else (ignored, never refused). */
export function readClientHint(value: unknown): SessionClientHint | null {
  return typeof value === 'string' && (SESSION_CLIENT_HINTS as readonly string[]).includes(value)
    ? (value as SessionClientHint)
    : null;
}

function osFromUserAgent(userAgent: string | undefined): SessionClientOs {
  if (typeof userAgent !== 'string') return 'other';
  const ua = userAgent.slice(0, USER_AGENT_READ_MAX);
  // Order matters: an Android agent says Linux, an iPhone's says "like Mac OS X"
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os x/i.test(ua)) return 'macos';
  if (/linux/i.test(ua)) return 'linux';
  return 'other';
}

/**
 * The label of a new session: the kind of app from the client's own hint,
 * else from the request's Origin (the desktop webview's origins, any other
 * origin a browser), else unknown; the system from the user agent. Neither
 * header is kept or logged: only the two values of the closed lists are.
 */
export function deriveSessionLabel(input: { hint?: unknown; origin?: unknown; userAgent?: unknown }): SessionLabel {
  const hint = readClientHint(input.hint);
  let kind: SessionClientKind;
  if (hint) kind = hint;
  else if (typeof input.origin === 'string' && input.origin.length > 0 && input.origin !== 'null') {
    kind = DESKTOP_ORIGINS.has(input.origin.toLowerCase()) ? 'desktop' : 'web';
  } else kind = 'unknown';
  return { kind, os: osFromUserAgent(typeof input.userAgent === 'string' ? input.userAgent : undefined) };
}

/** A label carried by a two-factor challenge token (`cl`), or null when it is missing or not of the lists. */
export function readCarriedLabel(value: unknown): SessionLabel | null {
  const cl = value as { k?: unknown; o?: unknown } | null;
  if (!cl || typeof cl !== 'object') return null;
  if (typeof cl.k !== 'string' || !(SESSION_CLIENT_KINDS as readonly string[]).includes(cl.k)) return null;
  if (typeof cl.o !== 'string' || !(SESSION_CLIENT_OSES as readonly string[]).includes(cl.o)) return null;
  return { kind: cl.k as SessionClientKind, os: cl.o as SessionClientOs };
}

/** The label as a two-factor challenge token carries it. */
export function carriedLabel(label: SessionLabel): { k: string; o: string } {
  return { k: label.kind, o: label.os };
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/** The account a pair is signed for, as read from the database. */
export interface SessionAccount {
  userId: string;
  username: string;
  role: string;
  tokenVersion: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface OpenedSession {
  sessionId: string;
  tokens: SessionTokens;
}

function accessSecret(): string {
  return process.env.JWT_SECRET!;
}

function refreshSecret(): string {
  return process.env.JWT_REFRESH_SECRET!;
}

/**
 * The one line the server logs at start when the two token secrets hold the
 * same value, or null. The start goes on: every token is still accepted
 * only as the kind it was issued as (utils/tokenShapes.ts), and a
 * self-hosted install must keep booting. Never the value itself.
 */
export function tokenSecretsWarning(): string | null {
  if (accessSecret() !== refreshSecret()) return null;
  return 'JWT_SECRET and JWT_REFRESH_SECRET hold the same value; they should be two different random secrets '
    + '(for instance two runs of `openssl rand -hex 32`). Changing JWT_REFRESH_SECRET signs every device out.';
}

/** The pair for one generation of one session. The refresh token's `exp` is the row's expiry. */
function signSessionTokens(account: SessionAccount, session: IssuedSessionRow): SessionTokens {
  const accessToken = jwt.sign(
    { userId: account.userId, username: account.username, role: account.role, tokenVersion: account.tokenVersion, sid: session.id },
    accessSecret(),
    { expiresIn: accessTokenLifetime(), algorithm: 'HS256' } as jwt.SignOptions,
  );
  const refreshToken = jwt.sign(
    {
      userId: account.userId,
      tokenVersion: account.tokenVersion,
      rememberMe: session.rememberMe,
      sid: session.id,
      gen: session.generation,
      exp: session.exp,
    },
    refreshSecret(),
    { algorithm: 'HS256' },
  );
  return { accessToken, refreshToken };
}

/** A new session id: 128 random bits, base64url (22 characters, within OPAQUE_ID_RE). */
function newSessionId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** A raw statement's foreign-key refusal on `constraint` (P2010, SQLSTATE 23503, the constraint the driver names). */
function rawForeignKeyViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; constraint?: { index?: unknown } } } } } | null;
  if (!e || e.code !== 'P2010') return false;
  const cause = e.meta?.driverAdapterError?.cause;
  if (cause?.originalCode !== undefined && cause.originalCode !== '23503') return false;
  if (cause?.constraint?.index === constraint) return true;
  return typeof e.message === 'string' && e.message.includes('23503') && e.message.includes(constraint);
}

// ─── Opening a session ───────────────────────────────────────────────────────

export interface OpenSessionOptions {
  rememberMe: boolean;
  label: SessionLabel;
  /** The 401 a sign-in answers when its account was deleted while it ran (the insert's key to the account refused). */
  accountGoneMessage: string;
}

/**
 * Write a new session (generation 1) and sign its pair, on `db`: the client,
 * or the transaction that created the account (registration). It trims
 * nothing: createSession does, after the write.
 */
export async function openSession(db: SessionDb, account: SessionAccount, opts: OpenSessionOptions): Promise<OpenedSession> {
  let row: IssuedSessionRow;
  try {
    row = await store.insertSession(db, {
      id: newSessionId(),
      userId: account.userId,
      rememberMe: opts.rememberMe,
      tokenVersion: account.tokenVersion,
      clientKind: opts.label.kind,
      clientOs: opts.label.os,
      idleSeconds: idleSeconds(opts.rememberMe),
      maxAgeSeconds: MAX_AGE_SECONDS,
    });
  } catch (err) {
    if (rawForeignKeyViolation(err, 'sessions_user_id_fkey')) throw new UnauthorizedError(opts.accountGoneMessage);
    throw err;
  }
  return { sessionId: row.id, tokens: signSessionTokens(account, row) };
}

/**
 * Keep an account at SESSIONS.MAX_PER_ACCOUNT sessions after `keepId` was
 * written: the least recently renewed others are deleted (dead ones first)
 * and their sockets ended. A session renewed or re-keyed after the trim
 * ranked it, or held by another transaction while it runs, is kept
 * (store.evictSessionsBeyond), so an account may stay one over the cap
 * until its next sign-in. Never refuses anything and never throws: a trim
 * that fails is logged, and the next sign-in trims again.
 */
export async function trimSessions(userId: string, keepId: string): Promise<void> {
  let evicted: string[];
  try {
    evicted = await store.evictSessionsBeyond(prisma, userId, keepId, SESSIONS.MAX_PER_ACCOUNT - 1);
  } catch (err) {
    console.warn('[Sessions] Could not trim the sessions of an account past the cap:', describeCaughtError(err));
    return;
  }
  revokeSessionSockets(userId, evicted, SESSION_ENDED_REASON);
  if (evicted.length > 0) console.log(`[Sessions] Ended ${evicted.length} session(s) of an account past the cap of ${SESSIONS.MAX_PER_ACCOUNT}`);
}

/** A sign-in: a new session, the account kept within the cap, its pair. */
export async function createSession(account: SessionAccount, opts: OpenSessionOptions): Promise<SessionTokens> {
  const opened = await openSession(prisma, account, opts);
  await trimSessions(account.userId, opened.sessionId);
  return opened.tokens;
}

/**
 * The caller's own session after a version bump that keeps the caller signed
 * in (a password change, signing out of every other session), in the
 * transaction that bumped it: moved from `admittedVersion` (the version the
 * caller's access token was admitted with) to the account's new version and
 * a new generation, so the caller stays signed in while every older token
 * dies. A row gone (signed out from elsewhere meanwhile), expired or no
 * longer of the admitted version refuses (401 'Session invalidated'), and
 * the caller's transaction rolls back with it.
 */
export async function rekeySession(
  db: SessionDb,
  account: SessionAccount,
  sid: string,
  admittedVersion: number,
): Promise<SessionTokens> {
  const row = await store.rekeySession(db, {
    sid,
    userId: account.userId,
    fromTokenVersion: admittedVersion,
    tokenVersion: account.tokenVersion,
    rememberIdleSeconds: idleSeconds(true),
    sessionIdleSeconds: idleSeconds(false),
    maxAgeSeconds: MAX_AGE_SECONDS,
  });
  if (!row) throw new UnauthorizedError('Session invalidated');
  return signSessionTokens(account, row);
}

// ─── The refresh ─────────────────────────────────────────────────────────────

const INVALID_REFRESH_TOKEN = 'Invalid refresh token';

/** The one answer of every refusal of a refresh. */
function refused(): UnauthorizedError {
  return new UnauthorizedError(INVALID_REFRESH_TOKEN);
}

interface RefreshClaims {
  userId: string;
  /** 0 for a token minted before token versions existed, as before. */
  tokenVersion: number;
  /**
   * As the refresh read it before sessions: absent (or null) means yes,
   * anything else its truthiness. The sign-in signed whatever the body
   * carried, so a token minted then may hold a string or a number here.
   */
  rememberMe: boolean;
  /** Absent on a token issued before sessions. */
  sid?: string;
  gen?: number;
  exp?: number;
}

/**
 * The largest generation a token may carry: the column is a 32-bit integer.
 * A larger value is no token of ours, and is refused like any malformed one.
 */
export const GENERATION_MAX = 2_147_483_647;

/**
 * The claims of a verified refresh token, or null for a shape no signer of
 * ours produces. A token is a refresh token by its claims as well as by its
 * signature (utils/tokenShapes.ts: an access token, a two-factor challenge
 * or a trusted-device token is never one, whatever the secrets are).
 */
function readRefreshClaims(payload: unknown): RefreshClaims | null {
  const shape = refreshTokenShape(payload);
  if (shape === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.userId !== 'string' || p.userId.length === 0) return null;
  // A token version that is not a whole number can never equal the
  // account's: refused, as the comparison refused it before sessions
  const tokenVersion = p.tokenVersion ?? 0;
  if (!Number.isSafeInteger(tokenVersion)) return null;
  const claims: RefreshClaims = {
    userId: p.userId,
    tokenVersion: tokenVersion as number,
    rememberMe: Boolean(p.rememberMe ?? true),
    exp: typeof p.exp === 'number' ? p.exp : undefined,
  };
  if (shape === 'legacy') return claims;
  if (typeof p.sid !== 'string' || !OPAQUE_ID_RE.test(p.sid)) return null;
  if (typeof p.gen !== 'number' || !Number.isSafeInteger(p.gen) || p.gen < 0 || p.gen > GENERATION_MAX) return null;
  return { ...claims, sid: p.sid, gen: p.gen };
}

export interface RefreshContext {
  /**
   * True once the client that sent this refresh has gone (its connection
   * closed). Nothing is rotated or upgraded behind a client that cannot
   * receive the answer.
   */
  isClientGone: () => boolean;
  /** Whether the body carried a valid `client` field (2.2.0 clients): written into the reuse log line only. */
  hinted: boolean;
  /** The label of the session a token without `sid` is upgraded into. */
  label: SessionLabel;
}

/**
 * Renew a session with its refresh token: the new pair, or null when the
 * client was gone before anything was written (there is nobody to answer).
 * Throws the one 401 for every refusal; anything else is thrown as it is.
 */
export async function refreshSession(token: string, ctx: RefreshContext): Promise<SessionTokens | null> {
  let payload: unknown;
  try {
    payload = jwt.verify(token, refreshSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    if (isJwtVerifyError(err)) throw refused();
    throw err;
  }
  const claims = readRefreshClaims(payload);
  if (!claims) throw refused();
  if (claims.sid === undefined) return refreshLegacy(token, claims, ctx);
  return renew({ userId: claims.userId, tokenVersion: claims.tokenVersion, sid: claims.sid, gen: claims.gen! }, ctx, 0);
}

interface Presentation {
  userId: string;
  tokenVersion: number;
  sid: string;
  /** The generation presented: 0 for a token without `sid` presented again. */
  gen: number;
}

/** The renewal's decisions over one read of the row and its account (the time ones on the database's clock). */
async function renew(p: Presentation, ctx: RefreshContext, attempt: number): Promise<SessionTokens | null> {
  const row = await store.readSessionForRefresh(prisma, p.sid, p.userId, SESSIONS.REUSE_GRACE_SECONDS);
  // Signed out, ended, evicted, swept, or the account is gone
  if (!row) throw refused();
  // As before sessions: a banned account renews nothing (401, like every refusal here)
  if (row.banned) throw refused();
  // Left behind by a version bump (a password change or reset, a ban)
  if (row.rowVersion !== row.accountVersion) {
    await store.deleteStaleSession(prisma, p.sid, row.rowVersion);
    throw refused();
  }
  // A token minted before its own row was re-keyed (a renewal in flight
  // during a password change): refused, and the row the caller was just
  // handed new tokens for is kept
  if (p.tokenVersion !== row.accountVersion) throw refused();
  if (row.expired) {
    await store.deleteExpiredSession(prisma, p.sid);
    throw refused();
  }

  const account: SessionAccount = { userId: p.userId, username: row.username, role: row.role, tokenVersion: row.accountVersion };
  const L = row.generation;
  const k = p.gen;

  // The current generation, or a later one (only a genuine token can carry
  // it: a database restored from a backup keeps its sessions)
  if (k >= L) return rotate(account, p, ctx, row, Math.max(k, L) + 1, attempt);

  // The token just replaced, inside the grace window: the current
  // generation again, nothing written (a lost answer retried, two tabs)
  if (k === L - 1 && row.withinGrace) {
    return signSessionTokens(account, { id: p.sid, generation: L, rememberMe: row.rememberMe, exp: row.exp });
  }

  // Reuse: a replaced token after the grace window, or an older one
  const enforce = isFeatureEnabled('refresh_reuse_revocation');
  console.warn(
    `[Sessions] Refresh token reuse (${enforce ? 'enforce' : 'observe'}): session ${p.sid.slice(0, 6)}…, `
    + `generation ${k} presented, ${L} current, ${row.secondsSinceRotation} s after the last rotation, `
    + `client ${row.clientKind}, client field ${ctx.hinted ? 'present' : 'absent'}`,
  );
  if (enforce) {
    await store.deleteSession(prisma, p.sid, p.userId);
    revokeSessionSockets(p.userId, p.sid, SESSION_ENDED_REASON);
    throw refused();
  }
  // Observe: renewed as if it were the current generation
  return rotate(account, p, ctx, row, L + 1, attempt);
}

/** One conditional UPDATE from the generation read to `toGeneration`. */
async function rotate(
  account: SessionAccount,
  p: Presentation,
  ctx: RefreshContext,
  row: store.SessionRefreshRow,
  toGeneration: number,
  attempt: number,
): Promise<SessionTokens | null> {
  // A session at the column's last generation cannot rotate again: it ends
  // (a refusal) rather than overflowing the column (a 500 at every renewal)
  if (toGeneration > GENERATION_MAX) throw refused();
  if (ctx.isClientGone()) return null;
  const rotated = await store.rotateSession(prisma, {
    sid: p.sid,
    fromGeneration: row.generation,
    toGeneration,
    idleSeconds: idleSeconds(row.rememberMe),
    maxAgeSeconds: MAX_AGE_SECONDS,
  });
  if (rotated) return signSessionTokens(account, rotated);
  // Another renewal moved the generation first (or the row expired or went
  // meanwhile): read it again and decide once more. A second lost race is
  // not a refusal: it answers 500 and the client asks again.
  if (attempt > 0) throw new Error('A session rotation lost the race twice');
  return renew(p, ctx, attempt + 1);
}

/** The SHA-256 of a token without `sid`, its redemption key. */
function legacyDigest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A refresh token issued before sessions: today's checks, then, on its first
 * presentation, an upgrade into a new session in one transaction (the digest
 * claimed and the session written, or neither). A later presentation is
 * generation 0 of that session.
 *
 * The upgrade's transaction keeps Prisma's default budget (5 s). Its insert
 * waits on the account row only behind an account deletion (the key to
 * `users`): a deletion that commits makes the insert fail on that key, the
 * one refusal here (401, the account is gone); a wait that outlasts the
 * budget expires the transaction (P2028, not retried), which surfaces as a
 * 500, never a 401, and the client keeps its token and asks again.
 */
async function refreshLegacy(token: string, claims: RefreshClaims, ctx: RefreshContext): Promise<SessionTokens | null> {
  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, username: true, role: true, tokenVersion: true, bannedAt: true },
  });
  if (!user) throw refused();
  if (user.bannedAt) throw refused();
  if (user.tokenVersion !== claims.tokenVersion) throw refused();

  const digest = legacyDigest(token);
  const known = await store.readLegacyRedemption(prisma, digest);
  if (known) return presentLegacyAgain(claims, known.sessionId, ctx);

  if (ctx.isClientGone()) return null;
  const account: SessionAccount = { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion };
  const expSeconds = claims.exp ?? Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const upgraded = await retryOnTransactionConflict(
    () => prisma.$transaction(async (tx) => {
      if (!(await store.claimLegacyRedemption(tx, digest, expSeconds))) return null;
      const opened = await openSession(tx, account, {
        rememberMe: claims.rememberMe,
        label: ctx.label,
        accountGoneMessage: INVALID_REFRESH_TOKEN,
      });
      await store.linkLegacyRedemption(tx, digest, opened.sessionId);
      return opened;
    }),
    '[Sessions] A refresh token upgrade',
  );
  if (upgraded) {
    await trimSessions(account.userId, upgraded.sessionId);
    return upgraded.tokens;
  }
  // A concurrent presentation of the same token upgraded it first
  const claimed = await store.readLegacyRedemption(prisma, digest);
  if (!claimed) throw new Error('A refresh token upgrade lost its race to a claim that is gone');
  return presentLegacyAgain(claims, claimed.sessionId, ctx);
}

async function presentLegacyAgain(claims: RefreshClaims, sessionId: string | null, ctx: RefreshContext): Promise<SessionTokens | null> {
  // Signed out with this token, or its session ended since: never again
  if (sessionId === null) throw refused();
  return renew({ userId: claims.userId, tokenVersion: claims.tokenVersion, sid: sessionId, gen: 0 }, ctx, 0);
}

// ─── Sign-out ────────────────────────────────────────────────────────────────

/**
 * POST /auth/logout: end the session a refresh token names, whatever its
 * generation or version (the token a client holds at its sign-out may have
 * been replaced by a renewal whose answer it dropped). A token jsonwebtoken
 * refuses, or one that names nothing, ends nothing and is not an error: the
 * route answers the same 204 for all of them. A token without `sid` is
 * recorded as spent, and the session it was upgraded into, if any, ended.
 * A failing statement is thrown (500: the sign-out did not happen).
 */
export async function endSessionWithRefreshToken(token: string): Promise<void> {
  let payload: unknown;
  try {
    payload = jwt.verify(token, refreshSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    if (isJwtVerifyError(err)) return;
    throw err;
  }
  const claims = readRefreshClaims(payload);
  if (!claims) return;
  if (claims.sid !== undefined) {
    const deleted = await store.deleteSession(prisma, claims.sid, claims.userId);
    if (deleted > 0) revokeSessionSockets(claims.userId, claims.sid, SESSION_ENDED_REASON);
    return;
  }
  const digest = legacyDigest(token);
  const expSeconds = claims.exp ?? Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const ended = await retryOnTransactionConflict(
    () => prisma.$transaction((tx) => store.spendLegacyRedemption(tx, digest, expSeconds, claims.userId)),
    '[Sessions] A sign-out with a refresh token issued before sessions',
  );
  if (ended.length > 0) revokeSessionSockets(claims.userId, ended, SESSION_ENDED_REASON);
}

/**
 * End one session of one account and its sockets (for a per-session
 * sign-out). True when a row was deleted. A failing statement is thrown.
 */
export async function revokeSession(userId: string, sid: string, reason: string): Promise<boolean> {
  const deleted = await store.deleteSession(prisma, sid, userId);
  if (deleted > 0) revokeSessionSockets(userId, sid, reason);
  return deleted > 0;
}

// ─── The list, and signing out of the other sessions ─────────────────────────

/**
 * The most sessions the list shows: the cap, with room for sign-ins that raced
 * it.
 */
export const SESSION_LIST_MAX = SESSIONS.MAX_PER_ACCOUNT * 2;

function listedKind(value: string): SessionClientKind {
  return (SESSION_CLIENT_KINDS as readonly string[]).includes(value) ? (value as SessionClientKind) : 'unknown';
}

function listedOs(value: string): SessionClientOs {
  return (SESSION_CLIENT_OSES as readonly string[]).includes(value) ? (value as SessionClientOs) : 'other';
}

/**
 * GET /auth/sessions: the account's live sessions (store.listLiveSessions),
 * each as its label from the closed lists, the day it was signed in and the
 * hour it last renewed itself, and whether it is the caller's own
 * (`currentSid`, the access token's; none is when the token names none).
 */
export async function listSessions(userId: string, currentSid: string | undefined): Promise<SessionSummary[]> {
  const rows = await store.listLiveSessions(prisma, userId, currentSid ?? null, SESSION_LIST_MAX);
  return rows.map((r) => ({
    id: r.id,
    clientKind: listedKind(r.clientKind),
    clientOs: listedOs(r.clientOs),
    signedInAt: new Date(r.signedInAt * 1000).toISOString(),
    lastActiveAt: new Date(r.lastActiveAt * 1000).toISOString(),
    current: currentSid !== undefined && r.id === currentSid,
  }));
}

/**
 * Signing out of every other session, in the transaction that bumped the
 * account's version: every session but `keepId` deleted (their sockets are
 * the caller's to end after the commit). The ids, and how many of them were
 * live at `liveVersion`, the version before the bump.
 */
export async function endOtherSessions(
  db: SessionDb,
  userId: string,
  keepId: string,
  liveVersion: number,
): Promise<{ ended: string[]; live: number }> {
  const rows = await store.deleteOtherSessions(db, userId, keepId, liveVersion);
  return { ended: rows.map((r) => r.id), live: rows.filter((r) => r.live).length };
}

// ─── The access check (authenticate, the socket handshake and its re-check) ──

const ACCOUNT_GATE_SELECT = {
  bannedAt: true,
  tokenVersion: true,
  role: true,
  emailVerified: true,
  termsAcceptedAt: true,
  privacyAcceptedAt: true,
} as const;

export interface AccessState {
  bannedAt: Date | null;
  tokenVersion: number;
  role: string;
  emailVerified: boolean;
  termsAcceptedAt: Date | null;
  privacyAcceptedAt: Date | null;
  /**
   * For an access token naming a session: whether that session is live (its
   * row exists, holds the account's token version and has not expired).
   * Null for a token issued before sessions, which keeps the account checks
   * alone until such tokens are no longer accepted.
   */
  sessionLive: boolean | null;
}

/** The `sid` claim of a verified access token: undefined (none), the id, or null for a value no signer of ours writes. */
export function readAccessSessionId(payload: { sid?: unknown }): string | undefined | null {
  if (payload.sid === undefined) return undefined;
  return typeof payload.sid === 'string' && OPAQUE_ID_RE.test(payload.sid) ? payload.sid : null;
}

/**
 * The account and, for a token naming one, its session: ONE statement (the
 * session is a relation of the account, loaded by a join). Null when the
 * account is gone. A failing lookup is thrown, never read as a refusal.
 *
 * The session's expiry is judged here on this node's clock (`Date.now()`,
 * like the access token's own `exp`): the one place a session's liveness is
 * not decided on the database's clock. It only bounds an access token,
 * which lives JWT_EXPIRES_IN at most; the refresh decides every expiry on
 * the database's clock (store.readSessionForRefresh), so a node clock that
 * is off moves when an access token stops being accepted, never whether
 * its session can be renewed.
 */
export async function loadAccessState(userId: string, sid: string | undefined): Promise<AccessState | null> {
  if (sid === undefined) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT_GATE_SELECT });
    return user ? { ...user, sessionLive: null } : null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...ACCOUNT_GATE_SELECT,
      sessions: { where: { id: sid }, select: { tokenVersion: true, expiresAt: true }, take: 1 },
    },
  });
  if (!user) return null;
  const { sessions, ...account } = user;
  const session = sessions[0];
  const sessionLive = session !== undefined
    && session.tokenVersion === account.tokenVersion
    && session.expiresAt.getTime() > Date.now();
  return { ...account, sessionLive };
}
