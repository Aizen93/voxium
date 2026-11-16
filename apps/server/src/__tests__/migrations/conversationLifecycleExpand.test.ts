import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261116120000_conversation_lifecycle_expand is the expand step for
 * conversations that outlive one side (#131) and removal for one side (#47):
 * both conversation sides lose NOT NULL, and each person's read row gains
 * `hidden_at` and `cleared_at`. It changes no row. It was applied with
 * `prisma migrate deploy` to an empty PostgreSQL 16 database (every migration
 * from scratch) and on top of one migrated to the migration before it; on
 * both, `prisma migrate diff` from the database to schema.prisma was empty,
 * as it was before the change (the SQL-only indexes are invisible to it),
 * both foreign keys still read ON DELETE CASCADE, two (NULL, B) rows were
 * stored side by side, and a second sorted pair (A, B) was refused by the
 * unique index. On a database without the two read-row columns, the
 * client generated from this schema answered the mark-read upsert with
 * P2022, which is why the migration goes first. The online procedure of its
 * comment was run as written while a transaction held conversation_reads:
 * step 1 committed, step 2 timed out changing nothing while a read of
 * conversations went through at once, the repeated procedure and
 * `migrate resolve` left `migrate status` up to date and `migrate deploy`
 * with nothing pending; the same two statements through ONE `db execute`
 * held conversations while they waited and the timeout undid both, and
 * `migrate deploy` released conversations before its second statement
 * waited. What this pins is the shape that made it safe, the procedure and
 * the order it states, and the schema it must agree with.
 */

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const NAME = '20261116120000_conversation_lifecycle_expand';
const sql = readFileSync(resolve(MIGRATIONS, NAME, 'migration.sql'), 'utf8');
const commentText = sql
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith('--'))
  .join('\n');
const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);
const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

/** One model's block of the schema, its `//` comments removed. */
function model(name: string): string {
  const block = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${name} not found`);
  return block[1].split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

describe('the conversation lifecycle expand migration', () => {
  it('sorts after the last migration shipped before it', () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(NAME);
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261111150000_reports_one_pending_per_target'));
  });

  it('is two statements, one per table: the sides lose NOT NULL, the read row gains two nullable columns', () => {
    expect(statements).toEqual([
      'ALTER TABLE "conversations" ALTER COLUMN "user1_id" DROP NOT NULL, ALTER COLUMN "user2_id" DROP NOT NULL',
      'ALTER TABLE "conversation_reads" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "cleared_at" TIMESTAMP(3)',
    ]);
  });

  it('changes no row, builds no index, and leaves every constraint as it is', () => {
    const code = statements.join('\n');
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i);
    expect(code).not.toMatch(/\bINDEX\b/i);
    expect(code).not.toMatch(/\bCONSTRAINT\b/i);
    expect(code).not.toMatch(/\bDEFAULT\b/i);
    expect(code).not.toMatch(/NOT DISTINCT/i);
    // the timeout belongs to the online procedure, never to `migrate deploy`
    expect(code).not.toMatch(/lock_timeout/i);
  });

  it('says why the unique pair is kept: NULLs are distinct, never NULLS NOT DISTINCT', () => {
    expect(commentText).toMatch(/NULLs as DISTINCT/);
    expect(commentText).toMatch(/Never rebuild it NULLS NOT DISTINCT/);
    expect(commentText).toMatch(/No backfill, no new index/);
  });

  describe('the online procedure in the comment', () => {
    // the comment as running text, its `--` prefixes gone
    const prose = commentText.replace(/^--\s?/gm, '').replace(/\s+/g, ' ');
    const notes = prose.slice(prose.indexOf('NOTE:'), prose.indexOf('DEPLOYMENT ORDER'));

    it('runs the two statements one at a time, each in an execution of its own after its own timeout', () => {
      expect(notes).toMatch(/apply the two statements one at a time instead, each in an execution of its own after its own short lock timeout/);
      expect(notes.match(/SET lock_timeout = '2s';/g)).toHaveLength(2);
      expect(notes).toMatch(/run it again until it succeeds/);
    });

    it('forbids both in one execution, and says why: db execute runs a whole file as ONE transaction', () => {
      expect(notes).toMatch(/Never both in one execution: `prisma db execute --file` runs a whole file as ONE transaction/);
      expect(notes).toMatch(/the first table's lock would be held while the second statement waits, and a timeout there would undo both/);
    });

    it('quotes, step by step, exactly the statements the migration runs', () => {
      const quoted = [...notes.matchAll(/ALTER TABLE [^;]+;/g)].map((m) => m[0].replace(/;$/, '').trim());
      expect(quoted).toEqual(statements);
      expect(notes.indexOf('1.')).toBeLessThan(notes.indexOf('ALTER TABLE "conversations"'));
      expect(notes.indexOf('2.')).toBeLessThan(notes.indexOf('ALTER TABLE "conversation_reads"'));
    });

    it('ends with migrate resolve, and finishes a partial run by repeating the procedure, never by migrate deploy', () => {
      expect(notes).toContain(`3. \`prisma migrate resolve --applied ${NAME}\``);
      expect(notes).toMatch(/A step that times out changes nothing/);
      expect(notes).toMatch(/finished by repeating the procedure from step 1/);
      expect(notes).toMatch(/never by `prisma migrate deploy`, which takes the locks with no timeout/);
      expect(notes).toMatch(/P3009/);
    });

    it('states what migrate deploy itself does with the locks (each statement commits on its own)', () => {
      expect(prose).toMatch(/ACCESS EXCLUSIVE/);
      expect(prose).toMatch(/Under `prisma migrate deploy` the two statements commit one after the other, so the first table's lock is gone while the second waits/);
    });
  });

  it('states the deployment order: the migration before its own code, and before every later change of the series', () => {
    const order = commentText.replace(/\n--\s*/g, ' ');
    expect(order).toMatch(/DEPLOYMENT ORDER\. This migration first, then the code shipped with it/);
    // why: the regenerated client names the new columns in every whole-row read
    expect(order).toMatch(/names hidden_at and cleared_at whenever it reads or returns a whole conversation_reads row/);
    expect(order).toMatch(/P2022/);
    expect(order).toMatch(/Code older than this migration runs on the schema after it/);
    expect(order).toMatch(/before any of them ships/);
    expect(order).toMatch(/no node may run code older than this migration's/);
  });
});

