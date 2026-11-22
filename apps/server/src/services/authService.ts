import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import geoip from 'geoip-lite';
import { prisma } from '../utils/prisma';
import type { RegistrationConsent, RevokeOtherSessionsResponse } from '@voxium/shared';
import { OPAQUE_ID_RE, SESSION_REVOKE_CURRENT_MESSAGE, SIGNED_OUT_ELSEWHERE_REASON } from '@voxium/shared';
import {
  BadRequestError, ForbiddenError, OwnedServersError, PasswordStepUpError, ServiceUnavailableError, SessionNotFoundError,
  UnauthorizedError, prismaErrorCode,
} from '../utils/errors';
import { isJwtVerifyError } from '../utils/jwtErrors';
import { revokeOtherSessionSockets } from '../utils/sessionRevocation';
import { validateEmail, validatePassword, canonicalizeEmail, TRUSTED_DEVICE_TTL_DAYS } from '@voxium/shared';
import { sendPasswordResetEmail, sendVerificationEmail, describeEmailError, failedBeforeAnyRecipient, MailSuppressedError } from '../utils/email';
import { isMailSuppressed } from '../utils/mailSuppression';
import { consumeMailCap, refundRateLimit, normalizeIp } from '../middleware/rateLimiter';
import { consentIsRequired } from '../middleware/auth';
import { verifyTOTP } from './totpService';
import { deleteUserAccount } from '../utils/accountDeletion';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from '../utils/transactionRetry';
import { lockAccountAtVersion } from '../utils/accountRowLocks';
import {
  createSession, openSession, rekeySession, trimSessions, readCarriedLabel, carriedLabel, endOtherSessions,
  revokeSession, type SessionLabel, type SessionTokens,
} from './sessionService';
import { describeCaughtError, describeCaughtErrorWithStack } from '../utils/loggableError';

/**
 * The consent SELECT fragment every user payload includes, and the mapping
 * from the two stored timestamps to the single `consentRequired` flag the
 * client acts on. The timestamps themselves are an accountability record, not
 * something the client needs; they stay server-side.
 */
export const CONSENT_SELECT = { termsAcceptedAt: true, privacyAcceptedAt: true } as const;

export function withConsentFlag<T extends { termsAcceptedAt: Date | null; privacyAcceptedAt: Date | null }>(
  user: T,
): Omit<T, 'termsAcceptedAt' | 'privacyAcceptedAt'> & { consentRequired: boolean } {
  const { termsAcceptedAt, privacyAcceptedAt, ...rest } = user;
  return { ...rest, consentRequired: consentIsRequired({ termsAcceptedAt, privacyAcceptedAt }) };
}

// Timing-equalization hash for login attempts against unknown emails (same
// convention as requestPasswordReset): skipping bcrypt when the user doesn't
// exist makes the response measurably faster, enumerating registered emails.
// Generated EAGERLY at module load with the same cost factor as real password
// hashes — lazy init would make the first unknown-email login pay hash+compare
// (2× a real login's cost), itself a one-request timing signal.
let timingEqualizerHash: string | null = null;
const timingEqualizerReady = bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12)
  .then((hash) => { timingEqualizerHash = hash; })
  .catch((err) => console.warn('[Auth] Timing-equalizer hash init failed (will retry lazily):', describeCaughtErrorWithStack(err)));

async function getTimingEqualizerHash(): Promise<string> {
  if (!timingEqualizerHash) {
    await timingEqualizerReady;
    if (!timingEqualizerHash) {
      timingEqualizerHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12);
    }
  }
  return timingEqualizerHash;
}

/**
 * `label` is what the session this sign-in opens is labelled as (derived by
 * the route from the request, sessionService.deriveSessionLabel); a sign-in
 * that needs its two-factor step carries it in the challenge token, so the
 * session opened by that step is labelled from the request that typed the
 * password.
 */
