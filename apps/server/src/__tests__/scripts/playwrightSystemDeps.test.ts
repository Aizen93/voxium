import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .github/scripts/playwright-system-deps.sh, the CI step that installs the OS
// packages of Playwright's browsers (beside the other root scripts' tests).
// The script runs for real under bash; `sudo`, `npx`, `dpkg` and `node` are
// stubs first on PATH that record how they were called and answer what each
// case scripts. `timeout` and `env` are the real ones.

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/playwright-system-deps.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');

/** A bash that understands the paths this test hands it (on Windows: Git's, not WSL's). */
function usableBash(): boolean {
  const probe = spawnSync('bash', ['-c', 'uname -s && command -v timeout'], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const kernel = probe.stdout.split('\n')[0].trim();
  return process.platform === 'win32' ? /^(MINGW|MSYS)/.test(kernel) : true;
}

const STUBS: Record<string, string> = {
  // Runs what it is given, as the real one does for a passwordless runner
  sudo: `#!/usr/bin/env bash
echo "sudo $*" >> "$STUB_LOG"
exec "$@"
`,
  // One outcome per call, read from NPX_PLAN ("fail,ok"): ok, fail or hang
  npx: `#!/usr/bin/env bash
count=$(cat "$STUB_DIR/npx.count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$STUB_DIR/npx.count"
echo "npx $*" >> "$STUB_LOG"
outcome=$(echo "$NPX_PLAN" | cut -d, -f"$count")
case "$outcome" in
  ok) exit 0 ;;
  hang) sleep 60; exit 0 ;;
  *) exit 1 ;;
esac
`,
  dpkg: `#!/usr/bin/env bash
echo "dpkg $*" >> "$STUB_LOG"
exit 0
`,
  // The launch probe: NODE_PROBE says whether the browsers start
  node: `#!/usr/bin/env bash
echo "node $*" >> "$STUB_LOG"
[ "$NODE_PROBE" = "ok" ] && exit 0
exit 1
`,
};

describe.runIf(usableBash())('playwright-system-deps.sh', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pw-deps-'));
    log = path.join(dir, 'calls.log');
    for (const [name, body] of Object.entries(STUBS)) {
      const file = path.join(dir, name);
      writeFileSync(file, body, { encoding: 'utf8' });
      chmodSync(file, 0o755);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(env: Record<string, string>) {
    const started = Date.now();
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
        STUB_DIR: dir,
        STUB_LOG: log,
        PW_DEPS_PAUSE_SECONDS: '0',
        NODE_PROBE: 'fail',
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls,
      npxCalls: calls.filter((c) => c.startsWith('npx ')).length,
      dpkgCalls: calls.filter((c) => c.startsWith('dpkg ')).length,
      probeCalls: calls.filter((c) => c.startsWith('node ')),
      seconds: (Date.now() - started) / 1000,
    };
  }

  it('installs once and never runs the probe when the first attempt succeeds', () => {
    const r = run({ NPX_PLAN: 'ok' });
    expect(r.status).toBe(0);
    expect(r.npxCalls).toBe(1);
    expect(r.dpkgCalls).toBe(0);
    expect(r.probeCalls).toEqual([]);
    expect(r.output).toContain('System dependencies installed.');
    expect(r.output).not.toContain('::warning::');
  });

  it('runs the install as root, behind the time limit, for both browsers', () => {
    const r = run({ NPX_PLAN: 'ok', PW_DEPS_ATTEMPT_SECONDS: '77' });
    const sudoLine = r.calls.find((c) => c.startsWith('sudo env '));
    expect(sudoLine).toBeDefined();
    // The limit must sit INSIDE sudo: a timeout run by the runner's user cannot signal root's apt
    expect(sudoLine).toMatch(/ timeout --kill-after=15 77 npx playwright install-deps chromium firefox$/);
    expect(sudoLine).toMatch(/^sudo env PATH=/);
  });

  it('tries again after a failed attempt, repairing dpkg in between, and succeeds', () => {
    const r = run({ NPX_PLAN: 'fail,ok' });
    expect(r.status).toBe(0);
    expect(r.npxCalls).toBe(2);
    expect(r.dpkgCalls).toBe(1);
    expect(r.calls.find((c) => c.startsWith('dpkg '))).toBe('dpkg --configure -a');
    expect(r.probeCalls).toEqual([]);
    expect(r.output).toContain('::warning::playwright install-deps: attempt 1 of 2 failed');
  });

  it('goes on with a warning when every attempt fails and both browsers start', () => {
    const r = run({ NPX_PLAN: 'fail,fail', NODE_PROBE: 'ok' });
    expect(r.status).toBe(0);
    expect(r.npxCalls).toBe(2);
    expect(r.probeCalls).toHaveLength(1);
    expect(r.probeCalls[0]).toMatch(/playwright-launch-probe\.mjs$/);
    expect(r.output).toContain('Continuing WITHOUT the extra system packages');
    expect(r.output).not.toContain('::error::');
  });

  it('fails the step when every attempt fails and a browser does not start', () => {
    const r = run({ NPX_PLAN: 'fail,fail', NODE_PROBE: 'fail' });
    expect(r.status).toBe(1);
    expect(r.npxCalls).toBe(2);
    expect(r.probeCalls).toHaveLength(1);
    expect(r.output).toContain('::error::The Playwright system dependencies could not be installed');
  });

  it('never makes more attempts than it is given', () => {
    const r = run({ NPX_PLAN: 'fail,fail,fail,ok', PW_DEPS_ATTEMPTS: '3', NODE_PROBE: 'ok' });
    expect(r.npxCalls).toBe(3);
    expect(r.status).toBe(0);
  });

  it('stops an attempt that passes its limit and counts it as failed', () => {
    // The first install would sleep for a minute; the limit is one second
    const r = run({ NPX_PLAN: 'hang,ok', PW_DEPS_ATTEMPT_SECONDS: '1' });
    expect(r.status).toBe(0);
    expect(r.npxCalls).toBe(2);
    expect(r.output).toContain('attempt 1 of 2 failed or passed its 1s limit');
    expect(r.seconds).toBeLessThan(30);
  });
});

