import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261123120000_reports_outlive_deleted_accounts is the expand step of a
 * report that outlives the account that filed it or that it concerns (#48):
 * both sides of `reports` lose NOT NULL, the table gains the reported
 * username and the two deletion marks, and the username is backfilled from
 * the reported account. Both foreign keys keep ON DELETE CASCADE, nothing is
 * deleted and no index changes. The SQL was written by hand and agrees with
 * what `prisma migrate diff` from the schema before it to schema.prisma
 * prints for the table (the same five column changes, no key change). It has
 * NOT been run against a database. What this pins is its shape: one block,
 * the waits bounded the way the sessions migration bounds them, the
 * statements and nothing else, the comment's procedure and deployment
 * order, and the schema it must agree with.
 */

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const NAME = '20261123120000_reports_outlive_deleted_accounts';
const sql = readFileSync(resolve(MIGRATIONS, NAME, 'migration.sql'), 'utf8');
const lines = sql.split(/\r?\n/);
const commentText = lines.filter((l) => l.trim().startsWith('--')).join('\n');
// the comment as running text, its `--` prefixes gone
const prose = commentText.replace(/^--\s?/gm, '').replace(/\s+/g, ' ');
const code = lines.filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

/** One model's block of the schema, its `//` comments removed. */
function model(name: string): string {
  const block = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${name} not found`);
  return block[1].split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

describe('the migration that lets a report outlive a deleted account', () => {
  it('sorts after the last migration shipped before it', () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(NAME);
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261121120000_sessions'));
  });

  it('is ONE statement (a DO block): applied whole or not at all, whatever the runner commits between statements', () => {
    expect(code).toMatch(/^DO \$\$ .* END \$\$;$/);
    expect(code.match(/\$\$/g)).toHaveLength(2);
  });

  it('drops NOT NULL from both sides and adds the three nullable columns, in one ALTER, safe to repeat', () => {
    expect(code).toContain(
      'ALTER TABLE "reports" ALTER COLUMN "reporter_id" DROP NOT NULL, ALTER COLUMN "reported_user_id" DROP NOT NULL, '
      + 'ADD COLUMN IF NOT EXISTS "reported_username" TEXT, ADD COLUMN IF NOT EXISTS "reporter_deleted_at" TIMESTAMP(3), '
      + 'ADD COLUMN IF NOT EXISTS "reported_user_deleted_at" TIMESTAMP(3);',
    );
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it('backfills the username from the reported account, only into rows that have none', () => {
    expect(code).toContain(
      'UPDATE "reports" r SET "reported_username" = u."username" FROM "users" u WHERE u."id" = r."reported_user_id" AND r."reported_username" IS NULL;',
    );
    expect(code.match(/\bUPDATE\b/g)).toHaveLength(1);
  });

  it('deletes nothing, keeps every key and index as it is, and gives no column a default', () => {
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|DROP TABLE|DROP COLUMN|DROP INDEX|INSERT)\b/i);
    expect(code).not.toMatch(/\bINDEX\b/i);
    expect(code).not.toMatch(/\bCONSTRAINT\b|FOREIGN KEY|REFERENCES|SET NULL/i);
    expect(code).not.toMatch(/\bDEFAULT\b/i);
    expect(code).not.toMatch(/ALTER TABLE "users"/);
  });

  it('runs under a lock_timeout of ITS OWN transaction, each attempt rolled back to its start, paused, bounded', () => {
    const timeout = code.indexOf(`PERFORM set_config('lock_timeout', '2s', true);`);
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(code.indexOf('ALTER TABLE "reports"'));
    // transaction-local (the third argument), never a SET that would outlive the block on the connection
    expect(code).not.toMatch(/\bSET (SESSION |LOCAL )?lock_timeout\b/i);
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    // the ALTER and the backfill both inside the attempt: a backfill that
    // times out on `users` is retried with the ALTER, never half applied
    expect(code).toMatch(/LOOP BEGIN ALTER TABLE "reports" .* UPDATE "reports" r .* EXIT; EXCEPTION WHEN lock_not_available THEN attempt := attempt \+ 1; IF attempt >= 20 THEN RAISE EXCEPTION/);
    expect(code).toContain("USING ERRCODE = 'lock_not_available'");
    expect(code).toContain('PERFORM pg_sleep(1);');
  });

  it('says what it locks and for how long, that it deletes nothing, what to do when it gives up, and the deployment order', () => {
    expect(prose).toMatch(/ACCESS EXCLUSIVE lock on `reports`/);
    expect(prose).toMatch(/every message delete anywhere/);
    // a reader holds it off too, not only a writer
    expect(prose).toMatch(/behind every long read of the table \(a dump, a long export of the reports\): ACCESS EXCLUSIVE conflicts with the ACCESS SHARE lock a plain read takes/);
    expect(prose).toMatch(/a dump or another long read of `reports`/);
    expect(prose).toMatch(/no statement waits behind this migration for more than one timeout/);
    expect(prose).toMatch(/It deletes nothing\./);
    expect(prose).toMatch(/both foreign keys to `users` keep ON DELETE CASCADE/);
    expect(prose).toMatch(/reports_pending_\* .* stay as they are/);
    expect(prose).toContain(`npx prisma migrate resolve --rolled-back ${NAME}`);
    expect(prose).toContain(`prisma migrate resolve --applied ${NAME}`);
    expect(prose).toMatch(/P3009/);
    expect(prose).toMatch(/DEPLOYMENT ORDER\. This migration first, then the server shipped with it/);
    expect(prose).toMatch(/P2022/);
    expect(prose).toMatch(/A server older than this migration runs on the schema after it: it names none of the new columns/);
    expect(prose).toMatch(/no node may run code older than this migration's/);
  });
});

describe('the schema the migration must agree with', () => {
  it('makes both sides nullable and keeps both relations ON DELETE CASCADE', () => {
    const report = model('Report');
    expect(report).toMatch(/reporterId\s+String\?\s+@map\("reporter_id"\)/);
    expect(report).toMatch(/reportedUserId\s+String\?\s+@map\("reported_user_id"\)/);
    expect(report).toMatch(/reporter\s+User\?\s+@relation\("ReportReporter", fields: \[reporterId\], references: \[id\], onDelete: Cascade\)/);
    expect(report).toMatch(/reportedUser\s+User\?\s+@relation\("ReportReported", fields: \[reportedUserId\], references: \[id\], onDelete: Cascade\)/);
  });

  it('adds the three nullable columns, mapped to the migration\'s names, without a default', () => {
    const report = model('Report');
    for (const [field, column, type] of [
      ['reportedUsername', 'reported_username', 'String'],
      ['reporterDeletedAt', 'reporter_deleted_at', 'DateTime'],
      ['reportedUserDeletedAt', 'reported_user_deleted_at', 'DateTime'],
    ] as const) {
      const line = new RegExp(`\\b${field}\\s+${type}\\?[^\\n]*`).exec(report)?.[0] ?? '';
      expect(line, field).toContain(`@map("${column}")`);
      expect(line, field).not.toMatch(/@default|@updatedAt/);
    }
  });

  it('keeps the indexes it had, and the note on the three SQL-only pending-report indexes', () => {
    const report = model('Report');
    expect(report.match(/@@index\(/g)).toHaveLength(5);
    for (const index of ['status', 'createdAt', 'reporterId', 'reportedUserId', 'messageId']) {
      expect(report).toContain(`@@index([${index}])`);
    }
    expect(schema).toMatch(/offer to DROP them as drift, do not let it/);
  });
});