export async function loginUser(email: string, password: string, rememberMe: boolean, rawIp: string | undefined, trustedDeviceToken: string | undefined, label: SessionLabel) {
  email = email.toLowerCase().trim();

  // The SAME normalization startRegistration and every limiter use. This was the
  // last private copy of the `::ffff:` strip: case-sensitive, blind to zone ids
  // and to the hex IPv4-mapped form, so `::FFFF:1.2.3.4` reached ipBan as an
  // IPv6 string that no ban row is ever written as. Two keyed controls that
  // disagree about an address fail OPEN, and nothing on the happy path notices.
  const ip = rawIp ? normalizeIp(rawIp) : undefined;

  // Check IP ban before anything else
  if (ip) {
    const ipBan = await prisma.ipBan.findUnique({ where: { ip } });
    if (ipBan) throw new ForbiddenError(ipBan.reason ? `Account banned: ${ipBan.reason}` : 'Your account has been banned');
  }

  // Need password for verification, plus fields for auth and response
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      avatarUrl: true,
      bio: true,
      status: true,
      role: true,
      password: true,
      totpEnabled: true,
      emailVerified: true,
      isSupporter: true, supporterTier: true,
      tokenVersion: true,
      bannedAt: true,
      banReason: true,
      createdAt: true,
      ...CONSENT_SELECT,
    },
  });

  if (!user) {
    // Burn the same bcrypt cost as a real comparison so an unknown email is
    // indistinguishable from a wrong password by response time
    await bcrypt.compare(password, await getTimingEqualizerHash());
    throw new UnauthorizedError('Invalid credentials');
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) throw new UnauthorizedError('Invalid credentials');

  // Check account ban
  if (user.bannedAt) throw new ForbiddenError(user.banReason ? `Account banned: ${user.banReason}` : 'Your account has been banned');

  // Upsert IP record with geolocation
  if (ip) {
    const geo = geoip.lookup(ip);
    const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const geoFields = geo ? {
      countryCode: geo.country || null,
      country: (geo.country && countryNames.of(geo.country)) || geo.country || null,
    } : {};
    await prisma.ipRecord.upsert({
      where: { userId_ip: { userId: user.id, ip } },
      update: { lastSeenAt: new Date(), ...geoFields },
      create: { userId: user.id, ip, ...geoFields },
    }).catch((err) => console.warn('[Auth] IP record upsert failed:', describeCaughtErrorWithStack(err)));
  }

  // If TOTP is enabled, check for trusted device token
  if (user.totpEnabled) {
    let deviceTrusted = false;
    if (trustedDeviceToken) {
      try {
        const payload = jwt.verify(trustedDeviceToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as { userId: string; purpose: string; tokenVersion?: number };
        if (payload.purpose === 'trusted-device' && payload.userId === user.id && payload.tokenVersion === user.tokenVersion) {
          deviceTrusted = true;
        }
      } catch {
        // Invalid/expired token — require TOTP
      }
    }

    if (!deviceTrusted) {
      const totpToken = jwt.sign(
        { userId: user.id, purpose: 'totp-verify', rememberMe, cl: carriedLabel(label) },
        process.env.JWT_SECRET!,
        { expiresIn: '5m' } as jwt.SignOptions,
      );
      return { totpRequired: true, totpToken };
    }
  }

  // An account deleted while this ran answers what a wrong password does
  const tokens = await createSession(
    { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion },
    { rememberMe, label, accountGoneMessage: 'Invalid credentials' },
  );

  const { password: _, tokenVersion: _tv, bannedAt: _ba, banReason: _br, ...safeUser } = user;

  return { user: withConsentFlag(safeUser), ...tokens };
}

/**
 * The two-factor step of a sign-in. The session it opens is labelled with
 * the label the challenge token carries (the password step's request), else
 * `fallbackLabel` (this request's: a challenge issued before the label was
 * carried).
 */
