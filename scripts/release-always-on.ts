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
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
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
/**
 * What the database looked like immediately before the cutover.
 *
 * `verify` cannot otherwise tell "the migration deleted exactly the DM rows" from
 * "something deleted far more than that": both leave zero DM messages behind.
 * The only difference is what SURVIVED, and that is only knowable against a
 * number recorded beforehand.
 */
const BASELINE_FILE = 'cutover-baseline.json';

interface Baseline {
  channelMessages: number;
  dmMessages: number;
  conversations: number;
}

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
     Writes ${KEYS_FILE} and ${BASELINE_FILE}. AFTER the migration both are
     unobtainable: the rows naming the S3 objects are gone, so the cleanup job
     can never see them either, and the pre-cutover counts \`verify\` checks
     against cannot be reconstructed. This is the only chance to record them.
  3. Take a database snapshot. It is the only rollback that exists.
  4. Authorise, then migrate:
       psql> CREATE TABLE "e2e_cutover_authorised"();
       cd apps/server && VOXIUM_ALLOW_CUTOVER=1 npx prisma migrate deploy
     The migration refuses to destroy anything without that table (because
     \`migrate deploy\` also runs on every container start, where nobody
     intended a cutover) and drops it on success, so one authorisation buys
     exactly one run.
     NOT \`prisma db execute\` — that does not wrap the file in a transaction,
     so a killed statement leaves history deleted with encrypted_at still
     nullable and the key tables intact. NOT raw psql either — it applies the
     SQL without recording it, leaving the cutover pending forever.
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

  // Recorded in the same step because this is the last moment it can be: after
  // the migration, the pre-cutover numbers are unknowable.
  const before = await counts();
  const baseline: Baseline = {
    channelMessages: before.channelMessages,
    dmMessages: before.dmMessages,
    conversations: before.conversations,
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(
    `Wrote ${BASELINE_FILE}: ${baseline.channelMessages} channel message(s), ` +
      `${baseline.dmMessages} DM message(s), ${baseline.conversations} conversation(s)`
  );
}

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Baseline).channelMessages !== 'number' ||
      typeof (parsed as Baseline).conversations !== 'number'
    ) {
      console.warn(`${BASELINE_FILE} is present but not the shape this script writes — ignoring it.`);
      return null;
    }
    return parsed as Baseline;
  } catch (err) {
    console.warn(`Could not read ${BASELINE_FILE}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function verify() {
  const state = await counts();
  const baseline = readBaseline();
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
    // The one check that is about what SURVIVED. It was hardcoded `true`, which
    // made it a line of reassurance rather than a test: a DELETE that lost its
    // WHERE clause takes channel history with it and still printed PASS here.
    [
      'channel history preserved',
      baseline === null ? false : state.channelMessages >= baseline.channelMessages,
      baseline === null
        ? `no ${BASELINE_FILE} — run capture-attachments BEFORE the migration; ` +
          `cannot prove the ${state.channelMessages} channel message(s) now present are all of them`
        : `${state.channelMessages} now, ${baseline.channelMessages} before the cutover`,
    ],
    [
      'conversations kept',
      baseline === null ? false : state.conversations >= baseline.conversations,
      baseline === null
        ? `no ${BASELINE_FILE} to compare against`
        : `${state.conversations} now, ${baseline.conversations} before the cutover`,
    ],
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
  // A hostname is not a location. `ssh -L 5433:db:5432` — the ordinary way to
  // reach production from a laptop, and exactly how someone would run precheck
  // or verify against prod — turns the production database into
  // `postgresql://…@localhost:5433/voxium`, which sailed straight through the
  // old substring test. What follows deletes the cutover's `_prisma_migrations`
  // row, which re-arms a one-way destructive migration to fire on the next
  // deploy, so the guard has to be something no tunnel can satisfy: the
  // operator naming the database they mean, matched against the one actually
  // connected to.
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing: NODE_ENV=production.');
    process.exit(1);
  }
  const rows = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
  const actual = rows[0]?.db ?? '';
  const declared = process.env.REHEARSE_DATABASE;
  if (!declared || declared !== actual) {
    console.error('Refusing: rehearse rewrites schema, deletes the cutover migration record,');
    console.error('and edits real rows. Name the database you mean:');
    console.error(`\n  REHEARSE_DATABASE=${actual} npx tsx scripts/release-always-on.ts rehearse\n`);
    console.error(`Connected to: ${actual}`);
    if (declared) console.error(`You said:     ${declared}`);
    console.error('Never run this against production — it re-arms the cutover migration.');
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
