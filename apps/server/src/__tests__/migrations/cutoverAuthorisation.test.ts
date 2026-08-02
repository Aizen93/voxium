import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The always-on cutover deletes every DM ever sent and truncates every E2E key
 * table. There is no down migration and no rollback but a snapshot.
 *
 * `prisma migrate deploy` is not an operator-only command here: it runs on
 * EVERY container start (docker-entrypoint.sh) and on every routine update
 * (DEPLOYMENT.md, "Application Updates"). So the sequencing in the runbook
 * cannot be what keeps this migration from firing — a restart is not an
 * operator action. Two gates stop it, and this file exists so neither can be
 * deleted quietly: the damage is silent, irreversible, and only visible once
 * users report their history is gone.
 *
 * These assert the SHAPE of the guards, not their behaviour — the behaviour was
 * exercised against a real database during the rehearsal (refuse without
 * authorisation, apply with it, sentinel spent afterwards). What a unit test can
 * usefully add is noticing if someone removes them.
 */

const REPO = resolve(__dirname, '../../../../..');
const MIGRATION = resolve(
  REPO,
  'apps/server/prisma/migrations/20260801140000_e2e_always_on/migration.sql'
);
const ENTRYPOINT = resolve(REPO, 'docker-entrypoint.sh');

const sql = readFileSync(MIGRATION, 'utf8');
const entrypoint = readFileSync(ENTRYPOINT, 'utf8');

describe('always-on cutover — the migration refuses to run unauthorised', () => {
  it('still contains the destructive statements this guards (the test is not vacuous)', () => {
    expect(sql).toMatch(/DELETE FROM "messages" WHERE "conversation_id" IS NOT NULL/);
    expect(sql).toMatch(/TRUNCATE "e2e_key_shares"/);
  });

  it('gates on a sentinel table that an operator must create deliberately', () => {
    expect(sql).toContain("to_regclass('public.e2e_cutover_authorised')");
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('puts the gate BEFORE anything destructive', () => {
    const gate = sql.indexOf('to_regclass');
    const firstDelete = sql.indexOf('DELETE FROM "messages"');
    expect(gate).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(-1);
    // A guard that runs after the DELETE guards nothing.
    expect(gate).toBeLessThan(firstDelete);
  });

  it('lets a database with nothing to destroy through', () => {
    // Fresh dev clones, CI, and newly provisioned nodes must still be able to
    // apply the schema change. A gate that blocks them would be routed around,
    // and a routed-around gate protects nobody.
    expect(sql).toMatch(/IF\s+doomed\s*=\s*0\s+THEN/);
    expect(sql).toMatch(/RETURN;/);
  });

  it('counts DM history AND key material when deciding whether there is anything to lose', () => {
    // Counting only messages would wave through a database whose DMs are
    // already gone but whose recovery keys and device identities are not.
    for (const table of [
      '"messages"',
      '"e2e_devices"',
      '"e2e_master_keys"',
      '"e2e_key_backups"',
      '"e2e_message_key_backups"',
    ]) {
      expect(sql.slice(0, sql.indexOf('DELETE FROM "messages"'))).toContain(table);
    }
  });

  it('spends the authorisation, so one CREATE TABLE buys exactly one run', () => {
    // `rehearse` deletes the _prisma_migrations row and a cutover applied
    // outside Prisma never writes one, so a re-run is reachable. Leaving the
    // sentinel behind would pre-authorise it.
    expect(sql).toMatch(/DROP TABLE IF EXISTS "e2e_cutover_authorised"/);
    expect(sql.indexOf('DROP TABLE IF EXISTS "e2e_cutover_authorised"')).toBeGreaterThan(
      sql.indexOf('TRUNCATE "e2e_key_shares"')
    );
  });

  it('tells whoever hits it how to recover, since it fails a migration to refuse', () => {
    // Refusing costs a failed-migration record that blocks later deploys; the
    // operator who sees this at 3am needs the fix in the message, not in a doc.
    expect(sql).toContain('migrate resolve --rolled-back 20260801140000_e2e_always_on');
  });
});

describe('always-on cutover — the entrypoint will not apply it on a restart', () => {
  it('checks for the pending cutover before running migrate deploy', () => {
    expect(entrypoint).toContain('20260801140000_e2e_always_on');
    const lines = entrypoint.split('\n');
    const isComment = (l: string) => l.trimStart().startsWith('#');
    // Anchor on the invocation, not on any mention of it: the comment above the
    // gate names `migrate deploy` too, and matching that made this assertion
    // compare two pieces of prose.
    const gate = lines.findIndex((l) => !isComment(l) && l.includes('20260801140000_e2e_always_on'));
    const deploy = lines.findIndex((l) => !isComment(l) && l.includes('migrate deploy'));
    expect(gate).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(deploy);
  });

  it('reads migrate status with stderr merged', () => {
    // `prisma migrate status` reports the PENDING list on stderr. With
    // `2>/dev/null` the grep matches nothing and the gate silently passes
    // everything — which is exactly the failure it exists to prevent, and it
    // was written that way first. This assertion is the reason it isn't now.
    const line = entrypoint
      .split('\n')
      .find((l) => l.includes('migrate status'));
    expect(line).toBeDefined();
    expect(line).toContain('2>&1');
    expect(line).not.toContain('2>/dev/null');
  });

  it('refuses rather than migrating, and names the override', () => {
    expect(entrypoint).toContain('VOXIUM_ALLOW_CUTOVER');
    expect(entrypoint).toMatch(/exit 1/);
  });

  it('defaults the override to off', () => {
    // `${VOXIUM_ALLOW_CUTOVER:-0}` — an unset variable must mean "do not cut
    // over", not "unspecified, go ahead".
    expect(entrypoint).toMatch(/\$\{VOXIUM_ALLOW_CUTOVER:-0\}/);
  });
});

describe('release script — verify proves what survived instead of asserting it', () => {
  const script = readFileSync(resolve(REPO, 'scripts/release-always-on.ts'), 'utf8');

  it('compares channel history against a recorded baseline', () => {
    // This check was `true`, hardcoded: a DELETE that lost its WHERE clause
    // took channel history with it and still printed PASS.
    expect(script).toMatch(/'channel history preserved',[\s\S]{0,200}baseline/);
    expect(script).not.toMatch(/\['channel history preserved', true,/);
  });

  it('fails when no baseline exists rather than passing unprovable checks', () => {
    expect(script).toMatch(/baseline === null \? false :/);
  });

  it('writes the baseline in capture-attachments, the last moment it is knowable', () => {
    const capture = script.indexOf('async function captureAttachments');
    const verify = script.indexOf('async function verify');
    const write = script.indexOf('writeFileSync(BASELINE_FILE');
    expect(write).toBeGreaterThan(capture);
    expect(write).toBeLessThan(verify);
  });

  it('does not treat a hostname as proof of which database it is talking to', () => {
    // `ssh -L 5433:db:5432` makes production `localhost`, and DEPLOYMENT.md's
    // own production DATABASE_URL literally contains "localhost" because
    // Postgres runs on the app box. rehearse rewrites schema and deletes the
    // cutover's _prisma_migrations row, so this guard has to be one no tunnel
    // and no deployment topology can satisfy by accident.
    expect(script).toContain('current_database()');
    expect(script).toContain('REHEARSE_DATABASE');
    expect(script).toMatch(/NODE_ENV === 'production'/);
    expect(script).not.toMatch(/includes\('localhost'\)/);
  });
});
