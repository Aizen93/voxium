#!/usr/bin/env tsx
/**
 * Always-on E2E cutover: the ordered, one-shot release procedure.
 *
 *   npx tsx scripts/release-always-on.ts precheck
 *   npx tsx scripts/release-always-on.ts capture-attachments
 *   npx tsx scripts/release-always-on.ts verify
 *   npx tsx scripts/release-always-on.ts rehearse      (LOCAL ONLY)
 *
 * The migration itself is run by `prisma migrate deploy`, not by this script —
 * that is the only tool that wraps each migration in a transaction. This script
 * does the things around it that are easy to forget and impossible to redo:
 * capturing the attachment keys before the rows that name them are deleted, and
 * proving afterwards that the database is in the state the release assumes.
 *
 * The cutover deletes DM history and truncates every E2E key table. There is no
 * down migration. Read `docs/e2e-always-on-plan.md` §7 before running anything.
 */
import { PrismaClient } from '../apps/server/src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), 'apps/server/.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set (expected in apps/server/.env)');
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const KEYS_FILE = 'dm-attachment-keys.txt';

/** Is the cutover migration already recorded as applied? */
async function cutoverApplied(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM _prisma_migrations
     WHERE migration_name = '20260801140000_e2e_always_on' AND finished_at IS NOT NULL
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function encryptedAtIsNullable(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ is_nullable: string }>>`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'conversations' AND column_name = 'encrypted_at'
  `;
  return rows[0]?.is_nullable === 'YES';
}

