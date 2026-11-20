import { Router, type Request, type Response, type NextFunction } from 'express';
import { logAuditEvent } from '../utils/auditLog';
import { loginUser, verifyLoginTOTP, requestPasswordReset, resetPassword, changePassword, verifyEmail, resendVerificationEmail, acceptConsent, withConsentFlag, CONSENT_SELECT, deleteOwnAccount, OwnedServersError, revokeOneSession, revokeOtherSessions } from '../services/authService';
import { setupTOTP, enableTOTP, disableTOTP } from '../services/totpService';
import { startRegistration, completeRegistration, resendRegistrationCode } from '../services/signupService';
import { refreshSession, endSessionWithRefreshToken, deriveSessionLabel, readClientHint, listSessions, type SessionLabel } from '../services/sessionService';
import { PasswordStepUpError } from '../utils/errors';
import { authenticate } from '../middleware/auth';
import { rateLimitRegister, rateLimitRegisterAttempt, rateLimitRegisterAttemptSubnet, rateLimitRegisterComplete, rateLimitRegisterResend, chargeRegistrationBudgets, rateLimitPowChallenge, getSubnetRegistrationPressure, rateLimitLogin, rateLimitLoginSubnet, rateLimitLoginAccount, rateLimitTotpAccount, rateLimitForgotPassword, rateLimitResetPassword, rateLimitRefresh, rateLimitLogout, rateLimitChangePassword, rateLimitSessionsRead, rateLimitSessionRevoke, STEP_UP_REFUSED_LOCAL, rateLimitTOTP, rateLimitVerifyEmail, rateLimitMailBlock, rateLimitResendVerification, rateLimitConsent, rateLimitDeleteAccount, normalizeIp } from '../middleware/rateLimiter';
import { issueRegistrationChallenge, verifyRegistrationPow } from '../utils/registrationPow';
import { readMailBlockToken, isDigestSuppressed, suppressDigest, unsuppressDigest } from '../utils/mailSuppression';
import { prisma } from '../utils/prisma';
import { isFeatureEnabled } from '../utils/featureFlags';
import { revokeUserSessions } from '../utils/sessionRevocation';
import { sanitizeLabel } from '../utils/sanitize';
import { validateDisplayName, REMEMBER_ME_INVALID_MESSAGE, TRUSTED_DEVICE_TOKEN_INVALID_MESSAGE } from '@voxium/shared';
import type {
  ChangePasswordRequest, LoginRequest, LogoutRequest, RefreshRequest, RegisterCompleteRequest, RevokeOtherSessionsRequest,
  RevokeSessionRequest, SessionClientField, TotpVerifyRequest,
} from '@voxium/shared';

export const authRouter = Router();

/**
 * A body as it arrives: the field names of the shared request type (so a
 * route reads only what the contract names), every value still unchecked.
 * Each route checks the values it reads; the types never stand in for that.
 */
type Unchecked<T> = { [K in keyof T]?: unknown };

/**
 * The label of a session this request opens: the body's `client` hint, else
 * the request's Origin; the system from its User-Agent. Neither header is
 * kept or logged (sessionService.deriveSessionLabel).
 */
function sessionLabelOf(req: Request): SessionLabel {
  const hint = (req.body as Unchecked<SessionClientField> | undefined)?.client;
  return deriveSessionLabel({ hint, origin: req.get('origin'), userAgent: req.get('user-agent') });
}

/** "Remember me" as every sign-in read it: absent means yes, otherwise its truthiness. */
function rememberMeOf(value: unknown): boolean {
  return Boolean(value ?? true);
}

/** A refresh token is a JWT of a few hundred characters; anything far longer is not one. */
const REFRESH_TOKEN_MAX_CHARS = 4096;

// Proof-of-work challenge for registration (anti-bot Phase 3). Stateless:
// the challenge is HMAC-signed, so nothing is stored until redemption.
// Difficulty adapts to how many registrations the caller's subnet already
// made today — pressure raises the price instead of slamming the door.
authRouter.get('/register-challenge', rateLimitPowChallenge, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('registration')) {
      res.status(403).json({ success: false, error: 'Registration is currently disabled' });
      return;
    }
    const ip = normalizeIp(req.ip || req.socket.remoteAddress || 'unknown');
    const pressure = await getSubnetRegistrationPressure(req);
    res.json({ success: true, data: issueRegistrationChallenge(ip, pressure) });
  } catch (err) {
    next(err);
  }
});

