import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * .github/workflows/integration-scripts.yml runs scripts/test-permissions.ts
 * and scripts/test-multi-node.ts (#73): the only checks that run the
 * permission matrix against a live backend and two real nodes against one
 * Redis. Nothing ran them but a developer by hand. These pin what review
 * would otherwise check by eye: the triggers, the bounds, the order the two
 * scripts need, and the account and state each one expects.
 */

const REPO = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(REPO, path), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/integration-scripts.yml');
const ci = read('.github/workflows/ci.yml');

/** The steps of the workflow's one job, in order: each one's name and text. */
const steps = workflow
  .split('\n      - name: ')
  .slice(1)
  .map((text) => ({ name: text.slice(0, text.indexOf('\n')), text }));
const stepNamed = (name: string) => {
  const step = steps.find((s) => s.name === name);
  expect(step, name).toBeDefined();
  return step!;
};
const indexOf = (name: string) => steps.findIndex((s) => s.name === name);
/** A step's lines without its comments. */
const codeOf = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const PERMISSIONS = 'Permission script (scripts/test-permissions.ts)';
const MULTI_NODE = 'Multi-node script (scripts/test-multi-node.ts)';

describe('the integration-scripts workflow', () => {
  it('pins every action exactly as ci.yml already does (SHA, tag in a comment)', () => {
    const uses = workflow.split('\n').filter((l) => /^\s*(- )?uses: /.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      expect(ci).toContain(line.trim().replace(/^- /, ''));
    }
  });

  it('reads the repository and writes nothing', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/: write\b/);
  });

  it('runs on pull requests and develop pushes that touch what the scripts exercise, and on demand', () => {
    for (const path of [
      'apps/server/**',
      'packages/shared/**',
      'scripts/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.github/workflows/integration-scripts.yml',
    ]) {
      // Once under pull_request, once under push
      expect(workflow.split('\n').filter((l) => l.trim() === `- ${path}` || l.trim() === `- '${path}'`), path).toHaveLength(2);
    }
    expect(workflow).toMatch(/push:\n {4}branches: \[develop\]/);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it('also runs once a week, off the hour and apart from the other scheduled workflows', () => {
    // What moves outside the repository (the runner image, the service
    // images' floating tags, prebuilt binaries) breaks it with no change here
    const crons = [...workflow.matchAll(/^ {4}- cron: '([^']+)'/gm)].map((m) => m[1]);
    expect(crons).toHaveLength(1);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = crons[0].split(' ');
    expect(dayOfMonth).toBe('*');
    expect(month).toBe('*');
    expect(dayOfWeek, 'one day of the week').toMatch(/^[0-6]$/);
    expect(minute, 'a fixed minute, not the top of the hour every scheduler crowds').toMatch(/^[1-5]?[0-9]$/);
    expect(Number(minute)).not.toBe(0);
    expect(hour).toMatch(/^([01]?[0-9]|2[0-3])$/);
    // No other workflow is scheduled in the same hour of the same day
    const others = ['crypto-deps-watch.yml', 'desktop-shell.yml', 'ci.yml', 'release.yml', 'docker.yml', 'server-image.yml', 'enforce-source-branch.yml']
      .flatMap((f) => [...read(`.github/workflows/${f}`).matchAll(/- cron: '([^']+)'/g)].map((m) => m[1].split(' ')));
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(`${other[1]} ${other[4]}`).not.toBe(`${hour} ${dayOfWeek}`);
  });

  it('interpolates no attacker-controlled context', () => {
    const allowed = new Set([
      '${{ github.ref }}',
      '${{ steps.pnpm-ver.outputs.version }}',
      '${{ steps.pnpm-store.outputs.dir }}',
      '${{ runner.os }}',
      "${{ hashFiles('**/pnpm-lock.yaml') }}",
      '${{ job.services.postgres.id }}',
      '${{ job.services.redis.id }}',
      "${{ !cancelled() && (success() || steps.permissions.outcome == 'failure') }}",
    ]);
    const used = workflow.match(/\$\{\{.*?\}\}/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const expression of used) expect(allowed, expression).toContain(expression);
    // and none of them inside a run: script
    for (const { text } of steps) {
      const run = text.slice(text.indexOf('        run: |'));
      if (text.includes('        run: |')) expect(run.split('\n').slice(1).filter((l) => l.startsWith('          ')).join('\n')).not.toContain('${{');
    }
  });

  it('bounds the job and every step that runs a script or waits', () => {
    expect(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(workflow)?.[1])).toBeLessThanOrEqual(30);
    for (const name of [PERMISSIONS, MULTI_NODE, 'Start a backend for the permission script']) {
      const minutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(stepNamed(name).text)?.[1]);
      expect(minutes, name).toBeGreaterThan(0);
      expect(minutes, name).toBeLessThanOrEqual(15);
    }
    const lines = workflow.split('\n').filter((l) => !/^\s*#/.test(l));
    for (const l of lines.filter((x) => /\bcurl /.test(x))) expect(l).toMatch(/--max-time \d+/);
    for (const l of lines.filter((x) => /docker exec /.test(x))) expect(l, l.trim()).toMatch(/timeout \d+ docker exec /);
    // every wait loop is counted
    for (const l of lines.filter((x) => /^\s*(for|while|until) /.test(x))) expect(l, l.trim()).toMatch(/^\s*for i in \$\(seq 1 \d+\); do$/);
  });

  it('has its own PostgreSQL and Redis, prepared the way the e2e job prepares its database', () => {
    expect(workflow).toMatch(/\n {6}postgres:\n {8}image: postgres:16-alpine\n/);
    expect(workflow).toMatch(/\n {6}redis:\n {8}image: redis:7-alpine\n/);
    expect(workflow).toMatch(/\n {6}DATABASE_URL: postgresql:\/\/\S+@127\.0\.0\.1:5432\/voxium_scripts\b/);
    expect(workflow).toMatch(/\n {6}NODE_ENV: development\n/);
    expect(stepNamed('Apply migrations').text).toContain('run: npx prisma migrate deploy');
    expect(stepNamed('Seed the demo accounts').text).toContain('run: pnpm db:seed');
  });

  it('makes the seed account both scripts sign in as an admin, after the seed and before either script', () => {
    // Both call admin routes as alice@example.com (feature flags, live stats,
    // the rate-limit raise), and the seed creates her as a plain user
    expect(read('scripts/test-permissions.ts')).toContain("const SEED_EMAIL = 'alice@example.com';");
    expect(read('scripts/test-multi-node.ts')).toContain("adminToken = await login(API1, 'alice');");
    expect(read('apps/server/prisma/seed.ts')).toContain("email: 'alice@example.com'");
    const promote = stepNamed('Make the seed account alice a platform admin');
    expect(promote.text).toContain("UPDATE users SET role = 'admin' WHERE email = 'alice@example.com'");
    // Decided on the count of rows updated: psql -t still prints UPDATE's
    // command tag, so an emptiness check alone would pass a missing account
    expect(promote.text).toContain('RETURNING id) SELECT count(*) FROM promoted');
    expect(promote.text).toContain('if [ "$promoted" != "1" ]; then');
    expect(indexOf('Make the seed account alice a platform admin')).toBeGreaterThan(indexOf('Seed the demo accounts'));
    expect(indexOf('Make the seed account alice a platform admin')).toBeLessThan(indexOf(PERMISSIONS));
  });

  it('runs the permission script against a backend it starts from source, the way the scripts start theirs', () => {
    const start = stepNamed('Start a backend for the permission script');
    expect(start.text).toContain('        working-directory: apps/server\n');
    expect(start.text).toContain('log="$RUNNER_TEMP/permissions-backend.log"');
    expect(start.text).toContain('nohup node --import tsx src/index.ts > "$log" 2>&1 &');
    expect(start.text).toContain('echo "$pid" > "$RUNNER_TEMP/permissions-backend.pid"');
    expect(read('scripts/test-multi-node.ts')).toContain("spawn(process.execPath, ['--import', 'tsx', serverEntry]");
    // ready only once fully started (/ready); nothing answers there before
    // the start (an answer does not say which process gave it); a backend
    // that died ends the wait at once and says so, its state read from ps
    // (a zombie still answers kill -0)
    expect(start.text).toContain('http://127.0.0.1:3001/ready');
    expect(start.text).toContain('echo "::error::something already answers on port 3001"');
    expect(start.text.indexOf('something already answers')).toBeLessThan(start.text.indexOf('nohup node'));
    expect(start.text).toContain("state=$(ps -o stat= -p \"$1\" 2>/dev/null | tr -d ' ')");
    expect(start.text).toContain("case \"$state\" in ''|Z*) return 1 ;; esac");
    expect(start.text).toMatch(/if ! running "\$pid"; then\n\s+echo "::error::the backend \(pid \$pid\) exited during start-up"/);
    expect(codeOf(start.text)).not.toMatch(/kill -0/);
    expect(indexOf('Build shared')).toBeLessThan(indexOf('Start a backend for the permission script'));
    expect(indexOf('Announce mediasoup on the runner\'s real IP')).toBeLessThan(indexOf('Start a backend for the permission script'));
    expect(stepNamed(PERMISSIONS).text).toContain('        id: permissions\n');
    expect(stepNamed(PERMISSIONS).text).toContain('run: npx tsx scripts/test-permissions.ts');
  });

  it('announces mediasoup on the runner\'s address exactly as the e2e job does', () => {
    /** A step's `run: |` lines, up to the first line that is not part of it. */
    const runOf = (text: string) => {
      const lines = text.slice(text.indexOf('        run: |\n')).split('\n').slice(1);
      const end = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('          '));
      return lines.slice(0, end === -1 ? undefined : end).join('\n').trim();
    };
    const announce = stepNamed('Announce mediasoup on the runner\'s real IP').text;
    const e2e = ci.split('\n      - name: ').find((s) => s.startsWith('Announce mediasoup on the runner\'s real IP\n'));
    expect(e2e).toBeDefined();
    expect(runOf(announce)).toContain('MEDIASOUP_ANNOUNCED_IP=$RUNNER_IP');
    expect(runOf(announce)).toBe(runOf(e2e!));
  });

  it('stops that backend whatever the script did, with SIGTERM first (its shutdown deletes its node heartbeat)', () => {
    const stop = stepNamed('Stop the permission script\'s backend');
    expect(stop.text).toContain('        if: always()\n');
    expect(stop.text).toContain('kill -TERM "$pid"');
    expect(stop.text.indexOf('kill -TERM')).toBeLessThan(stop.text.indexOf('kill -KILL'));
    expect(stop.text).toContain('cat "$log"');
    // gone is judged by the process state, as in the start step
    expect(stop.text).toContain("case \"$state\" in ''|Z*) return 1 ;; esac");
    expect(codeOf(stop.text)).not.toMatch(/kill -0/);
    expect(indexOf('Stop the permission script\'s backend')).toBe(indexOf(PERMISSIONS) + 1);
  });

  it('empties Redis before the multi-node script: no limit counter, override or heartbeat of the first run meets the second', () => {
    const flush = stepNamed('Empty Redis between the two scripts');
    expect(flush.text).toContain('redis-cli FLUSHALL');
    expect(flush.text).toContain('redis-cli DBSIZE');
    expect(indexOf('Empty Redis between the two scripts')).toBeGreaterThan(indexOf('Stop the permission script\'s backend'));
    expect(indexOf('Empty Redis between the two scripts')).toBeLessThan(indexOf(MULTI_NODE));
  });

  it('runs the multi-node script last, whole (no scenario skipped), also when only the permission script failed', () => {
    const multi = stepNamed(MULTI_NODE);
    expect(multi.text).toContain('run: npx tsx scripts/test-multi-node.ts');
    expect(workflow).not.toMatch(/SKIP_(CRASH|STALE_HEARTBEAT)_TEST/);
    const condition = "        if: ${{ !cancelled() && (success() || steps.permissions.outcome == 'failure') }}\n";
    expect(multi.text).toContain(condition);
    expect(stepNamed('Empty Redis between the two scripts').text).toContain(condition);
    expect(indexOf(MULTI_NODE)).toBe(steps.length - 1);
  });

  it('is not one of the jobs the CI gate needs (a path-filtered check cannot be required)', () => {
    expect(ci).not.toContain('integration-scripts');
  });
});

