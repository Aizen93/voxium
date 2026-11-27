import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261121120000_sessions creates the sign-in sessions and the redemption
 * record of refresh tokens issued before them. It was applied with `prisma
 * migrate deploy` to an empty PostgreSQL 16 database (every migration from
 * scratch), after which `prisma migrate diff` from the database to
 * schema.prisma was empty. It was then applied while another transaction
 * held a write on `users`: held 8 s, the deploy waited it out and succeeded
 * (7.8 s), and a writer of `users` running every 100 ms meanwhile waited at
 * most 1.9 s for one write; held 75 s, the deploy gave up after 20 attempts
 * (60.9 s) with "users stayed locked …" (P3018), neither table existed
 * afterwards, the next deploy stopped on P3009, `migrate resolve
 * --rolled-back` then `migrate deploy` applied it, and the writer had waited
 * at most 2.4 s at a time. Run on one connection, the block left that
 * connection's lock_timeout at 0 as it found it, and running it a second
 * time changed nothing. What this pins is the shape that made that so.
 */

const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const NAME = '20261121120000_sessions';
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

describe('the sessions migration', () => {
  it('sorts after the last migration shipped before it', () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(NAME);
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261116120000_conversation_lifecycle_expand'));
  });

  it('is ONE statement (a DO block): applied whole or not at all, whatever the runner commits between statements', () => {
    expect(code).toMatch(/^DO \$\$ .* END \$\$;$/);
    expect(code.match(/\$\$/g)).toHaveLength(2);
  });

  it('creates exactly the two tables, with the columns, keys and indexes of schema.prisma, and touches no existing one', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "sessions" ( "id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "generation" INTEGER NOT NULL, "rotated_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL, "expires_at" TIMESTAMP(3) NOT NULL, "remember_me" BOOLEAN NOT NULL, "token_version" INTEGER NOT NULL, "client_kind" TEXT NOT NULL, "client_os" TEXT NOT NULL, CONSTRAINT "sessions_pkey" PRIMARY KEY ("id") );');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "legacy_refresh_redemptions" ( "digest" TEXT NOT NULL, "session_id" TEXT, "expires_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "legacy_refresh_redemptions_pkey" PRIMARY KEY ("digest") );');
    expect(code).toContain('CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");');
    expect(code).toContain('CREATE INDEX IF NOT EXISTS "legacy_refresh_redemptions_session_id_idx" ON "legacy_refresh_redemptions"("session_id");');
    expect(code).toContain('ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;');
    expect(code).toContain('ALTER TABLE "legacy_refresh_redemptions" ADD CONSTRAINT "legacy_refresh_redemptions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;');
    // Nothing else is created, altered or written
    expect(code.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(2);
    expect(code.match(/ALTER TABLE/g)).toHaveLength(2);
    const withoutKeyActions = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, '');
    expect(withoutKeyActions).not.toMatch(/ALTER TABLE "users"|\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    // The columns a renewal updates carry no index: a renewal rewrites no index entry
    expect(code).not.toMatch(/INDEX[^;]*"(generation|rotated_at|expires_at)"/);
  });

  it('adds the key to `users` under a lock_timeout of ITS OWN transaction, tried again a bounded number of times', () => {
    const timeout = code.indexOf(`PERFORM set_config('lock_timeout', '2s', true);`);
    const usersKey = code.indexOf('ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"');
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(usersKey);
    // Transaction-local (the third argument), never a SET that would outlive the block on the connection
    expect(code).not.toMatch(/\bSET (SESSION |LOCAL )?lock_timeout\b/i);
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    // Each attempt in a block of its own (a failed wait rolls back to it), caught by name, paused, bounded
    expect(code).toMatch(/LOOP EXIT WHEN EXISTS \( SELECT 1 FROM pg_constraint WHERE conrelid = 'sessions'::regclass AND conname = 'sessions_user_id_fkey' \); BEGIN ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"/);
    expect(code).toContain('EXCEPTION WHEN lock_not_available THEN attempt := attempt + 1; IF attempt >= 20 THEN RAISE EXCEPTION');
    expect(code).toContain("USING ERRCODE = 'lock_not_available'");
    expect(code).toContain('PERFORM pg_sleep(1);');
    // The other key locks only the new tables, and is added once
    expect(code).toMatch(/IF NOT EXISTS \( SELECT 1 FROM pg_constraint WHERE conrelid = 'legacy_refresh_redemptions'::regclass AND conname = 'legacy_refresh_redemptions_session_id_fkey' \) THEN ALTER TABLE "legacy_refresh_redemptions"/);
  });

  it('says what each statement locks, what to do when it gives up, and the order of the deploy', () => {
    expect(commentText).toMatch(/SHARE ROW EXCLUSIVE lock on\s+-- `users`/);
    expect(commentText).toMatch(/no write to `users` waits behind this migration for more than one\s+-- timeout/);
    expect(commentText).toContain('npx prisma migrate resolve --rolled-back 20261121120000_sessions');
    expect(commentText).toMatch(/P3009/);
    expect(commentText).toMatch(/DEPLOYMENT ORDER\. This migration first, then the server/);
    expect(commentText).toMatch(/never a sign-out/);
  });

  it('agrees with schema.prisma: the two models, their keys\' actions, the indexes, no Prisma default on the id', () => {
    const session = model('Session');
    expect(session).toMatch(/@@map\("sessions"\)/);
    expect(session).toMatch(/\bid\s+String\s+@id\s*\n/);
    for (const [field, column, type] of [
      ['userId', 'user_id', 'String'], ['generation', null, 'Int'], ['rotatedAt', 'rotated_at', 'DateTime'],
      ['createdAt', 'created_at', 'DateTime'], ['expiresAt', 'expires_at', 'DateTime'], ['rememberMe', 'remember_me', 'Boolean'],
      ['tokenVersion', 'token_version', 'Int'], ['clientKind', 'client_kind', 'String'], ['clientOs', 'client_os', 'String'],
    ] as const) {
      const line = new RegExp(`\\b${field}\\s+${type}\\b[^\\n]*`).exec(session)?.[0] ?? '';
      expect(line, field).not.toBe('');
      if (column) expect(line, field).toContain(`@map("${column}")`);
      // Written by the raw statements on the database's clock: no Prisma-side default
      expect(line, field).not.toMatch(/@default|@updatedAt/);
    }
    expect(session).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
    expect(session).toMatch(/@@index\(\[userId\]\)/);

    const legacy = model('LegacyRefreshRedemption');
    expect(legacy).toMatch(/@@map\("legacy_refresh_redemptions"\)/);
    expect(legacy).toMatch(/digest\s+String\s+@id/);
    expect(legacy).toMatch(/sessionId\s+String\?\s+@map\("session_id"\)/);
    expect(legacy).toMatch(/session Session\? @relation\(fields: \[sessionId\], references: \[id\], onDelete: SetNull\)/);
    expect(legacy).toMatch(/@@index\(\[sessionId\]\)/);
    expect(model('User')).toMatch(/\bsessions\s+Session\[\]/);
  });
});
