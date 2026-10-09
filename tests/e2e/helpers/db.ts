import { PrismaClient } from '../../../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load DATABASE_URL from server .env if not already set
if (!process.env.DATABASE_URL) {
  const envPath = resolve(__dirname, '../../../apps/server/.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m);
    if (match) process.env.DATABASE_URL = match[1];
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set and apps/server/.env was not found. Set DATABASE_URL in your environment.');
  }
}

let prisma: PrismaClient | null = null;

function getPrisma() {
  if (!prisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

/** Promote a user to superadmin role by user ID. */
export async function promoteToSuperAdmin(userId: string) {
  const db = getPrisma();
  await db.user.update({
    where: { id: userId },
    data: { role: 'superadmin' },
  });
}

/** Create a report against a user. Returns the report ID. */
export async function createReport(reporterId: string, reportedUserId: string, reason: string) {
  const db = getPrisma();
  const report = await db.report.create({
    data: {
      type: 'user',
      reason,
      reporterId,
      reportedUserId,
    },
  });
  return report.id;
}

/** Create a support ticket for a user with an initial message. Returns the ticket ID. */
export async function createSupportTicket(userId: string, message: string) {
  const db = getPrisma();
  const ticket = await db.supportTicket.create({
    data: {
      userId,
      status: 'open',
      messages: {
        create: {
          authorId: userId,
          content: message,
          type: 'user',
        },
      },
    },
  });
  return ticket.id;
}

/** Verify a user's email directly in the database (for E2E tests). */
export async function verifyUserEmail(userId: string) {
  const db = getPrisma();
  await db.user.update({
    where: { id: userId },
    data: { emailVerified: true, emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
  });
}

/** Verify a user's email by email address (avoids JWT parsing in UI helpers). */
export async function verifyUserEmailByEmail(email: string) {
  const db = getPrisma();
  await db.user.update({
    where: { email: email.toLowerCase().trim() },
    data: { emailVerified: true, emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
  });
}

/** Create a verification token for a user and return the raw (unhashed) token for testing. */
export async function createVerificationToken(userId: string): Promise<string> {
  const crypto = await import('crypto');
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = getPrisma();
  await db.user.update({
    where: { id: userId },
    data: {
      emailVerificationToken: hashedToken,
      emailVerificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return rawToken;
}

/** Set a user's verification token to an expired timestamp (for testing expired tokens). */
export async function expireVerificationToken(userId: string): Promise<void> {
  const db = getPrisma();
  await db.user.update({
    where: { id: userId },
    data: { emailVerificationTokenExpiresAt: new Date(Date.now() - 1000) },
  });
}

/**
 * Everything the SERVER stores for a DM conversation between two users —
 * used by the E2E smoke test to prove only ciphertext ever reaches the DB.
 */
export async function getConversationServerState(userAId: string, userBId: string) {
  const db = getPrisma();
  const [user1Id, user2Id] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  return db.conversation.findUnique({
    where: { user1Id_user2Id: { user1Id, user2Id } },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { attachments: true },
      },
    },
  });
}

/** Registered E2E devices for a user, oldest first (multi-device assertions). */
export async function getE2EDevices(userId: string) {
  const db = getPrisma();
  return db.e2EDevice.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { deviceId: true, curve25519Key: true, ed25519Key: true, createdAt: true },
  });
}

/** Undelivered key shares addressed to a device (fanout assertions). */
export async function getE2EKeyShareCount(recipientUserId: string, recipientDeviceId?: string) {
  const db = getPrisma();
  return db.e2EKeyShare.count({
    where: { recipientUserId, ...(recipientDeviceId ? { recipientDeviceId } : {}) },
  });
}

/** Disconnect Prisma (call in afterAll or global teardown). */
/** Server-side view of a channel's messages — proves what was actually stored. */
export async function getChannelMessagesServerState(channelId: string) {
  const db = getPrisma();
  return db.message.findMany({
    where: { channelId },
    select: { id: true, content: true, encrypted: true, type: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Resolve a secure channel's id by server + name (the UI never exposes ids). */
export async function findSecureChannelId(serverId: string, name: string): Promise<string | null> {
  const db = getPrisma();
  const row = await db.channel.findFirst({
    where: { serverId, name, secure: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** A secure channel's row + membership as the server stores it. */
export async function getSecureChannelServerState(channelId: string) {
  const db = getPrisma();
  return db.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      secure: true,
      createdById: true,
      members: { select: { userId: true, isCreator: true } },
    },
  });
}

export async function disconnectDb() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
