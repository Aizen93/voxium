import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import type { AuthPayload } from '../middleware/auth';
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/errors';
import { validateEmail, validatePassword, validateUsername } from '@voxium/shared';

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
      createdAt: true,
    },
  });

  const tokens = generateTokens({ userId: user.id, username: user.username });

  return { user, ...tokens };
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) throw new UnauthorizedError('Invalid credentials');

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) throw new UnauthorizedError('Invalid credentials');

  const tokens = generateTokens({ userId: user.id, username: user.username });

  const { password: _, ...safeUser } = user;

  return { user: safeUser, ...tokens };
}

export function generateTokens(payload: AuthPayload) {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  } as jwt.SignOptions);

  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  } as jwt.SignOptions);

  return { accessToken, refreshToken };
}

export async function refreshTokens(token: string) {
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as AuthPayload;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true },
    });

    if (!user) throw new UnauthorizedError('User not found');

    return generateTokens({ userId: user.id, username: user.username });
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }
}
