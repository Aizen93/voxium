import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding database...');

  // Create demo users
  const password = await bcrypt.hash('password123', 12);

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password,
      emailVerified: true,
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password,
      emailVerified: true,
    },
  });

  const charlie = await prisma.user.upsert({
    where: { email: 'charlie@example.com' },
    update: {},
    create: {
      username: 'charlie',
      email: 'charlie@example.com',
      displayName: 'Charlie',
      emailVerified: true,
      password,
    },
  });

  // Create a demo server
  const server = await prisma.server.create({
    data: {
      name: 'Voxium Community',
      ownerId: alice.id,
      members: {
        createMany: {
          data: [
            { userId: alice.id, role: 'owner' },
            { userId: bob.id, role: 'admin' },
            { userId: charlie.id, role: 'member' },
          ],
        },
      },
    },
  });

  // Create categories
  const textCategory = await prisma.category.create({
    data: { name: 'Text Channels', serverId: server.id, position: 0 },
  });
  const voiceCategory = await prisma.category.create({
    data: { name: 'Voice Channels', serverId: server.id, position: 1 },
  });

  // Create channels linked to categories
  await prisma.channel.createMany({
    data: [
      { name: 'general', type: 'text', serverId: server.id, categoryId: textCategory.id, position: 0 },
      { name: 'random', type: 'text', serverId: server.id, categoryId: textCategory.id, position: 1 },
      { name: 'introductions', type: 'text', serverId: server.id, categoryId: textCategory.id, position: 2 },
      { name: 'General', type: 'voice', serverId: server.id, categoryId: voiceCategory.id, position: 3 },
      { name: 'Gaming', type: 'voice', serverId: server.id, categoryId: voiceCategory.id, position: 4 },
    ],
  });

  // Add some demo messages
  const channels = await prisma.channel.findMany({
    where: { serverId: server.id, type: 'text' },
    orderBy: { position: 'asc' },
  });

  if (channels[0]) {
    await prisma.message.createMany({
      data: [
        { content: 'Welcome to Voxium! 🎉', channelId: channels[0].id, authorId: alice.id },
        { content: 'This is the beginning of #general.', channelId: channels[0].id, authorId: alice.id },
        { content: 'Hey everyone! Glad to be here.', channelId: channels[0].id, authorId: bob.id },
        { content: 'This platform looks amazing!', channelId: channels[0].id, authorId: charlie.id },
      ],
    });
  }

  console.log('Seed completed!');
  console.log(`  Users: alice, bob, charlie (password: password123)`);
  console.log(`  Server: ${server.name}`);
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
