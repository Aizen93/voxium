import { Router, type Request, type Response, type NextFunction } from 'express';
import { registerUser, loginUser, verifyLoginTOTP, refreshTokens, requestPasswordReset, resetPassword, changePassword, verifyEmail, resendVerificationEmail, acceptConsent, withConsentFlag, CONSENT_SELECT } from '../services/authService';
import { setupTOTP, enableTOTP, disableTOTP } from '../services/totpService';
import { authenticate } from '../middleware/auth';
import { rateLimitRegister, rateLimitRegisterAttempt, rateLimitRegisterAttemptSubnet, chargeRegistrationBudgets, rateLimitPowChallenge, getSubnetRegistrationPressure, rateLimitLogin, rateLimitForgotPassword, rateLimitResetPassword, rateLimitRefresh, rateLimitChangePassword, rateLimitTOTP, rateLimitVerifyEmail, rateLimitResendVerification, rateLimitConsent, normalizeIp } from '../middleware/rateLimiter';
import { issueRegistrationChallenge, verifyRegistrationPow } from '../utils/registrationPow';
import { prisma } from '../utils/prisma';
import { isFeatureEnabled } from '../utils/featureFlags';

export const authRouter = Router();

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

// The daily/subnet buckets are charged ATOMICALLY here and refunded unless the
// request actually creates an account — a failed attempt must not spend a real
// user's or a whole /24's signup budget, but a read-then-charge-later split
// would let a concurrent burst walk straight through the cap.
// `registerAttempt` (per address) and `registerAttemptSubnet` (per /24, per
// /48) are the never-refunded buckets that bound enumeration. Both are needed:
// a 409 on a random username means the email exists, and an attacker who can
// rotate addresses inside one range pays the per-address cap 254 times over.
authRouter.post('/register', rateLimitRegister, rateLimitRegisterAttempt, rateLimitRegisterAttemptSubnet, chargeRegistrationBudgets, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isFeatureEnabled('registration')) {
      res.status(403).json({ success: false, error: 'Registration is currently disabled' });
      return;
    }
    const { username, email, password, displayName, pow, acceptTerms, acceptPrivacy } = req.body;
    if (!username || typeof username !== 'string') { res.status(400).json({ success: false, error: 'Username is required' }); return; }
    if (!email || typeof email !== 'string') { res.status(400).json({ success: false, error: 'Email is required' }); return; }
    if (!password || typeof password !== 'string') { res.status(400).json({ success: false, error: 'Password is required' }); return; }
    // Consent (CNIL/GDPR): both documents, each as its own explicit `true` —
    // a truthy string or a missing field is not acceptance. Checked with the
    // other cheap validations, BEFORE the proof-of-work is verified: a verify
    // burns the challenge, and the client only refetches one on expiry.
    if (acceptTerms !== true) { res.status(400).json({ success: false, error: 'You must accept the Terms of Service' }); return; }
    if (acceptPrivacy !== true) { res.status(400).json({ success: false, error: 'You must accept the Privacy Policy' }); return; }

    // Enforced HERE, server-side, so a script POSTing the API directly pays
    // the same hash work as a browser — cadence and IP rotation don't help.
    await verifyRegistrationPow(normalizeIp(req.ip || req.socket.remoteAddress || 'unknown'), pow);

    const result = await registerUser(username, email, password, displayName, req.ip || req.socket.remoteAddress, { acceptTerms, acceptPrivacy });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', rateLimitLogin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, rememberMe, trustedDeviceToken } = req.body;
    if (!email || typeof email !== 'string') { res.status(400).json({ success: false, error: 'Email is required' }); return; }
    if (!password || typeof password !== 'string') { res.status(400).json({ success: false, error: 'Password is required' }); return; }
    const result = await loginUser(email, password, rememberMe ?? true, req.ip || req.socket.remoteAddress, trustedDeviceToken);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', rateLimitRefresh, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ success: false, error: 'Refresh token is required' });
      return;
    }
    const tokens = await refreshTokens(refreshToken);

    res.json({
      success: true,
      data: tokens,
    });
  } catch (err) {
    next(err);
  }
});

// Accept the Terms of Service and the Privacy Policy from an EXISTING account
// (accounts created before consent was collected at signup — CNIL/GDPR).
// Authenticated only, deliberately NOT behind requireConsent: this is the
// route that clears that gate. Both flags must be the literal boolean true.
authRouter.post('/consent', rateLimitConsent, authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { acceptTerms, acceptPrivacy } = req.body;
    const result = await acceptConsent(req.user!.userId, { acceptTerms, acceptPrivacy });
    res.json({ success: true, data: result });
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
    await resetPassword(token.toLowerCase(), password);
    res.json({ success: true, message: 'Password has been reset successfully.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', authenticate, rateLimitChangePassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword, rememberMe } = req.body;
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ success: false, error: 'Current password is required' });
      return;
    }
    if (!newPassword || typeof newPassword !== 'string') {
      res.status(400).json({ success: false, error: 'New password is required' });
      return;
    }
    const tokens = await changePassword(req.user!.userId, currentPassword, newPassword, rememberMe ?? true);
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

authRouter.post('/resend-verification', authenticate, rateLimitResendVerification, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resendVerificationEmail(req.user!.userId);
    res.json({ success: true, message: 'Verification email sent.' });
  } catch (err) {
    next(err);
  }
});

// ─── TOTP (Two-Factor Authentication) ──────────────────────────────────────

authRouter.post('/totp/verify', rateLimitLogin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { totpToken, code } = req.body;
    if (!totpToken || typeof totpToken !== 'string') {
      res.status(400).json({ success: false, error: 'TOTP token is required' });
      return;
    }
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'Verification code is required' });
      return;
    }
    const result = await verifyLoginTOTP(totpToken, code);
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
