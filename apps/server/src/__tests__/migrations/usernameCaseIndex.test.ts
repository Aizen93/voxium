import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `users_username_lower_key` is a FUNCTIONAL unique index. Prisma cannot
 * express one, so it does not appear in schema.prisma and `prisma migrate dev`
 * reads it as drift and offers to DROP it — at which point the case-insensitive
 * username rule silently reverts to being an application pre-check that two
 * concurrent signups both pass.
 *
 * These assert the SHAPE of the guard rather than its behaviour: the behaviour
 * was exercised against the dev database (case-variant insert rejected with
 * P2002, then rolled back). What a unit test usefully adds is noticing if
 * someone deletes the index, the schema warning, or the P2002 mapping that
 * keeps the race from surfacing as a 500 with the constraint name in the logs.
 */

const REPO = resolve(__dirname, '../../../../..');
const MIGRATION = resolve(
  REPO,
  'apps/server/prisma/migrations/20260820210000_username_case_insensitive_unique/migration.sql'
);
const SCHEMA = resolve(REPO, 'apps/server/prisma/schema.prisma');
const AUTH_SERVICE = resolve(REPO, 'apps/server/src/services/authService.ts');

const sql = readFileSync(MIGRATION, 'utf8');
const schema = readFileSync(SCHEMA, 'utf8');
const authService = readFileSync(AUTH_SERVICE, 'utf8');

describe('username case-insensitive uniqueness is enforced by the database', () => {
  it('creates the functional unique index, idempotently', () => {
    // The file's own production guidance is to build the index CONCURRENTLY
    // out-of-band and then `migrate resolve --applied`; a container booting
    // between those two steps runs `migrate deploy` and would fail on a bare
    // CREATE with "relation already exists" — the P3009 boot failure again.
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_key" ON "users" \(lower\("username"\)\)/);
  });

  it('repairs only UNVERIFIED squatters automatically and refuses to rename a real user', () => {
    // Renaming a verified account's login identity is not a migration's call
    expect(sql).toContain('"email_verified" = false');
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('ranks VERIFIED rows first, so an older unverified squatter cannot survive the repair', () => {
    // Ordering by age alone loses the case the repair exists for: an unverified
    // squatter registered BEFORE a real account takes rn = 1 and is never
    // renamed, while the verified row is rn > 1 but excluded by the
    // `email_verified = false` filter. Both survive, step 2 raises, and
    // `migrate deploy` aborts — under docker-entrypoint.sh's `set -e` that is a
    // boot failure plus a P3009 record blocking every later deploy.
    expect(sql).toMatch(
      /ORDER BY\s+"email_verified" DESC,\s*"created_at" ASC,\s*id ASC/
    );
    // ...and specifically NOT the age-only ordering it replaced.
    expect(sql).not.toMatch(/ORDER BY\s+"created_at" ASC,\s*id ASC\s*\n?\s*\)/);
  });

  it('says VERIFIED when it refuses, since that is the only collision that can reach step 2', () => {
    // After the repair, a surviving collision is verified-vs-verified by
    // construction. An operator reading "verified accounts collide" while one
    // of the two is a bot squatter would go looking for the wrong problem.
    expect(sql).toMatch(/two or more VERIFIED accounts collide/);
  });

  it('keeps the replacement username inside the app\'s own charset and length rules', () => {
    // [a-zA-Z0-9_.-], 3..32 — left(...,24) + '_' + 6 hex chars = 31 max
    expect(sql).toMatch(/left\(u\."username", 24\) \|\| '_' \|\| substr\(md5\(u\.id\), 1, 6\)/);
  });

  it('warns in schema.prisma that migrate dev will offer to drop the index', () => {
    expect(schema).toContain('users_username_lower_key');
    expect(schema).toMatch(/drift/i);
  });

  it('maps the constraint violation to the enumeration-safe conflict, not a raw Prisma error', () => {
    expect(authService).toContain("code === 'P2002'");
    expect(authService).toMatch(/P2002[\s\S]{0,200}Username or email already in use/);
  });
});
