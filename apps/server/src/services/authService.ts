import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import geoip from 'geoip-lite';
import { prisma } from '../utils/prisma';
import type { AuthPayload } from '../middleware/auth';
import type { UserRole } from '@voxium/shared';
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from '../utils/errors';
import { validateEmail, validatePassword, validateUsername } from '@voxium/shared';
import { sendPasswordResetEmail } from '../utils/email';

export async function registerUser(username: string, email: string, password: string, displayName?: string) {
  const usernameErr = validateUsername(username);
  if (usernameErr) throw new BadRequestError(usernameErr);

  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);

  const passwordErr = validatePassword(password);
  if (passwordErr) throw new BadRequestError(passwordErr);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
  });

  if (existing) {
    if (existing.username === username) throw new ConflictError('Username already taken');
    throw new ConflictError('Email already registered');
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      username,
      email,
      displayName: displayName || username,
      password: hashedPassword,
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
      tokenVersion: true,
      createdAt: true,
    },
  });

  const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion });
  const { tokenVersion: _, ...safeUser } = user;

  return { user: safeUser, ...tokens };
}

export async function loginUser(email: string, password: string, rememberMe = true, rawIp?: string, trustedDeviceToken?: string) {
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
      tokenVersion: true,
      bannedAt: true,
      banReason: true,
      createdAt: true,
    },
  });

  if (!user) throw new UnauthorizedError('Invalid credentials');

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
    }).catch(() => {}); // Non-critical
  }

  // If TOTP is enabled, check for trusted device token
  if (user.totpEnabled) {
    let deviceTrusted = false;
    if (trustedDeviceToken) {
      try {
        const payload = jwt.verify(trustedDeviceToken, process.env.JWT_SECRET!) as { userId: string; purpose: string; tokenVersion?: number };
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
    payload = jwt.verify(totpToken, process.env.JWT_SECRET!) as typeof payload;
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

  const refreshExpiry = rememberMe ? '30d' : '24h';
  const refreshToken = jwt.sign({ ...accessPayload, rememberMe }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: refreshExpiry,
  } as jwt.SignOptions);

  return { accessToken, refreshToken };
}

export async function refreshTokens(token: string) {
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as AuthPayload;

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
  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // Silent return to prevent email enumeration

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

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
    console.error('[Auth] Failed to send password reset email:', err);
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