// Verify-first registration (services/signupService.ts). The start never
// creates an account and answers the same 202 for every address; the account
// is created by /register/complete when the mailed code comes back.
//
// `registerAttempt` (per address) and `registerAttemptSubnet` (per /24, per
// /48) are the never-refunded buckets that bound how many starts a source can
// make. The daily/subnet SUCCESS budgets are charged on /register/complete,
// where an account is actually created (consume atomically, refund on any
// non-2xx: see chargeRegistrationBudgets).
authRouter.post('/register', rateLimitRegister, rateLimitRegisterAttempt, rateLimitRegisterAttemptSubnet, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('registration')) {
      res.status(403).json({ success: false, error: 'Registration is currently disabled' });
      return;
    }
    const { username, email, password, displayName, pow, acceptTerms, acceptPrivacy } = req.body;
    if (!username || typeof username !== 'string') { res.status(400).json({ success: false, error: 'Username is required' }); return; }
    if (!email || typeof email !== 'string') { res.status(400).json({ success: false, error: 'Email is required' }); return; }
    if (!password || typeof password !== 'string') { res.status(400).json({ success: false, error: 'Password is required' }); return; }
    if (displayName !== undefined && typeof displayName !== 'string') { res.status(400).json({ success: false, error: 'Display name must be a string' }); return; }
    // The display name as it will be stored (sanitizeLabel: one line, no bidi
    // or zero-width characters), judged with the other cheap checks: refused
    // after the proof of work, it would burn the challenge. An empty one is
    // not refused: the account then takes its username as display name.
    if (typeof displayName === 'string') {
      const storedName = sanitizeLabel(displayName);
      const displayNameErr = storedName ? validateDisplayName(storedName) : null;
      if (displayNameErr) { res.status(400).json({ success: false, error: displayNameErr }); return; }
    }
    // Consent (CNIL/GDPR): both documents, each as its own explicit `true` —
    // a truthy string or a missing field is not acceptance. Checked with the
    // other cheap validations, BEFORE the proof-of-work is verified: a verify
    // burns the challenge, and the client only refetches one on expiry.
    if (acceptTerms !== true) { res.status(400).json({ success: false, error: 'You must accept the Terms of Service' }); return; }
    if (acceptPrivacy !== true) { res.status(400).json({ success: false, error: 'You must accept the Privacy Policy' }); return; }

    // Enforced HERE, server-side, so a script POSTing the API directly pays
    // the same hash work as a browser — cadence and IP rotation don't help.
    await verifyRegistrationPow(normalizeIp(req.ip || req.socket.remoteAddress || 'unknown'), pow);

    const result = await startRegistration(username, email, password, displayName, req.ip || req.socket.remoteAddress, { acceptTerms, acceptPrivacy });
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// The mailed code comes back: create the account and sign the user in (the
// same answer the old one-step registration gave). Per-pending attempts are
// capped in the database; this limiter bounds a source across many ids.
authRouter.post('/register/complete', rateLimitRegisterComplete, chargeRegistrationBudgets, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('registration')) {
      res.status(403).json({ success: false, error: 'Registration is currently disabled' });
      return;
    }
    const { pendingId, code, username } = req.body as Unchecked<RegisterCompleteRequest>;
    const result = await completeRegistration(pendingId, code, username, req.ip || req.socket.remoteAddress, sessionLabelOf(req));
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// A second code for the same pending registration (once, after a delay, within
// the mailbox ledger). Always the same 202.
authRouter.post('/register/resend', rateLimitRegisterResend, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('registration')) {
      res.status(403).json({ success: false, error: 'Registration is currently disabled' });
      return;
    }
    const { pendingId } = req.body;
    const result = await resendRegistrationCode(typeof pendingId === 'string' ? pendingId : '');
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Per address, per network, then per account and network (all count failures only, middleware/rateLimiter.ts)
authRouter.post('/login', rateLimitLogin, rateLimitLoginSubnet, rateLimitLoginAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, rememberMe, trustedDeviceToken } = req.body as Unchecked<LoginRequest>;
    if (!email || typeof email !== 'string') { res.status(400).json({ success: false, error: 'Email is required' }); return; }
    if (!password || typeof password !== 'string') { res.status(400).json({ success: false, error: 'Password is required' }); return; }
    // The trusted-device token is verified by the service: anything that
    // is not one is refused like a bad one
    const result = await loginUser(email, password, rememberMeOf(rememberMe), req.ip || req.socket.remoteAddress, trustedDeviceToken as string | undefined, sessionLabelOf(req));

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// Renew a session (services/sessionService.ts: the token's own session is
// rotated, a token issued before sessions is upgraded into one). Every
// refusal is the one 401 'Invalid refresh token'; a failure of the server
// is a 500, which the client answers by keeping its tokens. The body's
// `client` field labels nothing: it is only written into the reuse log line.
authRouter.post('/refresh', rateLimitRefresh, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken, client } = (req.body ?? {}) as Unchecked<RefreshRequest>;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ success: false, error: 'Refresh token is required' });
      return;
    }
    const tokens = await refreshSession(refreshToken, {
      // The connection closed (the client gave up waiting): nothing is
      // rotated behind it, so its next attempt with the same token works
      isClientGone: () => req.socket.destroyed,
      hinted: readClientHint(client) !== null,
      label: sessionLabelOf(req),
    });
    // Gone before anything was written: there is nobody to answer
    if (tokens === null) return;

    res.json({
      success: true,
      data: tokens,
    });
  } catch (err) {
    next(err);
  }
});

