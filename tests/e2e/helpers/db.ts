import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load DATABASE_URL from server .env if not already set
if (!process.env.DATABASE_URL) {
  const envPath = resolve(__dirname, '../../../apps/server/.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m);
  if (match) process.env.DATABASE_URL = match[1];
}

let prisma: PrismaClient | null = null;

function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
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

/** Disconnect Prisma (call in afterAll or global teardown). */
export async function disconnectDb() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