export async function verifyLoginTOTP(totpToken: string, code: string, fallbackLabel: SessionLabel) {
  let payload: { userId: string; purpose: string; rememberMe: boolean; cl?: unknown };
  try {
    payload = jwt.verify(totpToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    throw new UnauthorizedError('Invalid or expired TOTP token');
  }

  if (payload.purpose !== 'totp-verify') throw new UnauthorizedError('Invalid token purpose');

  const { verifyTOTP } = await import('./totpService');
  const valid = await verifyTOTP(payload.userId, code);
  if (!valid) throw new BadRequestError('Invalid verification code');

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      avatarUrl: true,
      bio: true,
      status: true,
      role: true,
      totpEnabled: true,
      emailVerified: true,
      isSupporter: true, supporterTier: true,
      tokenVersion: true,
      createdAt: true,
      ...CONSENT_SELECT,
    },
  });
  if (!user) throw new UnauthorizedError('User not found');

  const tokens = await createSession(
    { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion },
    {
      // As before sessions: a challenge without the claim signs in
      // remembered, otherwise its truthiness (a challenge issued before the
      // deploy carries whatever the sign-in body held)
      rememberMe: payload.rememberMe === undefined ? true : Boolean(payload.rememberMe),
      label: readCarriedLabel(payload.cl) ?? fallbackLabel,
      accountGoneMessage: 'User not found',
    },
  );
  const { tokenVersion: _tv, ...safeUser } = user;

  // Issue a trusted device token (TRUSTED_DEVICE_TTL_DAYS, the figure the
  // Security tab quotes) — includes tokenVersion so password changes invalidate it
  const trustedDeviceToken = signTrustedDeviceToken(user.id, user.tokenVersion);

  return { user: withConsentFlag(safeUser), ...tokens, trustedDeviceToken };
}

/**
 * A trusted-device token (skips the two-factor step at a sign-in on that
 * device): bound to the account and its token version, so a version bump
 * ends it. `exp` keeps the expiry of a token it replaces; without it, a
 * fresh TRUSTED_DEVICE_TTL_DAYS.
 */
function signTrustedDeviceToken(userId: string, tokenVersion: number, exp?: number): string {
  if (exp !== undefined) {
    return jwt.sign({ userId, purpose: 'trusted-device', tokenVersion, exp }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
  }
  return jwt.sign(
    { userId, purpose: 'trusted-device', tokenVersion },
    process.env.JWT_SECRET!,
    { expiresIn: `${TRUSTED_DEVICE_TTL_DAYS}d` } as jwt.SignOptions,
  );
}

/**
 * The claims of a trusted-device token that verifies (HS256, the access
 * secret, not expired, purpose 'trusted-device'), or null for anything else.
 * Never throws: it is read after a commit, where an exception would answer
 * 500 to a request that has done its work.
 */
function readTrustedDeviceToken(token: string): { userId: string; tokenVersion: number | undefined; exp: number } | null {
  if (token.length === 0 || token.length > 4096) return null;
  let payload: unknown;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] });
  } catch (err) {
    if (!isJwtVerifyError(err)) console.warn('[Auth] A trusted-device token could not be read:', describeCaughtError(err));
    return null;
  }
  const p = payload as { userId?: unknown; purpose?: unknown; tokenVersion?: unknown; exp?: unknown } | null;
  if (!p || typeof p !== 'object' || p.purpose !== 'trusted-device' || typeof p.userId !== 'string' || typeof p.exp !== 'number') return null;
  return { userId: p.userId, tokenVersion: typeof p.tokenVersion === 'number' ? p.tokenVersion : undefined, exp: p.exp };
}

