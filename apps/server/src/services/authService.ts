import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import geoip from 'geoip-lite';
import { prisma } from '../utils/prisma';
import type { AuthPayload } from '../middleware/auth';
import type { UserRole } from '@voxium/shared';
import { BadRequestError, ConflictError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../utils/errors';
import { validateEmail, validatePassword, validateUsername, canonicalizeEmail, isDisposableEmailDomain, emailDomain, isCommonEmailProvider } from '@voxium/shared';
import { sendPasswordResetEmail, sendVerificationEmail, describeEmailError } from '../utils/email';
import { sanitizeText } from '../utils/sanitize';
import { getRedis } from '../utils/redis';
import { getDomainRegistrationCount, countDomainRegistration, domainRegistrationCap } from '../middleware/rateLimiter';

// Timing-equalization hash for login attempts against unknown emails (same
// convention as requestPasswordReset): skipping bcrypt when the user doesn't
// exist makes the response measurably faster, enumerating registered emails.
// Generated EAGERLY at module load with the same cost factor as real password
// hashes — lazy init would make the first unknown-email login pay hash+compare
// (2× a real login's cost), itself a one-request timing signal.
let timingEqualizerHash: string | null = null;
const timingEqualizerReady = bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12)
  .then((hash) => { timingEqualizerHash = hash; })
  .catch((err) => console.warn('[Auth] Timing-equalizer hash init failed (will retry lazily):', err));

async function getTimingEqualizerHash(): Promise<string> {
  if (!timingEqualizerHash) {
    await timingEqualizerReady;
    if (!timingEqualizerHash) {
      timingEqualizerHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12);
    }
  }
  return timingEqualizerHash;
}

export async function registerUser(username: string, email: string, password: string, displayName?: string, rawIp?: string) {
  email = email.toLowerCase().trim();

  // Same normalization login uses — ban matching and attribution must agree
  const ip = rawIp?.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;

  const usernameErr = validateUsername(username);
  if (usernameErr) throw new BadRequestError(usernameErr);

  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);

  const passwordErr = validatePassword(password);
  if (passwordErr) throw new BadRequestError(passwordErr);

  // A banned IP must not mint fresh accounts — registration was the one auth
  // surface IpBan did not cover (login checks it; sockets carry a JWT).
  // Same message as the login path: an attacker learns nothing new here.
  if (ip) {
    const ipBan = await prisma.ipBan.findUnique({ where: { ip } });
    if (ipBan) throw new ForbiddenError(ipBan.reason ? `Account banned: ${ipBan.reason}` : 'Your account has been banned');
  }

  // Disposable providers get the SAME generic conflict error as a duplicate:
  // a distinct "domain blocked" message would hand bots an oracle for probing
  // which domains pass.
  if (isDisposableEmailDomain(email)) {
    throw new ConflictError('Username or email already in use');
  }

  // Duplicate detection runs on the CANONICAL form: gmail ignores dots and
  // +tags, so without this one inbox mints unlimited "unique" addresses
  // (the dotted-gmail bot vector). The address of record stays as typed.
  const emailCanonical = canonicalizeEmail(email);

  // Username check is case-INSENSITIVE: lookups elsewhere (friend requests,
  // member search) match insensitively, so allowing "Alice" alongside "alice"
  // at signup would route the other account's requests to an impersonator.
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { username: { equals: username, mode: 'insensitive' } },
        { email },
        { emailCanonical },
      ],
    },
  });

  if (existing) {
    throw new ConflictError('Username or email already in use');
  }

  // NOVEL-DOMAIN daily cap: a $10 catch-all domain gives an attacker
  // unlimited verifiable inboxes, which defeats both the disposable blocklist
  // and the unverified-account TTL. Big consumer providers are exempt (gmail
  // legitimately signs up unbounded users/day). Checked BEFORE create and
  // counted only AFTER a successful create — a middleware-style blind consume
  // would let an attacker burn a small company's domain budget with garbage
  // attempts and lock its real employees out for the day.
  const domain = emailDomain(email);
  const domainCapped = !isCommonEmailProvider(domain);
  if (domainCapped && (await getDomainRegistrationCount(domain)) >= domainRegistrationCap()) {
    throw new TooManyRequestsError('Too many registrations from this email domain today — try again later');
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  // Generate email verification token
  const rawVerifyToken = crypto.randomBytes(32).toString('hex');
  const hashedVerifyToken = crypto.createHash('sha256').update(rawVerifyToken).digest('hex');

  const user = await prisma.user.create({
    data: {
      username,
      email,
      emailCanonical,
      displayName: sanitizeText(displayName) || username,
      password: hashedPassword,
      emailVerificationToken: hashedVerifyToken,
      emailVerificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    },
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
    },
  });

  // Count the successful create against the domain budget (see the check
  // above for why this is post-create, not a blind pre-consume)
  if (domainCapped) await countDomainRegistration(domain);

  // The REGISTRATION IP is the forensic anchor for abuse attribution — the
  // one sighting that was previously never recorded. kind is set at create
  // and never overwritten by later logins from the same address.
  if (ip) {
    const geo = geoip.lookup(ip);
    const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const geoFields = geo ? {
      countryCode: geo.country || null,
      country: (geo.country && countryNames.of(geo.country)) || geo.country || null,
    } : {};
    await prisma.ipRecord.create({
      data: { userId: user.id, ip, kind: 'register', ...geoFields },
    }).catch((err) => console.warn('[Auth] Registration IP record failed:', err));
  }

  // Send verification email (fire-and-forget)
  sendVerificationEmail(user.email, rawVerifyToken).catch((err) => {
    console.error('[Auth] Failed to send verification email:', describeEmailError(err));
  });

  const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion });
  const { tokenVersion: _, ...safeUser } = user;

  return { user: safeUser, ...tokens };
}