describe('the schema the migration must agree with', () => {
  it('makes both sides nullable and keeps both relations ON DELETE CASCADE', () => {
    const conversation = model('Conversation');
    expect(conversation).toMatch(/user1Id\s+String\?\s+@map\("user1_id"\)/);
    expect(conversation).toMatch(/user2Id\s+String\?\s+@map\("user2_id"\)/);
    expect(conversation).toMatch(/user1\s+User\?\s+@relation\("ConversationUser1", fields: \[user1Id\], references: \[id\], onDelete: Cascade\)/);
    expect(conversation).toMatch(/user2\s+User\?\s+@relation\("ConversationUser2", fields: \[user2Id\], references: \[id\], onDelete: Cascade\)/);
  });

  it('keeps the unique pair and the second-side index exactly as they were', () => {
    const conversation = model('Conversation');
    expect(conversation).toMatch(/@@unique\(\[user1Id, user2Id\]\)\n/);
    expect(conversation).toMatch(/@@index\(\[user2Id\]\)/);
    expect(schema).not.toMatch(/nullsNotDistinct|NULLS NOT DISTINCT\)/);
  });

  it('adds the two nullable read-row columns, mapped to the migration\'s names', () => {
    const read = model('ConversationRead');
    expect(read).toMatch(/hiddenAt\s+DateTime\?\s+@map\("hidden_at"\)/);
    expect(read).toMatch(/clearedAt\s+DateTime\?\s+@map\("cleared_at"\)/);
    expect(read).toMatch(/lastReadAt\s+DateTime\s+@map\("last_read_at"\)/);
  });

  it('warns, beside the unique pair, that NULLs are distinct and must stay so', () => {
    expect(schema).toMatch(/PostgreSQL treats NULLs as DISTINCT/);
    expect(schema).toMatch(/never NULLS NOT DISTINCT/);
  });
});