export async function requestPasswordReset(email: string) {
  email = email.toLowerCase().trim();

  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);

  // The two fields the reset uses, never the row: it holds the password hash
  // and the two-factor secret (auth queries select what they need)
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });

  // Generate the token regardless of whether the user exists, so the two
  // branches do the same in-process work before answering.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Per-INBOX daily cap, mirroring the verification-mail cap: the 3/15min IP
  // limiter is useless against distributed sources, and without this a botnet
  // can drip password-reset mail at a victim's real address indefinitely.
  // On cap: SILENT skip, never an error — this endpoint's response must stay
  // identical for existing and unknown emails (enumeration safety), so the
  // only honest option is to stop sending while answering the same way.
  // The decision is made OUTSIDE consumeMailCap's fail-open try (it returns a
  // boolean rather than throwing) — a `return` inside one has been benign so
  // far only because it cannot throw.
  //
  // Charged on BOTH branches, keyed on the address as asked. The unknown-email
  // branch used to return before this round trip while the known-email one
  // paid it, which is a timing difference the wording defence cannot hide.
  // Charging an inbox that does not exist costs nothing and sends nothing.
  const inbox = canonicalizeEmail(email);
  const underCap = await consumeMailCap('resetMail', inbox);

  if (!user) return; // Silent return — same response, same work, as a real reset

  if (!underCap) {
    console.warn('[Auth] Password-reset mail cap reached for an inbox — skipping send');
    return;
  }

  // NOT awaited — neither the token write nor the send. Both branches above
  // return after the same work (one lookup, one cap consume, two hashes);
  // anything the known-email branch still awaited here — a DB UPDATE, let
  // alone an unpooled SMTP transaction that can sit out a connect timeout —
  // answered measurably later, and both branches return the identical body,
  // so the CLOCK was the only oracle left. The write stays sequenced before
  // the send (a link must not arrive before its token exists), and each step
  // keeps its own error report; they just no longer sit on the response path.
  void (async () => {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken: hashedToken,
          resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
        select: { id: true },
      });
    } catch (err) {
      console.error('[Auth] Failed to store password reset token:', describeCaughtError(err));
      // No token in the DB, so no mail: a link would be dead on arrival. The
      // mailbox gets back the point this request spent
      await refundRateLimit('resetMail', inbox);
      return;
    }
    await sendPasswordResetEmail(user.email, rawToken)
      .catch(async (err) => {
        // The mailbox blocked Voxium mail (utils/mailSuppression.ts): the
        // sender refused before the transport, the token stored above is
        // unusable without the mail, and the response was already sent.
        if (err instanceof MailSuppressedError) {
          console.warn('[Auth] Password-reset mail skipped: the mailbox blocked Voxium mail');
          return;
        }
        console.error('[Auth] Failed to send password reset email:', describeEmailError(err));
        // A failure that proves no recipient was reached (the relay could not
        // be resolved, connected to, greeted, secured or logged in to) gives
        // the mailbox its point back, in the background like the rest. The
        // previous token is NOT restored: it is a bearer link, and the mail
        // that carried it may have reached someone. A refused recipient or a
        // failure during or after DATA is no such proof and keeps the point.
        if (failedBeforeAnyRecipient(err)) await refundRateLimit('resetMail', inbox);
      });
  })();
}

/** Returns the id of the account whose password was reset. */
export async function resetPassword(token: string, newPassword: string): Promise<{ userId: string }> {
  if (!token) throw new BadRequestError('Reset token is required');

  const passwordErr = validatePassword(newPassword);
  if (passwordErr) throw new BadRequestError(passwordErr);

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  // Every query here selects what it uses: without a select a read, or the
  // row an update returns, carries the password hash and the two-factor secret
  const user = await prisma.user.findUnique({
    where: { resetToken: hashedToken },
    select: { id: true, resetTokenExpiresAt: true },
  });

  if (!user) throw new BadRequestError('Invalid or expired reset token');

  if (user.resetTokenExpiresAt && user.resetTokenExpiresAt < new Date()) {
    // Token exists but has expired -- clear it and reject
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: null, resetTokenExpiresAt: null },
      select: { id: true },
    });
    throw new BadRequestError('Invalid or expired reset token');
  }

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      resetToken: null,
      resetTokenExpiresAt: null,
      tokenVersion: { increment: 1 },
    },
    select: { id: true },
  });
  return { userId: user.id };
}

