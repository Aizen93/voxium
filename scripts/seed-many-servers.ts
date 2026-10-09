#!/usr/bin/env tsx
/**
 * Dev-only: put one account into a lot of servers so the spaces rail can be
 * looked at under the load that broke the old one. Joining is not capped (the
 * 5-server limit is on creating), so this mirrors a real power user.
 *
 *   npx tsx scripts/seed-many-servers.ts <username> [count]
 */
import { PrismaClient } from '../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), 'apps/server/.env') });
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL not set');
if (!/localhost|127\.0\.0\.1/.test(connectionString) && process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed against production');
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const NAMES = [
  'Voxium Community','Design Guild','Rust Nerds','Gaming Lounge','Music Room','Startup Chat',
  'Open Source','Photography','Book Club','Fitness','Cooking','Travel','AI Research','Web Dev',
  'Homelab','Cinema','Board Games','Language Exchange','Mechanical Keyboards','Woodworking',
  'Astronomy','Cycling','Jazz','Data Viz','Security','Retro Computing','Tabletop RPG','Gardening',
];

async function main() {
  const username = process.argv[2];
  const count = Number(process.argv[3] || 24);
  if (!username) throw new Error('usage: seed-many-servers.ts <username> [count]');

  const user = await prisma.user.findFirst({ where: { username }, select: { id: true } });
  if (!user) throw new Error(`no user ${username}`);

  for (let i = 0; i < count; i++) {
    const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ' ' + Math.floor(i / NAMES.length) : ''}`;
    const server = await prisma.server.create({ data: { name, ownerId: user.id } });
    await prisma.serverMember.create({ data: { serverId: server.id, userId: user.id } });
  }
  const total = await prisma.serverMember.count({ where: { userId: user.id } });
  console.log(`${username} is now in ${total} servers`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