describe('the end-to-end job installs the system packages through the bounded script', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

  /** The lines of one step, from its `- name:` to the next step. */
  function step(name: string): string {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    expect(start, `step "${name}" not found in ci.yml`).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - name: ', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  }

  it('runs the script on every run, with a step limit below the job limit', () => {
    const deps = step('Install Playwright system deps');
    expect(deps).toContain('run: bash .github/scripts/playwright-system-deps.sh');
    // Both branches of the browser cache need the OS packages
    expect(deps).not.toMatch(/^\s+if:/m);
    const limit = Number(/timeout-minutes: (\d+)/.exec(deps)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(30);
  });

  it('no step calls apt through Playwright without the bound', () => {
    expect(workflow).not.toMatch(/playwright install --with-deps/);
    expect(workflow).not.toMatch(/run: npx playwright install-deps/);
    const browsers = step('Install Playwright browsers');
    expect(browsers).toContain('run: npx playwright install chromium firefox');
    expect(browsers).toMatch(/timeout-minutes: \d+/);
  });

  it('the worst case of the script fits inside its step limit', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const attempts = Number(/PW_DEPS_ATTEMPTS:-(\d+)/.exec(script)?.[1]);
    const seconds = Number(/PW_DEPS_ATTEMPT_SECONDS:-(\d+)/.exec(script)?.[1]);
    const pause = Number(/PW_DEPS_PAUSE_SECONDS:-(\d+)/.exec(script)?.[1]);
    const limitMinutes = Number(/timeout-minutes: (\d+)/.exec(step('Install Playwright system deps'))?.[1]);
    // Every attempt at its limit plus its kill grace, the pauses, and two minutes for the probe
    const worstSeconds = attempts * (seconds + 15) + (attempts - 1) * pause + 120;
    expect(worstSeconds).toBeLessThan(limitMinutes * 60);
  });
});