/**
 * Change the password of a signed-in account, keeping the CALLER signed in:
 * the version bump ends every other session (and every token of the old
 * version), and in the same transaction the caller's own session (`sid`, the
 * access token's) moves to the new version and a new generation, whose pair
 * is the answer. A caller whose access token names no session (issued before
 * sessions) gets a new one, labelled `label`, with `rememberMe`.
 * `admittedVersion` is the token version the caller's access token was
 * admitted with: a caller whose session ended meanwhile, or whose account
 * moved to another version meanwhile (a reset, a ban, another change), is
 * refused (401 'Session invalidated') and nothing is written.
 */
export async function changePassword(
  userId: string,
  sid: string | undefined,
  admittedVersion: number,
  currentPassword: string,
  newPassword: string,
  rememberMe: boolean,
  label: SessionLabel,
): Promise<SessionTokens> {
  const passwordErr = validatePassword(newPassword);
  if (passwordErr) throw new BadRequestError(passwordErr);

  // The hash is the one column this needs (to compare); not the two-factor secret, not the rest of the row
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
  if (!user) throw new UnauthorizedError('User not found');

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) throw new PasswordStepUpError('Current password is incorrect');

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  // The account row first, locked and still at the caller's admitted
  // version (lockAccountAtVersion: a reset or a ban that committed while
  // the hash ran refuses this change), then the bump, then the caller's
  // session row: the order an account deletion takes them in (its cascade
  // reaches the sessions after its account-row lock) and a ban takes the
  // account row in; a renewal takes only the session row. The account row
  // may be held for long (a ban, a deletion): the lock-wait budget, and a
  // deadlock victim is run again whole, every check with it.
  const outcome = await retryOnTransactionConflict(
    () => prisma.$transaction(async (tx) => {
      await lockAccountAtVersion(tx, user.id, admittedVersion);
      let updated: { id: string; username: string; role: string; tokenVersion: number };
      try {
        updated = await tx.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            tokenVersion: { increment: 1 },
          },
          select: { id: true, username: true, role: true, tokenVersion: true },
        });
      } catch (err) {
        if (prismaErrorCode(err) === 'P2025') throw new UnauthorizedError('User not found');
        throw err;
      }
      const account = { userId: updated.id, username: updated.username, role: updated.role, tokenVersion: updated.tokenVersion };
      // Fresh tokens so the current session survives the version bump
      if (sid !== undefined) return { tokens: await rekeySession(tx, account, sid, admittedVersion), openedId: null };
      const opened = await openSession(tx, account, { rememberMe, label, accountGoneMessage: 'User not found' });
      return { tokens: opened.tokens, openedId: opened.sessionId };
    }, LOCK_WAIT_TRANSACTION_OPTIONS),
    '[Auth] A password change',
  );
  if (outcome.openedId !== null) await trimSessions(userId, outcome.openedId);
  return outcome.tokens;
}

// ─── Signing out of one session, or of every other ──────────────────────────

/**
 * The account password, as the step-up of the two session sign-outs below:
 * the hash work is done on every branch (an account gone since the caller
 * was admitted is compared against the equalizer hash, then 401 'User not
 * found'). A wrong password is PasswordStepUpError (400 'Password is
 * incorrect'), the one answer whose step-up charge is kept (routes/auth.ts).
 * It runs before anything that depends on a session id, so the time and the
 * answer of a wrong password never tell whether one exists.
 */
async function requireAccountPassword(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  const valid = await bcrypt.compare(password, user ? user.password : await getTimingEqualizerHash());
  if (!user) throw new UnauthorizedError('User not found');
  if (!valid) throw new PasswordStepUpError();
}

/**
 * DELETE /auth/sessions/:sessionId: end ONE other session of the caller's
 * account, after the password step-up. An id no session can carry, an
 * unknown one and one of another account answer the same 404 'Session not
 * found'; the caller's own session is 400 (signing out is what ends it).
 * The session is ended whatever its state, and its sockets are told
 * SIGNED_OUT_ELSEWHERE_REASON and closed, with the account's sockets that
 * name no session (closed without being told; revokeSessionSockets).
 */
