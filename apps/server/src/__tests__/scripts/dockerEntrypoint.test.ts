import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/**
 * docker-entrypoint.sh, run for real under `sh` with a stub `node` first on
 * PATH. The stub answers `migrate status` with outputs captured from the
 * Prisma 7.10.1 CLI against real databases in each state
 * (fixtures/migrate-status, database and host names normalised) and records
 * every call, so each test sees whether `migrate deploy` and the server start
 * were reached. `sleep` is stubbed too: the retries cost no time here.
 *
 * The gate's contract (issue #82):
 *   - an empty database migrates and starts without any override;
 *   - an existing database with the cutover pending is refused, and
 *     `migrate deploy` never runs;
 *   - a status that did not reach the database never leads to `migrate
 *     deploy`: it is retried, then the container exits;
 *   - VOXIUM_ALLOW_CUTOVER=1 skips the gate;
 *   - a database where the cutover is applied proceeds.
 */

const REPO = resolve(__dirname, '../../../../..');
const ENTRYPOINT = join(REPO, 'docker-entrypoint.sh');
const MIGRATIONS = join(REPO, 'apps/server/prisma/migrations');
const FIXTURES = join(__dirname, '../fixtures/migrate-status');
const CUTOVER = '20260801140000_e2e_always_on';
/** The entrypoint's bound on status reads (and on deploy attempts). */
const MAX_ATTEMPTS = 10;

/** The exit code `prisma migrate status` returned with each captured output. */
const STATUS_EXIT = {
  'empty-database': 1,
  'missing-database': 1,
  'cutover-pending': 1,
  'cutover-failed': 1,
  'cutover-applied-later-pending': 1,
  'up-to-date': 0,
  'database-ahead-of-image': 0,
  'oldest-pending-others-applied': 1,
  'partly-migrated': 1,
  'interrupted-first-start': 1,
  unreachable: 1,
  'wrong-password': 1,
} as const;
type Fixture = keyof typeof STATUS_EXIT;
type Status = { output: string; exit: number };

function captured(name: Fixture): Status {
  return { output: readFileSync(join(FIXTURES, `${name}.txt`), 'utf8'), exit: STATUS_EXIT[name] };
}

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

// Logs every call with the update-check switch it saw. `migrate status`
// answers on STDERR, the stream Prisma prints its pending list on, so an
// entrypoint that stops merging stderr reads nothing. The queued answers are
// used in order and the last one repeats.
const STUB_NODE = `#!/bin/sh
printf '%s|CHECKPOINT_DISABLE=%s\\n' "$*" "\${CHECKPOINT_DISABLE-}" >> "$STUB_DIR/calls.log"
case "$*" in
  *"migrate status"*)
    n=$(( $(cat "$STUB_DIR/status-count") + 1 ))
    echo "$n" > "$STUB_DIR/status-count"
    [ -f "$STUB_DIR/status-$n.txt" ] || n=$(cat "$STUB_DIR/status-total")
    cat "$STUB_DIR/status-$n.txt" >&2
    exit "$(cat "$STUB_DIR/status-$n.exit")" ;;
  *"migrate deploy"*)
    exit "$(cat "$STUB_DIR/deploy-exit")" ;;
  *"apps/server/dist/index.js"*)
    exit 0 ;;
esac
echo "stub node: unexpected call: $*" >&2
exit 97
`;

const STUB_SLEEP = `#!/bin/sh
printf 'sleep %s|\\n' "$*" >> "$STUB_DIR/calls.log"
`;