async function counts() {
  const [dm, channel, convs, plain, reads] = await Promise.all([
    prisma.message.count({ where: { conversationId: { not: null } } }),
    prisma.message.count({ where: { channelId: { not: null } } }),
    prisma.conversation.count(),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM conversations WHERE encrypted_at IS NULL`,
    prisma.conversationRead.count(),
  ]);
  return {
    dmMessages: dm,
    channelMessages: channel,
    conversations: convs,
    unencryptedConversations: Number(plain[0]?.count ?? 0),
    conversationReads: reads,
  };
}

async function precheck() {
  const applied = await cutoverApplied();
  const before = await counts();
  console.log('Cutover migration applied:', applied);
  console.log('Current state:', before);
  if (applied) {
    console.log('\nAlready cut over. `verify` is the command you want.');
    return;
  }
  console.log(`
Ordered steps — do not reorder, and do not skip 2:

  1. Put the API in maintenance mode.
  2. npx tsx scripts/release-always-on.ts capture-attachments
     Writes ${KEYS_FILE}. AFTER the migration these keys are unreachable: the
     rows that name them are gone, so the cleanup job can never see the S3
     objects either. This is the only chance to record them.
  3. Take a database snapshot. It is the only rollback that exists.
  4. cd apps/server && npx prisma migrate deploy
     NOT \`prisma db execute\` — that does not wrap the file in a transaction,
     so a killed statement leaves history deleted with encrypted_at still
     nullable and the key tables intact.
  5. Deploy the server build, then the client build.
  6. npx tsx scripts/release-always-on.ts verify
  7. Lift maintenance.
  8. VACUUM (ANALYZE) messages;   -- cannot run inside the migration
  9. Sweep the S3 objects listed in ${KEYS_FILE}.
`);
}

async function captureAttachments() {
  if (await cutoverApplied()) {
    console.error('Refusing: the cutover has already run, so these rows are gone.');
    console.error('If you did not capture the keys first, the objects must be swept by prefix.');
    process.exit(1);
  }
  const rows = await prisma.$queryRaw<Array<{ s3_key: string }>>`
    SELECT a.s3_key FROM message_attachments a
      JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id IS NOT NULL
  `;
  writeFileSync(KEYS_FILE, rows.map((r) => r.s3_key).join('\n') + (rows.length ? '\n' : ''));
  console.log(`Wrote ${rows.length} DM attachment key(s) to ${KEYS_FILE}`);
  if (rows.length === 0) {
    console.log('Nothing to sweep — but the file exists, so step 9 is still a no-op rather than a question.');
  }
}

async function verify() {
  const state = await counts();
  const nullable = await encryptedAtIsNullable();
  const e2e = await Promise.all([
    prisma.e2EDevice.count(),
    prisma.e2EMasterKey.count(),
    prisma.e2EKeyBackup.count(),
    prisma.e2EMessageKeyBackup.count(),
  ]);

  const checks: Array<[string, boolean, string]> = [
    ['cutover migration applied', await cutoverApplied(), 'run `prisma migrate deploy`'],
    ['no DM messages remain', state.dmMessages === 0, `${state.dmMessages} left`],
    ['channel history preserved', true, `${state.channelMessages} kept (informational)`],
    ['every conversation encrypted', state.unencryptedConversations === 0, `${state.unencryptedConversations} unencrypted`],
    ['encrypted_at is NOT NULL', !nullable, 'column still nullable'],
    ['read markers cleared', state.conversationReads === 0, `${state.conversationReads} left`],
    ['E2E key material cleared', e2e.every((c) => c === 0), `devices=${e2e[0]} master=${e2e[1]} backups=${e2e[2]} msgKeys=${e2e[3]}`],
  ];

  let ok = true;
  for (const [name, passed, detail] of checks) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : ` — ${detail}`}`);
    if (!passed) ok = false;
  }
  console.log(`\nConversations: ${state.conversations} (kept — nobody loses a contact)`);
  if (!ok) process.exit(1);
}

/**
 * LOCAL ONLY. Puts this database back into a believable pre-cutover shape —
 * nullable column, plaintext DMs, attachments, E2E rows — so the real
 * procedure can be rehearsed against something that looks like production
 * instead of against a database that has already been migrated.
 */
async function rehearse() {
  if (!connectionString!.includes('localhost') && !connectionString!.includes('127.0.0.1')) {
    console.error('Refusing: rehearse only runs against a local database.');
    process.exit(1);
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE "conversations" ALTER COLUMN "encrypted_at" DROP NOT NULL`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "conversations" ALTER COLUMN "encrypted_at" DROP DEFAULT`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM _prisma_migrations WHERE migration_name = '20260801140000_e2e_always_on'`
  );

  const users = await prisma.user.findMany({ take: 2, select: { id: true } });
  if (users.length < 2) {
    console.error('Need at least two users — run `pnpm db:seed` first.');
    process.exit(1);
  }
  const [a, b] = users.map((u) => u.id).sort();
  const conversation = await prisma.conversation.upsert({
    where: { user1Id_user2Id: { user1Id: a, user2Id: b } },
    create: { user1Id: a, user2Id: b },
    update: {},
  });
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET encrypted_at = NULL WHERE id = $1`,
    conversation.id
  );

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, authorId: a, content: 'rehearsal plaintext DM', type: 'user' },
  });
  await prisma.messageAttachment.create({
    data: {
      messageId: message.id,
      s3Key: `attachments/dm-${conversation.id}/rehearsal.bin`,
      fileName: 'rehearsal.bin',
      fileSize: 12,
      mimeType: 'application/octet-stream',
    },
  });
  await prisma.conversationRead.upsert({
    where: { userId_conversationId: { userId: a, conversationId: conversation.id } },
    create: { userId: a, conversationId: conversation.id, lastReadAt: new Date() },
    update: {},
  });

  console.log('Rehearsal state ready:', await counts());
  console.log('encrypted_at nullable:', await encryptedAtIsNullable());
  console.log('\nNow run: precheck → capture-attachments → (cd apps/server && npx prisma migrate deploy) → verify');
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  precheck,
  'capture-attachments': captureAttachments,
  verify,
  rehearse,
};

const run = commands[command];
if (!run) {
  console.error(`Usage: release-always-on.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
run()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