// Sign-out on the server: ends the session the refresh token names, whatever
// its generation (the token a client holds when it signs out may already
// have been replaced by a renewal whose answer it dropped). Outside
// `authenticate`: the access token may have expired. Every request whose body
// holds a token-shaped string gets the same empty 204, whether that token was
// valid, forged, expired or for a session already gone; a 500 means the
// session was not ended.
authRouter.post('/logout', rateLimitLogout, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = (req.body as Unchecked<LogoutRequest> | undefined)?.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0 || refreshToken.length > REFRESH_TOKEN_MAX_CHARS) {
      res.status(400).json({ success: false, error: 'Refresh token is required' });
      return;
    }
    await endSessionWithRefreshToken(refreshToken);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── The account's own sign-in sessions ─────────────────────────────────────
// The list, signing out of one other session and of every other one
// (services/sessionService.ts, services/authService.ts). Authenticated, and
// under /auth like the other self-management routes: an account that has
// not verified its e-mail or given its consent can still end its sessions.
// `authenticate` before the limiters: they are keyed by user and session.
// The two sign-outs take the account password, checked before anything
// that depends on a session id; their bucket keeps the charge of a wrong
// password only.

authRouter.get('/sessions', authenticate, rateLimitSessionsRead, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await listSessions(req.user!.userId, req.user!.sid);
    res.json({ success: true, data: { sessions } });
  } catch (err) {
    next(err);
  }
});

/** The step-up password of a body, or null after the 400 was sent. */
function stepUpPassword(req: Request, res: Response): string | null {
  // Both sign-outs' bodies carry it (RevokeSessionRequest,
  // RevokeOtherSessionsRequest)
  const password = (req.body as Unchecked<RevokeSessionRequest> | undefined)?.password;
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ success: false, error: 'Password is required' });
    return null;
  }
  return password;
}

/**
 * A refused step-up keeps its charge on the bucket (rateLimitSessionRevoke);
 * every other outcome is given back.
 */
function noteStepUp(res: Response, err: unknown): void {
  if (err instanceof PasswordStepUpError) res.locals[STEP_UP_REFUSED_LOCAL] = true;
}

/** A trusted-device token is a JWT of a few hundred characters. */
const TRUSTED_DEVICE_TOKEN_MAX_CHARS = 4096;