export async function loginUser(email: string, password: string, rememberMe = true, rawIp?: string, trustedDeviceToken?: string) {
  email = email.toLowerCase().trim();

  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4) for consistent ban matching
  const ip = rawIp?.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;

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
    }).catch((err) => console.warn('[Auth] IP record upsert failed:', err));
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
        { userId: user.id, purpose: 'totp-verify', rememberMe },
        process.env.JWT_SECRET!,
        { expiresIn: '5m' } as jwt.SignOptions,
      );
      return { totpRequired: true, totpToken };
    }
  }

  const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion }, rememberMe);

  const { password: _, tokenVersion: _tv, bannedAt: _ba, banReason: _br, ...safeUser } = user;

  return { user: safeUser, ...tokens };
}

export async function verifyLoginTOTP(totpToken: string, code: string) {
  let payload: { userId: string; purpose: string; rememberMe: boolean };
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
    },
  });
  if (!user) throw new UnauthorizedError('User not found');

  const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion }, payload.rememberMe);
  const { tokenVersion: _tv, ...safeUser } = user;

  // Issue a trusted device token (30 days) — includes tokenVersion so password changes invalidate it
  const trustedDeviceToken = jwt.sign(
    { userId: user.id, purpose: 'trusted-device', tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' } as jwt.SignOptions,
  );

  return { user: safeUser, ...tokens, trustedDeviceToken };
}

export function generateTokens(payload: AuthPayload, rememberMe = true) {
  // Strip rememberMe from access token — it's only relevant for refresh
  const { rememberMe: _, ...accessPayload } = payload;
  const accessToken = jwt.sign(accessPayload, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  } as jwt.SignOptions);

  const refreshExpiry = rememberMe
    ? (process.env.JWT_REFRESH_EXPIRES_IN || '30d')
    : '24h';
  const refreshToken = jwt.sign({ ...accessPayload, rememberMe }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: refreshExpiry,
  } as jwt.SignOptions);

  return { accessToken, refreshToken };
}

export async function refreshTokens(token: string) {
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!, { algorithms: ['HS256'] }) as AuthPayload;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, role: true, tokenVersion: true, bannedAt: true },
    });

    if (!user) throw new UnauthorizedError('User not found');

    // Block banned users from refreshing tokens
    if (user.bannedAt) throw new ForbiddenError('Your account has been banned');

    // Tokens issued before the tokenVersion migration have no tokenVersion field;
    // treat undefined/missing as version 0 so pre-existing refresh tokens remain valid.
    const payloadVersion = payload.tokenVersion ?? 0;
    if (user.tokenVersion !== payloadVersion) {
      throw new UnauthorizedError('Token has been revoked');
    }

    const rememberMe = payload.rememberMe ?? true;
    return generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion }, rememberMe);
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid refresh token');
  }
}

