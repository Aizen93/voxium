import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261111150000_reports_one_pending_per_target makes the database refuse a
 * second PENDING report by one reporter against one target: three partial
 * unique indexes, after closing (never deleting) the duplicates written
 * before them. Its behaviour was exercised against a private PostgreSQL
 * cluster: applied by `prisma migrate deploy` over seeded duplicates of every
 * kind, and inside a transaction that was rolled back, with a second run
 * changing nothing. Prisma cannot express a partial index, so `prisma migrate
 * dev` reads these as drift and offers to drop them. What this pins is the
 * shape that made it safe, the schema's warning, and the route's mapping of
 * their violation.
 */

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const NAME = '20261111150000_reports_one_pending_per_target';
const sql = readFileSync(resolve(MIGRATIONS, NAME, 'migration.sql'), 'utf8');
const code = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
const route = readFileSync(resolve(__dirname, '../../routes/reports.ts'), 'utf8');

describe('the reports migration', () => {
  it('sorts after the migration before it, so a deploy applies it after the ones already shipped', () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(NAME);
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261111130000_channel_members_follow_server_membership'));
  });

  it('is ONE statement, a DO block, so the lock lasts until the indexes exist on any connection', () => {
    const statements = code.split(/\$\$;/).map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^DO \$\$\s*BEGIN/);
  });

  it('locks the table against writes FIRST, then closes the duplicates, then builds the indexes', () => {
    const lock = code.indexOf('LOCK TABLE "reports" IN SHARE ROW EXCLUSIVE MODE;');
    const dedupe = code.indexOf('UPDATE "reports" r');
    const firstIndex = code.indexOf('CREATE UNIQUE INDEX');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(dedupe);
    expect(dedupe).toBeLessThan(firstIndex);
  });

  it('builds one partial unique index per type, keyed on what the route\'s look matches, idempotently', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_user_key"\s+ON "reports" \("reporter_id", "reported_user_id"\)\s+WHERE "status" = 'pending' AND "type" = 'user';/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_message_key"\s+ON "reports" \("reporter_id", "message_id"\)\s+WHERE "status" = 'pending' AND "type" = 'message';/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "reports_pending_server_key"\s+ON "reports" \("reporter_id", "server_id"\)\s+WHERE "status" = 'pending' AND "type" = 'server';/);
    expect(code.match(/CREATE UNIQUE INDEX/g)).toHaveLength(3);
  });

  it('closes every later duplicate as dismissed, keeping the OLDEST pending one, and deletes nothing', () => {
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|ALTER)\b/i);
    expect(code).toMatch(/ORDER BY "created_at" ASC, "id" ASC/);
    expect(code).toMatch(/PARTITION BY "reporter_id", "type",/);
    expect(code).toMatch(/SET "status" = 'dismissed'/);
    expect(code).toMatch(/WHERE r\."id" = ranked\."id"\s+AND ranked\.rn > 1;/);
    // only pending rows are looked at, and a deleted message's report (NULL
    // message_id) is never anyone's duplicate
    expect(code).toMatch(/WHERE "status" = 'pending'/);
    expect(code).toMatch(/\("type" = 'message' AND "message_id" IS NOT NULL\)/);
    // no moderator decided: the resolver stays empty
    expect(code).not.toMatch(/resolved_by_id/);
  });

  it('names the indexes in schema.prisma, and warns never to let migrate dev drop them', () => {
    for (const name of ['reports_pending_user_key', 'reports_pending_message_key', 'reports_pending_server_key']) {
      expect(schema).toContain(name);
    }
    expect(schema).toContain(NAME);
    expect(schema).toMatch(/offer to DROP them as drift, do not let it/);
  });

  it('the route answers the violation (P2002) as its look does', () => {
    expect(route).toMatch(/code === 'P2002'\) throw new BadRequestError\(DUPLICATE_REPORT_MESSAGE\)/);
    expect(route).toContain("const DUPLICATE_REPORT_MESSAGE = 'You already have a pending report against this target';");
  });
});
