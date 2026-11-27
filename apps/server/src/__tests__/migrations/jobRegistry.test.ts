import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261127120000_job_registry creates the scheduled jobs' settings and the
 * record of their runs. Its statements are what `prisma migrate diff` from
 * the schema before it to schema.prisma writes, put in the shape of
 * 20261121120000_sessions (one DO block, each step checking for what
 * exists, the key to `users` under a lock_timeout of its own transaction).
 * What this pins: it creates exactly that, and drops, alters or writes
 * nothing else.
 */

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const NAME = '20261127120000_job_registry';
const sql = readFileSync(resolve(MIGRATIONS, NAME, 'migration.sql'), 'utf8');
const lines = sql.split(/\r?\n/);
const commentText = lines.filter((l) => l.trim().startsWith('--')).join('\n');
const code = lines.filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

function model(name: string): string {
  const block = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${name} not found`);
  return block[1].split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

describe('the job registry migration', () => {
  it('sorts after the last migration shipped before it', () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(NAME);
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261123120000_reports_outlive_deleted_accounts'));
  });

  it('is ONE statement (a DO block): applied whole or not at all', () => {
    expect(code).toMatch(/^DO \$\$ .* END \$\$;$/);
    expect(code.match(/\$\$/g)).toHaveLength(2);
  });

  it('creates exactly the two tables, the index and the key of schema.prisma', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "job_settings" ( "job" TEXT NOT NULL, "mode" TEXT NOT NULL, "set_at" TIMESTAMP(3) NOT NULL, "set_by_id" TEXT, CONSTRAINT "job_settings_pkey" PRIMARY KEY ("job") );');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "job_runs" ( "id" SERIAL NOT NULL, "job" TEXT NOT NULL, "started_at" TIMESTAMP(3) NOT NULL, "finished_at" TIMESTAMP(3) NOT NULL, "node_id" TEXT NOT NULL, "mode" TEXT NOT NULL, "outcome" TEXT NOT NULL, "skip_reason" TEXT, "summary" JSONB, "error" TEXT, CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id") );');
    expect(code).toContain('CREATE INDEX IF NOT EXISTS "job_runs_job_id_idx" ON "job_runs"("job", "id");');
    expect(code).toContain('ALTER TABLE "job_settings" ADD CONSTRAINT "job_settings_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;');
  });

  it('drops, alters and writes nothing else: no existing table is touched', () => {
    expect(code.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(1);
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(code.match(/ALTER TABLE "([a-z_]+)"/g)).toEqual(['ALTER TABLE "job_settings"']);
    const withoutKeyActions = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, '');
    expect(withoutKeyActions).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|RENAME)\b/i);
    expect(withoutKeyActions).not.toMatch(/\bALTER (COLUMN|TYPE|INDEX|SEQUENCE)\b/i);
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX [^;]*ON "(?!job_runs")/);
  });

  it('adds the key to `users` under a lock_timeout of ITS OWN transaction, tried again a bounded number of times', () => {
    const timeout = code.indexOf(`PERFORM set_config('lock_timeout', '2s', true);`);
    const usersKey = code.indexOf('ALTER TABLE "job_settings" ADD CONSTRAINT "job_settings_set_by_id_fkey"');
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(usersKey);
    expect(code).not.toMatch(/\bSET (SESSION |LOCAL )?lock_timeout\b/i);
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    expect(code).toMatch(/LOOP EXIT WHEN EXISTS \( SELECT 1 FROM pg_constraint WHERE conrelid = 'job_settings'::regclass AND conname = 'job_settings_set_by_id_fkey' \); BEGIN ALTER TABLE "job_settings" ADD CONSTRAINT "job_settings_set_by_id_fkey"/);
    expect(code).toContain('EXCEPTION WHEN lock_not_available THEN attempt := attempt + 1; IF attempt >= 20 THEN RAISE EXCEPTION');
    expect(code).toContain("USING ERRCODE = 'lock_not_available'");
    expect(code).toContain('PERFORM pg_sleep(1);');
  });

  it('says it is additive, what it locks, what to do when it gives up, and what an older or a newer server does', () => {
    expect(commentText).toMatch(/ADDITIVE/);
    expect(commentText).toMatch(/SHARE ROW EXCLUSIVE lock\s+-- on `users`/);
    expect(commentText).toContain('npx prisma migrate resolve --rolled-back 20261127120000_job_registry');
    expect(commentText).toMatch(/P3009/);
    expect(commentText).toMatch(/DEPLOYMENT ORDER\. This migration first, then the server/);
    expect(commentText).toMatch(/A\s+-- server OLDER than this migration runs on the schema after it unaffected/);
    expect(commentText).toMatch(/A server NEWER than it, started on a database\s+-- without it, keeps every job running/);
    expect(commentText).toMatch(/nothing is recorded/);
  });

  it('agrees with schema.prisma: the two models, the key\'s action, the index, an id in insertion order', () => {
    const setting = model('JobSetting');
    expect(setting).toMatch(/@@map\("job_settings"\)/);
    expect(setting).toMatch(/\bjob\s+String\s+@id\b/);
    expect(setting).toMatch(/\bmode\s+String\b/);
    expect(setting).toMatch(/\bsetAt\s+DateTime\s+@map\("set_at"\)/);
    expect(setting).toMatch(/\bsetById\s+String\?\s+@map\("set_by_id"\)/);
    expect(setting).toMatch(/setBy User\? @relation\("JobSettingSetBy", fields: \[setById\], references: \[id\], onDelete: SetNull\)/);

    const run = model('JobRun');
    expect(run).toMatch(/@@map\("job_runs"\)/);
    expect(run).toMatch(/\bid\s+Int\s+@id @default\(autoincrement\(\)\)/);
    expect(run).toMatch(/@@index\(\[job, id\]\)/);
    for (const [field, column, type] of [
      ['startedAt', 'started_at', 'DateTime'], ['finishedAt', 'finished_at', 'DateTime'], ['nodeId', 'node_id', 'String'],
      ['skipReason', 'skip_reason', 'String\\?'],
    ] as const) {
      expect(run, field).toMatch(new RegExp(`\\b${field}\\s+${type}\\s+@map\\("${column}"\\)`));
    }
    expect(run).toMatch(/\bsummary\s+Json\?/);
    expect(run).toMatch(/\berror\s+String\?/);
    expect(model('User')).toMatch(/\bjobSettingsSet\s+JobSetting\[\]\s+@relation\("JobSettingSetBy"\)/);
  });
});