export async function revokeOneSession(userId: string, callerSid: string | undefined, sessionId: string, password: string): Promise<void> {
  await requireAccountPassword(userId, password);
  if (!OPAQUE_ID_RE.test(sessionId)) throw new SessionNotFoundError();
  if (sessionId === callerSid) throw new BadRequestError(SESSION_REVOKE_CURRENT_MESSAGE);
  if (!(await revokeSession(userId, sessionId, SIGNED_OUT_ELSEWHERE_REASON))) throw new SessionNotFoundError();
}

export interface RevokeOtherSessionsInput {
  userId: string;
  /**
   * The caller's session (its access token's `sid`); none for a token issued
   * before sessions.
   */
  sid: string | undefined;
  /** The token version the caller's access token was admitted with. */
  admittedVersion: number;
  password: string;
  /**
   * The caller's trusted-device token, when it sent one: re-issued under the
   * new version if it is valid for this account at the old one.
   */
  trustedDeviceToken: string | undefined;
  /**
   * For a caller whose token names no session: its new session's "Remember me".
   */
  rememberMe: boolean;
  /** For a caller whose token names no session: its new session's label. */
  label: SessionLabel;
}

/**
 * POST /auth/sessions/revoke-others: sign out of every other session of the
 * account, after the password step-up, keeping the caller signed in. ONE
 * transaction, the order of the password change and a ban:
 *  1. the account row locked ('update' mode) and still at the caller's
 *     admitted version (lockAccountAtVersion: a reset, a ban, a password
 *     change or another of these that committed meanwhile refuses with 401
 *     'Session invalidated'; an account gone, 401 'User not found');
 *  2. the account's token version bumped: every token of the old version
 *     dies at once, the access tokens of every other device, the refresh
 *     tokens issued before sessions, the trusted-device tokens;
 *  3. the caller's own session re-keyed to the new version and a new
 *     generation (only while it holds the admitted version), or, for a
 *     caller whose token names none, a new session opened;
 *  4. every other session of the account deleted.
 * The lock-wait budget (an account deletion or a ban can hold the account
 * row for long); a deadlock victim is run again whole, every check with it.
 * After the commit: every other session's sockets are told and every
 * socket of the account closed, the caller's too (revokeOtherSessionSockets:
 * opened on the old version's tokens, it reopens with the fresh pair), and
 * the answer carries the caller's fresh
 * pair, the number of other live sessions ended and, when the request
 * carried one valid for this account at the old version, the caller's
 * trusted-device token re-issued under the new one with the same expiry.
 */
export async function revokeOtherSessions(input: RevokeOtherSessionsInput): Promise<RevokeOtherSessionsResponse> {
  const { userId, sid, admittedVersion } = input;
  await requireAccountPassword(userId, input.password);

  // The trusted-device token is checked against the version the transaction
  // requires; it is signed again only once the bump has committed
  const trusted = input.trustedDeviceToken !== undefined ? readTrustedDeviceToken(input.trustedDeviceToken) : null;
  const keepTrust = trusted !== null && trusted.userId === userId && trusted.tokenVersion === admittedVersion;

  const outcome = await retryOnTransactionConflict(
    () => prisma.$transaction(async (tx) => {
      await lockAccountAtVersion(tx, userId, admittedVersion);
      const bumped = await tx.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
        select: { id: true, username: true, role: true, tokenVersion: true },
      });
      const account = { userId: bumped.id, username: bumped.username, role: bumped.role, tokenVersion: bumped.tokenVersion };
      let tokens: SessionTokens;
      let keepId: string;
      if (sid !== undefined) {
        tokens = await rekeySession(tx, account, sid, admittedVersion);
        keepId = sid;
      } else {
        const opened = await openSession(tx, account, { rememberMe: input.rememberMe, label: input.label, accountGoneMessage: 'User not found' });
        tokens = opened.tokens;
        keepId = opened.sessionId;
      }
      const others = await endOtherSessions(tx, userId, keepId, admittedVersion);
      return { tokens, live: others.live, newVersion: bumped.tokenVersion };
    }, LOCK_WAIT_TRANSACTION_OPTIONS),
    '[Auth] Signing out of the other sessions',
  );

  // Committed: nothing below may throw (best effort, logged)
  revokeOtherSessionSockets(userId, sid, SIGNED_OUT_ELSEWHERE_REASON);
  let trustedDeviceToken: string | undefined;
  if (keepTrust) {
    try {
      trustedDeviceToken = signTrustedDeviceToken(userId, outcome.newVersion, trusted.exp);
    } catch (err) {
      console.warn('[Auth] The trusted-device token could not be re-issued:', describeCaughtError(err));
    }
  }
  return {
    revoked: outcome.live,
    accessToken: outcome.tokens.accessToken,
    refreshToken: outcome.tokens.refreshToken,
    ...(trustedDeviceToken !== undefined ? { trustedDeviceToken } : {}),
  };
}