/** A step's `run: |` block, unindented. */
function runBlock(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at, 'run: |').toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

/** The state `ps` gives a pid ('' when there is none). */
const psState = (pid: number) => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

// The stop step's own script, run under bash with stand-in backends. Linux
// only: it reads process states with `ps -o stat=`, which the runner has and
// Git for Windows' ps does not; CI's unit-test job runs it.
describe.runIf(process.platform === 'linux')('the stop step, run for real', () => {
  let dir: string;
  const script = runBlock(stepNamed('Stop the permission script\'s backend').text);
  const run = () => spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, RUNNER_TEMP: dir },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stop-step-'));
    writeFileSync(join(dir, 'permissions-backend.log'), 'the backend log\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so when no backend was started', () => {
    const result = run();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('No backend was started.');
  });

  it('ends a running backend with SIGTERM and prints its log', () => {
    const backend = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, 'permissions-backend.pid'), String(backend.pid));
      const result = run();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('the backend log');
      expect(result.stdout).not.toContain('::warning::');
      // gone, or a zombie this process has not reaped yet
      expect(psState(backend.pid!)).toMatch(/^(|Z.*)$/);
    } finally {
      backend.kill('SIGKILL');
    }
  });

  it('takes an exited process nobody reaps (a zombie) for gone, instead of waiting 40 s on kill -0', () => {
    const pidfile = join(dir, 'permissions-backend.pid');
    // `sleep 1` exits under a parent that exec'd into another sleep and
    // never reaps it: its pid stays, as a zombie. A second, so that the exec
    // happens before it exits even on a loaded runner (bash would reap it)
    const parent = spawn('bash', ['-c', `sleep 1 & echo $! > '${pidfile}'; exec sleep 60`], { stdio: 'ignore' });
    try {
      let state = '';
      for (let i = 0; i < 100 && !state.startsWith('Z'); i++) {
        spawnSync('sleep', ['0.05']);
        if (existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim()) state = psState(Number(readFileSync(pidfile, 'utf8')));
      }
      expect(state, 'a zombie to stop').toMatch(/^Z/);
      const started = Date.now();
      const result = run();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.stdout).not.toContain('still running');
    } finally {
      parent.kill('SIGKILL');
    }
  });
});