interface Run {
  code: number | null;
  out: string;
  statusReads: number;
  deploys: number;
  serverStarted: boolean;
  sleeps: number;
  /** The CHECKPOINT_DISABLE value each Prisma CLI call saw. */
  checkpointSwitch: string[];
}

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runEntrypoint(statuses: Status[], opts: { allowCutover?: string; deployExit?: number } = {}): Run {
  const work = mkdtempSync(join(tmpdir(), 'voxium-entrypoint-'));
  workDirs.push(work);

  // The image's layout, as far as the entrypoint looks at it: /app with the
  // migrations directory (the real migration names, one empty file each).
  const migrations = join(work, 'apps/server/prisma/migrations');
  for (const name of readdirSync(MIGRATIONS)) {
    if (existsSync(join(MIGRATIONS, name, 'migration.sql'))) {
      mkdirSync(join(migrations, name), { recursive: true });
      writeFileSync(join(migrations, name, 'migration.sql'), '');
    }
  }
  writeFileSync(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');

  const stub = join(work, 'stub');
  mkdirSync(stub);
  for (const [file, body] of [['node', STUB_NODE], ['sleep', STUB_SLEEP]] as const) {
    writeFileSync(join(stub, file), body);
    chmodSync(join(stub, file), 0o755);
  }
  statuses.forEach((s, i) => {
    writeFileSync(join(stub, `status-${i + 1}.txt`), s.output);
    writeFileSync(join(stub, `status-${i + 1}.exit`), String(s.exit));
  });
  writeFileSync(join(stub, 'status-total'), String(statuses.length));
  writeFileSync(join(stub, 'status-count'), '0');
  writeFileSync(join(stub, 'deploy-exit'), String(opts.deployExit ?? 0));
  writeFileSync(join(stub, 'calls.log'), '');

  // Windows spells it Path: drop every spelling before setting ours, or the
  // child may see the unstubbed one.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(path|voxium_allow_cutover|checkpoint_disable|node_options)$/i.test(key)) env[key] = value;
  }
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  env.PATH = `${stub}${delimiter}${inheritedPath}`;
  env.STUB_DIR = stub.replace(/\\/g, '/');
  if (opts.allowCutover !== undefined) env.VOXIUM_ALLOW_CUTOVER = opts.allowCutover;

  const result = spawnSync('sh', [ENTRYPOINT.replace(/\\/g, '/')], { cwd: work, env, encoding: 'utf8' });
  if (result.error) throw result.error;

  const calls = readFileSync(join(stub, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  const prismaCalls = calls.filter((c) => c.includes('node_modules/prisma/build/index.js'));
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    statusReads: calls.filter((c) => c.includes('migrate status')).length,
    deploys: calls.filter((c) => c.includes('migrate deploy')).length,
    serverStarted: calls.some((c) => c.includes('apps/server/dist/index.js')),
    sleeps: calls.filter((c) => c.startsWith('sleep ')).length,
    checkpointSwitch: prismaCalls.map((c) => c.slice(c.lastIndexOf('|CHECKPOINT_DISABLE=') + '|CHECKPOINT_DISABLE='.length)),
  };
}

/** A status that did not even print: the CLI died before reaching anything. */
const SILENT_CRASH: Status = { output: '', exit: 1 };

describe.runIf(shAvailable)('docker-entrypoint.sh — the cutover gate decides on what the database answered', () => {
  // Spawning sh and its stubs is slow on Windows; ten retries add up.
  const TIMEOUT = 60_000;

  it('migrates and starts an empty database without any override', () => {
    const run = runEntrypoint([captured('empty-database')]);
    expect(run.out).not.toContain('FATAL');
    expect(run.statusReads).toBe(1);
    expect(run.deploys).toBe(1);
    expect(run.serverStarted).toBe(true);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it('logs only what the status shows when no migration is recorded', () => {
    // A new database, and one whose _prisma_migrations rows were deleted
    // while its tables stayed, print the same status (both captured: byte for
    // byte equal). The second one's deploy then fails on its first migration
    // (42P07), so the log must not promise that the migrations will apply.
    const run = runEntrypoint([captured('empty-database')]);
    expect(run.out).toContain('[Voxium] No migration is recorded in this database: every migration is pending.');
    expect(run.out).not.toContain('New database');
    expect(run.deploys).toBe(1);
  }, TIMEOUT);

  it('migrates and starts when the database does not exist yet (migrate deploy creates it)', () => {
    const run = runEntrypoint([captured('missing-database')]);
    expect(run.out).toContain('[Voxium] The database does not exist yet: migrate deploy creates it.');
    expect(run.deploys).toBe(1);
    expect(run.serverStarted).toBe(true);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it('refuses an existing database with the cutover pending, and never runs migrate deploy', () => {
    const run = runEntrypoint([captured('cutover-pending')]);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`FATAL: the always-on E2E cutover (${CUTOVER}) has not been applied`);
    expect(run.out).toContain('VOXIUM_ALLOW_CUTOVER=1');
    expect(run.deploys).toBe(0);
    expect(run.serverStarted).toBe(false);
  }, TIMEOUT);

  it('refuses an existing database whose OLDEST migration is pending too (a back-dated migration)', () => {
    // 42 of the 56 migrations applied, the first one among the pending: what
    // every existing database would show if a migration older than the
    // applied ones were ever added. Only "every migration pending" is empty.
    const status = captured('oldest-pending-others-applied');
    expect(status.output).toContain('20260220223130_migration_version_1');
    const run = runEntrypoint([status]);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`FATAL: the always-on E2E cutover (${CUTOVER}) has not been applied`);
    expect(run.deploys).toBe(0);
    expect(run.serverStarted).toBe(false);
  }, TIMEOUT);

  it.each([
    // Killed while migration 5 ran: 1-4 applied, 5 recorded as started and
    // never finished (which `migrate status` does not list), 6-56 pending.
    ['a first start killed while migrating', 'interrupted-first-start', '51 of its 56'],
    ['a first start stopped between migrations', 'partly-migrated', '52 of its 56'],
  ] as const)('refuses %s, and says how to go on with a database that never served users', (_label, name, counts) => {
    const run = runEntrypoint([captured(name)]);
    expect(run.code).toBe(1);
    expect(run.deploys).toBe(0);
    expect(run.out).toContain(`FATAL: the always-on E2E cutover (${CUTOVER}) has not been applied.`);
    expect(run.out).toContain(`This database is not new: ${counts} migrations are pending.`);
    expect(run.out).toContain('If this database never served users');
    expect(run.out).toContain('another replica');
    expect(run.out).toContain('interrupted');
    expect(run.out).toContain("the cutover's own SQL gate still refuses");
    // What the override then meets: the interrupted migration's failed record.
    expect(run.out).toContain('P3009');
    expect(run.out).toContain('migrate resolve --rolled-back');
  }, TIMEOUT);

  it('retries a status that did not reach the database, then refuses once an existing database answers', () => {
    // Defect 2 of the old gate: P1001 does not name the cutover, so it passed,
    // and the deploy that followed met the cutover on this existing database.
    const run = runEntrypoint([captured('unreachable'), captured('unreachable'), captured('cutover-pending')]);
    expect(run.statusReads).toBe(3);
    expect(run.sleeps).toBe(2);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`FATAL: the always-on E2E cutover (${CUTOVER}) has not been applied`);
    expect(run.deploys).toBe(0);
    expect(run.serverStarted).toBe(false);
  }, TIMEOUT);

  it('retries a status that did not reach the database, then migrates once an empty database answers', () => {
    const run = runEntrypoint([captured('unreachable'), captured('empty-database')]);
    expect(run.statusReads).toBe(2);
    expect(run.deploys).toBe(1);
    expect(run.serverStarted).toBe(true);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it.each([
    ['the server is unreachable (P1001)', captured('unreachable')],
    ['the credentials are refused (P1000)', captured('wrong-password')],
    ['the CLI printed nothing', SILENT_CRASH],
  ])('never runs migrate deploy when the status never reaches the database: %s', (_label, status) => {
    const run = runEntrypoint([status]);
    expect(run.statusReads).toBe(MAX_ATTEMPTS);
    expect(run.sleeps).toBe(MAX_ATTEMPTS - 1);
    expect(run.code).toBe(1);
    expect(run.out).toContain('FATAL: could not read the migration status');
    expect(run.deploys).toBe(0);
    expect(run.serverStarted).toBe(false);
  }, TIMEOUT);

  it('skips the gate with VOXIUM_ALLOW_CUTOVER=1', () => {
    const run = runEntrypoint([captured('cutover-pending')], { allowCutover: '1' });
    expect(run.statusReads).toBe(0);
    expect(run.deploys).toBe(1);
    expect(run.serverStarted).toBe(true);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it('treats any other VOXIUM_ALLOW_CUTOVER value as unset', () => {
    const run = runEntrypoint([captured('cutover-pending')], { allowCutover: 'true' });
    expect(run.code).toBe(1);
    expect(run.deploys).toBe(0);
  }, TIMEOUT);

  it.each([
    ['the database is up to date', 'up-to-date'],
    ['later migrations are pending', 'cutover-applied-later-pending'],
    ['the database is ahead of this image', 'database-ahead-of-image'],
  ] as const)('proceeds when the cutover is already applied: %s', (_label, name) => {
    const run = runEntrypoint([captured(name)]);
    expect(run.out).not.toContain('FATAL');
    expect(run.deploys).toBe(1);
    expect(run.serverStarted).toBe(true);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it('leaves a failed cutover record to migrate deploy, which refuses it without touching anything', () => {
    // Prisma 7.10.1 `migrate status` does not list a failed migration at all:
    // its output equals the "applied" one, so the gate cannot see it. The
    // deploy then stops on P3009 before applying anything (checked live), and
    // the container exits after its retries instead of starting the server.
    const failed = captured('cutover-failed');
    expect(failed.output).not.toContain(CUTOVER);
    const run = runEntrypoint([failed], { deployExit: 1 });
    expect(run.deploys).toBe(MAX_ATTEMPTS);
    expect(run.serverStarted).toBe(false);
    expect(run.code).toBe(1);
  }, TIMEOUT);

  it('reads a status printed with CRLF line endings', () => {
    const empty = captured('empty-database');
    const run = runEntrypoint([{ ...empty, output: empty.output.replace(/\r?\n/g, '\r\n') }]);
    expect(run.deploys).toBe(1);
    expect(run.code).toBe(0);
  }, TIMEOUT);

  it('runs every Prisma CLI call with the update check off', () => {
    const run = runEntrypoint([captured('unreachable'), captured('empty-database')]);
    expect(run.checkpointSwitch).toHaveLength(3);
    expect(run.checkpointSwitch.every((value) => value === '1')).toBe(true);
  }, TIMEOUT);
});