export async function verifyEmail(token: string) {
  if (!token) throw new BadRequestError('Verification token is required');

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findUnique({
    where: { emailVerificationToken: hashedToken },
    select: { id: true, emailVerificationTokenExpiresAt: true },
  });

  if (!user) throw new BadRequestError('Invalid or expired verification link');

  if (user.emailVerificationTokenExpiresAt && user.emailVerificationTokenExpiresAt < new Date()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
      select: { id: true },
    });
    throw new BadRequestError('Invalid or expired verification link');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerifiedAt: new Date(),
      emailVerificationToken: null,
      emailVerificationTokenExpiresAt: null,
    },
    select: { id: true },
  });
}

/** What a resend answers for a mailbox on the suppression list (mapped in the desktop's serverErrors.ts). */
export const MAIL_BLOCKED_MESSAGE = 'Mail to this address is blocked — use the link in an earlier Voxium email to allow it again';

/** What a resend answers when the mail could not be sent (mapped in the desktop's serverErrors.ts). */
export const VERIFICATION_SEND_FAILED_MESSAGE = 'The verification email could not be sent — please try again later';

export async function resendVerificationEmail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    // The current link's digest and expiry too, so a send that fails can put
    // them back: they never leave this function.
    select: {
      id: true, email: true, emailVerified: true,
      emailVerificationToken: true, emailVerificationTokenExpiresAt: true,
    },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.emailVerified) throw new BadRequestError('Email already verified');

  // The mailbox asked never to receive Voxium mail ("Not you? Block Voxium
  // mail to this address"). The one caller who may legitimately hear this is
  // the mailbox's owner, signed in to an account they created after blocking
  // us — so say what happened and how to undo it, before any cap is spent or
  // token rewritten. (The sender refuses too, for a block landing in between.)
  if (await isMailSuppressed(user.email)) throw new BadRequestError(MAIL_BLOCKED_MESSAGE);

  // Hard daily cap PER INBOX, keyed on the canonical form: the per-user
  // limiter (3/5min) bounds the burst rate, but a bot that owns the account
  // can keep bursting forever — turning us into a drip harasser of whoever
  // really owns the address. 5 mails to one mailbox per day is the ceiling
  // no matter which account, IP, or cadence asks. Fail open on store errors:
  // a broken counter must not lock legitimate users out of verification.
  const inbox = canonicalizeEmail(user.email);
  if (!(await consumeMailCap('verifyMail', inbox))) {
    throw new BadRequestError('Too many verification emails requested — try again tomorrow');
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  // The token is stored BEFORE the send, so a link never arrives ahead of the
  // row that makes it work. Every way out below that sends nothing gives the
  // mailbox its point back (refunded, never a read in place of the consume)
  // and, once the new token is written, puts the previous link back in force.
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
  } catch (err) {
    await refundRateLimit('verifyMail', inbox);
    throw err;
  }

  try {
    await sendVerificationEmail(user.email, rawToken);
  } catch (err) {
    await refundRateLimit('verifyMail', inbox);
    await restorePreviousVerificationLink(user, hashedToken);
    if (err instanceof MailSuppressedError) throw new BadRequestError(MAIL_BLOCKED_MESSAGE);
    // Never the error object: an SMTP refusal quotes the recipient address
    console.error('[Auth] Failed to send verification email:', describeEmailError(err));
    throw new ServiceUnavailableError(VERIFICATION_SEND_FAILED_MESSAGE);
  }
}