authRouter.post('/sessions/revoke-others', authenticate, rateLimitSessionRevoke, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const password = stepUpPassword(req, res);
    if (password === null) return;
    const { trustedDeviceToken, rememberMe } = req.body as Unchecked<RevokeOtherSessionsRequest>;
    if (trustedDeviceToken !== undefined && trustedDeviceToken !== null
      && (typeof trustedDeviceToken !== 'string' || trustedDeviceToken.length > TRUSTED_DEVICE_TOKEN_MAX_CHARS)) {
      res.status(400).json({ success: false, error: TRUSTED_DEVICE_TOKEN_INVALID_MESSAGE });
      return;
    }
    if (rememberMe !== undefined && typeof rememberMe !== 'boolean') {
      res.status(400).json({ success: false, error: REMEMBER_ME_INVALID_MESSAGE });
      return;
    }
    const result = await revokeOtherSessions({
      userId: req.user!.userId,
      sid: req.user!.sid,
      admittedVersion: req.user!.tokenVersion,
      password,
      trustedDeviceToken: typeof trustedDeviceToken === 'string' ? trustedDeviceToken : undefined,
      rememberMe: rememberMe ?? true,
      label: sessionLabelOf(req),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    noteStepUp(res, err);
    next(err);
  }
});

authRouter.delete('/sessions/:sessionId', authenticate, rateLimitSessionRevoke, async (req: Request<{ sessionId: string }>, res: Response, next: NextFunction) => {
  try {
    const password = stepUpPassword(req, res);
    if (password === null) return;
    await revokeOneSession(req.user!.userId, req.user!.sid, req.params.sessionId, password);
    res.json({ success: true, data: { revoked: 1 } });
  } catch (err) {
    noteStepUp(res, err);
    next(err);
  }
});

// Accept the Terms of Service and the Privacy Policy from an EXISTING account
// (accounts created before consent was collected at signup — CNIL/GDPR).
// Authenticated only, deliberately NOT behind requireConsent: this is the
// route that clears that gate. Both flags must be the literal boolean true.
// authenticate BEFORE the limiter: it is keyed by userId, and with no user
// yet it falls back to the IP — one bucket for everyone behind a NAT.
authRouter.post('/consent', authenticate, rateLimitConsent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { acceptTerms, acceptPrivacy } = req.body;
    const result = await acceptConsent(req.user!.userId, { acceptTerms, acceptPrivacy });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Self-service account deletion (GDPR right to erasure). Authenticated only —
// deliberately NOT behind requireVerifiedEmail or requireConsent: an account
// that never verified its email, or declines the legal documents, must still
// be able to leave. Re-authenticates with the password (+ TOTP when enabled)
// so a stolen session cannot erase someone. 409 with the list when the
// account still owns servers — transfer or delete those first.
// authenticate BEFORE the limiter, for the same reason as /consent — and here
// the bucket BLOCKS for 15 minutes, so a shared-IP bucket would let one
// person's typos lock a whole office out of deleting their accounts.
authRouter.delete('/account', authenticate, rateLimitDeleteAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password, totpCode } = req.body ?? {};
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required' });
      return;
    }
    try {
      await deleteOwnAccount(req.user!.userId, password, typeof totpCode === 'string' ? totpCode : undefined);
    } catch (err) {
      if (err instanceof OwnedServersError) {
        res.status(409).json({ success: false, error: err.message, data: { ownedServers: err.servers } });
        return;
      }
      throw err;
    }
    logAuditEvent({
      actorId: null,
      action: 'user.delete',
      targetType: 'user',
      targetId: req.user!.userId,
      metadata: { trigger: 'self' },
    });
    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
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
        createdAt: true,
        ...CONSENT_SELECT,
      },
    });

    res.json({ success: true, data: user ? withConsentFlag(user) : user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/forgot-password', rateLimitForgotPassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      res.status(400).json({ success: false, error: 'Email is required' });
      return;
    }
    await requestPasswordReset(email);
    res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', rateLimitResetPassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Reset token is required' });
      return;
    }
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required' });
      return;
    }
    const { userId } = await resetPassword(token.toLowerCase(), password);
    // The reset bumps the token version: end the account's sockets
    revokeUserSessions(userId);
    res.json({ success: true, message: 'Password has been reset successfully.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', authenticate, rateLimitChangePassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword, rememberMe } = req.body as Unchecked<ChangePasswordRequest>;
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ success: false, error: 'Current password is required' });
      return;
    }
    if (!newPassword || typeof newPassword !== 'string') {
      res.status(400).json({ success: false, error: 'New password is required' });
      return;
    }
    // The version the caller was admitted with: a reset or a ban that
    // commits while the password is hashed refuses this change
    const tokens = await changePassword(
      req.user!.userId, req.user!.sid, req.user!.tokenVersion,
      currentPassword, newPassword, rememberMeOf(rememberMe), sessionLabelOf(req),
    );
    // Every socket opened with the old tokens goes, the caller's included:
    // its client reopens with the fresh pair this response carries (the
    // caller's session was re-keyed in the same transaction)
    revokeUserSessions(req.user!.userId);
    res.json({ success: true, message: 'Password changed successfully.', data: tokens });
  } catch (err) {
    next(err);
  }
});