export async function requestPasswordReset(email: string) {
  email = email.toLowerCase().trim();

  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);

  const user = await prisma.user.findUnique({ where: { email } });

  // Always do the expensive crypto work regardless of whether the user exists.
  // This prevents timing side-channel attacks that could enumerate email addresses
  // by measuring response time differences (crypto work vs early return).
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  if (!user) return; // Silent return - attacker sees same timing as a real reset

  // Per-INBOX daily cap, mirroring the verification-mail cap: the 3/15min IP
  // limiter is useless against distributed sources, and without this a botnet
  // can drip password-reset mail at a victim's real address indefinitely.
  // On cap: SILENT skip, never an error — this endpoint's response must stay
  // identical for existing and unknown emails (enumeration safety), so the
  // only honest option is to stop sending while answering the same way.
  try {
    const inboxKey = `resetmail:${canonicalizeEmail(user.email)}`;
    const sends = await getRedis().incr(inboxKey);
    if (sends === 1) await getRedis().expire(inboxKey, 24 * 60 * 60);
    if (sends > 5) {
      console.warn('[Auth] Password-reset mail cap reached for an inbox — skipping send');
      return;
    }
  } catch (err) {
    console.warn('[Auth] Reset-mail cap check failed (allowing send):', err);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken: hashedToken,
      resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    },
  });

  try {
    await sendPasswordResetEmail(user.email, rawToken);
  } catch (err) {
    console.error('[Auth] Failed to send password reset email:', describeEmailError(err));
  }
}

export async function resetPassword(token: string, newPassword: string) {
  if (!token) throw new BadRequestError('Reset token is required');

  const passwordErr = validatePassword(newPassword);
  if (passwordErr) throw new BadRequestError(passwordErr);

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findUnique({
    where: { resetToken: hashedToken },
  });

  if (!user) throw new BadRequestError('Invalid or expired reset token');

  if (user.resetTokenExpiresAt && user.resetTokenExpiresAt < new Date()) {
    // Token exists but has expired -- clear it and reject
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: null, resetTokenExpiresAt: null },
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
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, rememberMe = true) {
  const passwordErr = validatePassword(newPassword);
  if (passwordErr) throw new BadRequestError(passwordErr);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('User not found');

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) throw new BadRequestError('Current password is incorrect');

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      tokenVersion: { increment: 1 },
    },
    select: { id: true, username: true, role: true, tokenVersion: true },
  });

  // Return fresh tokens so the current session survives the version bump
  return generateTokens({ userId: updated.id, username: updated.username, role: updated.role as UserRole, tokenVersion: updated.tokenVersion }, rememberMe);
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
  });
}

export async function resendVerificationEmail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) throw new UnauthorizedError('User not found');
  if (user.emailVerified) throw new BadRequestError('Email already verified');

  // Hard daily cap PER INBOX, keyed on the canonical form: the per-user
  // limiter (3/5min) bounds the burst rate, but a bot that owns the account
  // can keep bursting forever — turning us into a drip harasser of whoever
  // really owns the address. 5 mails to one mailbox per day is the ceiling
  // no matter which account, IP, or cadence asks. Fail open on Redis errors:
  // a broken counter must not lock legitimate users out of verification.
  let sends = 0;
  try {
    const inboxKey = `verifymail:${canonicalizeEmail(user.email)}`;
    sends = await getRedis().incr(inboxKey);
    if (sends === 1) await getRedis().expire(inboxKey, 24 * 60 * 60);
  } catch (err) {
    console.warn('[Auth] Verification-mail cap check failed (allowing send):', err);
  }
  if (sends > 5) throw new BadRequestError('Too many verification emails requested — try again tomorrow');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: hashedToken,
      emailVerificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await sendVerificationEmail(user.email, rawToken);
}