/**
 * Put back the verification token a failed resend replaced, so the link the
 * user already holds keeps working. Only while the row still holds the token
 * this resend wrote: a resend that succeeded meanwhile keeps its own, and a
 * verification that landed meanwhile keeps its cleared token. Never throws:
 * the caller is already answering the failed send.
 */
async function restorePreviousVerificationLink(
  previous: { id: string; emailVerificationToken: string | null; emailVerificationTokenExpiresAt: Date | null },
  replacedBy: string,
): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { id: previous.id, emailVerificationToken: replacedBy },
      data: {
        emailVerificationToken: previous.emailVerificationToken,
        emailVerificationTokenExpiresAt: previous.emailVerificationTokenExpiresAt,
      },
    });
  } catch (err) {
    console.error('[Auth] Failed to restore the previous verification link after a failed send:', describeCaughtError(err));
  }
}

/**
 * Record acceptance of the Terms of Service and the Privacy Policy for an
 * EXISTING account — the path for accounts that predate consent-at-signup
 * (CNIL/GDPR). Both must be accepted in one go, as separate explicit `true`s;
 * a partial acceptance records nothing, so the gate stays up. Idempotent: an
 * already-consented account keeps its ORIGINAL timestamps, which are the
 * accountability record of when consent was first given.
 */
export async function acceptConsent(userId: string, consent: RegistrationConsent): Promise<{ consentRequired: false }> {
  if (consent.acceptTerms !== true) throw new BadRequestError('You must accept the Terms of Service');
  if (consent.acceptPrivacy !== true) throw new BadRequestError('You must accept the Privacy Policy');
  const now = new Date();
  // updateMany with a null guard keeps the first acceptance: two concurrent
  // POSTs cannot move an existing timestamp forward.
  await prisma.user.updateMany({ where: { id: userId, termsAcceptedAt: null }, data: { termsAcceptedAt: now } });
  await prisma.user.updateMany({ where: { id: userId, privacyAcceptedAt: null }, data: { privacyAcceptedAt: now } });
  return { consentRequired: false };
}

/**
 * Self-service account deletion (GDPR right to erasure; the Terms promise
 * "you may delete your account at any time").
 *
 * Re-authenticates with the password — a stolen session must not be enough
 * to erase someone — and, when TOTP is enabled, with a current code (or a
 * backup code) as well, since the password alone is exactly what 2FA exists
 * to distrust. Refuses while the account owns servers: `Server.owner` is
 * onDelete: Restrict, and whether a community is handed to someone else or
 * destroyed is the owner's call to make first (transfer or delete each in
 * its settings). The refusal lists them so the client can say which.
 */
export async function deleteOwnAccount(
  userId: string,
  password: string,
  totpCode?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password: true, totpEnabled: true, ownedServers: { select: { id: true, name: true } } },
  });
  if (!user) throw new UnauthorizedError('User not found');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new BadRequestError('Password is incorrect');

  if (user.totpEnabled) {
    if (!totpCode || typeof totpCode !== 'string') throw new BadRequestError('Two-factor authentication code is required');
    const ok = await verifyTOTP(userId, totpCode.replace(/\s+/g, ''));
    if (!ok) throw new BadRequestError('Invalid two-factor authentication code');
  }

  if (user.ownedServers.length > 0) {
    throw new OwnedServersError(user.ownedServers);
  }

  await deleteUserAccount(userId, { reason: 'Your account has been deleted', logPrefix: '[Auth]' });
}

/** 409 carrying the servers the account must transfer or delete first (utils/errors.ts). */
export { OwnedServersError };