// ─── Email Verification ─────────────────────────────────────────────────────

authRouter.post('/verify-email', rateLimitVerifyEmail, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Verification token is required' });
      return;
    }
    // Tokens are 32 random bytes hex-encoded = 64 chars. Reject malformed tokens early.
    const normalizedToken = token.toLowerCase();
    if (normalizedToken.length !== 64 || !/^[0-9a-f]+$/.test(normalizedToken)) {
      res.status(400).json({ success: false, error: 'Invalid or expired verification link' });
      return;
    }
    await verifyEmail(normalizedToken);
    res.json({ success: true, message: 'Email verified successfully.' });
  } catch (err) {
    next(err);
  }
});

// "Not you? Block Voxium mail to this address" — the link every account e-mail
// carries (utils/mailSuppression.ts). Three calls, all on the token from that
// link and nothing else: no session, no address in the request. The token
// names a mailbox DIGEST, so the page never learns the address either, and a
// bad token answers one sentence whatever is wrong with it.
const MAIL_BLOCK_INVALID = 'Invalid or expired mail-block link';
const MAIL_BLOCK_TOKEN_MAX_CHARS = 1024;

/** The mailbox digest the request's token names, or null after a 400 was sent. */
function mailBlockDigest(req: Request, res: Response): string | null {
  const token: unknown = req.body?.token;
  const digest = typeof token === 'string' && token.length > 0 && token.length <= MAIL_BLOCK_TOKEN_MAX_CHARS
    ? readMailBlockToken(token)
    : null;
  if (!digest) res.status(400).json({ success: false, error: MAIL_BLOCK_INVALID });
  return digest;
}

authRouter.post('/mail-block/status', rateLimitMailBlock, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const digest = mailBlockDigest(req, res);
    if (!digest) return;
    res.json({ success: true, data: { blocked: await isDigestSuppressed(digest) } });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/mail-block', rateLimitMailBlock, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const digest = mailBlockDigest(req, res);
    if (!digest) return;
    await suppressDigest(digest);
    res.json({ success: true, data: { blocked: true } });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/mail-unblock', rateLimitMailBlock, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const digest = mailBlockDigest(req, res);
    if (!digest) return;
    await unsuppressDigest(digest);
    res.json({ success: true, data: { blocked: false } });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/resend-verification', authenticate, rateLimitResendVerification, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resendVerificationEmail(req.user!.userId);
    res.json({ success: true, message: 'Verification email sent.' });
  } catch (err) {
    next(err);
  }
});

// ─── TOTP (Two-Factor Authentication) ──────────────────────────────────────

// The per-address and per-network sign-in buckets, then the per-account one keyed on the verified challenge token's user
authRouter.post('/totp/verify', rateLimitLogin, rateLimitLoginSubnet, rateLimitTotpAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { totpToken, code } = req.body as Unchecked<TotpVerifyRequest>;
    if (!totpToken || typeof totpToken !== 'string') {
      res.status(400).json({ success: false, error: 'TOTP token is required' });
      return;
    }
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'Verification code is required' });
      return;
    }
    const result = await verifyLoginTOTP(totpToken, code, sessionLabelOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/totp/setup', authenticate, rateLimitTOTP, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setupTOTP(req.user!.userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/totp/enable', authenticate, rateLimitTOTP, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'Verification code is required' });
      return;
    }
    const result = await enableTOTP(req.user!.userId, code);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/totp/disable', authenticate, rateLimitTOTP, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'Verification code is required' });
      return;
    }
    await disableTOTP(req.user!.userId, code);
    res.json({ success: true, message: 'Two-factor authentication has been disabled.' });
  } catch (err) {
    next(err);
  }
});
