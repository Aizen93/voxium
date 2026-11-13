import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .github/scripts/apt-install.sh, the release build's Linux packages. The
// release workflow runs on version tags only, so these tests are the only
// check the script gets before a release. It runs for real under bash;
// `sudo`, `apt-get` and `dpkg` are stubs first on PATH that record how they
// were called (with the environment apt would see) and answer what each case
// scripts. `timeout`, `env` and `bash` are the real ones, so the time limit is
// really applied.

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/apt-install.sh');
const RELEASE = path.join(ROOT, '.github/workflows/release.yml');

const PACKAGES = [
  'libwebkit2gtk-4.1-dev',
  'librsvg2-dev',
  'patchelf',
  'libssl-dev',
  'libgtk-3-dev',
  'libayatana-appindicator3-dev',
];

/** A bash that understands the paths this test hands it (on Windows: Git's, not WSL's). */
function usableBash(): boolean {
  const probe = spawnSync('bash', ['-c', 'uname -s && command -v timeout && command -v env'], { encoding: 'utf8' });
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
  // One outcome per call, read from APT_PLAN ("ok,fail,..."): ok, fail or hang
  'apt-get': `#!/usr/bin/env bash
count=$(cat "$STUB_DIR/apt.count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$STUB_DIR/apt.count"
echo "apt-get $*|frontend=\${DEBIAN_FRONTEND-unset}" >> "$STUB_LOG"
outcome=$(echo "$APT_PLAN" | cut -d, -f"$count")
case "$outcome" in
  ok) exit 0 ;;
  hang) sleep 60; exit 0 ;;
  *) exit 100 ;;
esac
`,
  dpkg: `#!/usr/bin/env bash
echo "dpkg $*" >> "$STUB_LOG"
exit 0
`,
  // Records the pause, then really waits (REAL_SLEEP: the sleep the PATH had before the stubs)
  sleep: `#!/usr/bin/env bash
echo "sleep $*" >> "$STUB_LOG"
exec "$REAL_SLEEP" "$@"
`,
};

const REAL_SLEEP = spawnSync('bash', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();

describe.runIf(usableBash())('apt-install.sh', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'apt-install-'));
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

  function run(env: Record<string, string>, args: string[] = PACKAGES) {
    const started = Date.now();
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
        STUB_DIR: dir.replace(/\\/g, '/'),
        STUB_LOG: log.replace(/\\/g, '/'),
        APT_PAUSE_SECONDS: '0',
        REAL_SLEEP: REAL_SLEEP,
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const apt = calls.filter((c) => c.startsWith('apt-get '));
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls,
      apt,
      updates: apt.filter((c) => c.startsWith('apt-get update')).length,
      installs: apt.filter((c) => c.startsWith('apt-get install')).length,
      sudo: calls.filter((c) => c.startsWith('sudo ')),
      dpkg: calls.filter((c) => c.startsWith('dpkg ')),
      // The script's own pauses (the hanging apt stub sleeps 60)
      pauses: calls.filter((c) => c.startsWith('sleep ') && c !== 'sleep 60'),
      seconds: (Date.now() - started) / 1000,
    };
  }

  it('updates, installs every package once and stops when the first attempt succeeds', () => {
    const r = run({ APT_PLAN: 'ok,ok' });
    expect(r.status).toBe(0);
    expect(r.apt).toEqual([
      'apt-get update|frontend=noninteractive',
      `apt-get install -y ${PACKAGES.join(' ')}|frontend=noninteractive`,
    ]);
    expect(r.dpkg).toEqual([]);
    expect(r.output).toContain('Packages installed.');
    expect(r.output).not.toContain('::warning::');
  });

  it('runs the attempt as root, behind the time limit', () => {
    const r = run({ APT_PLAN: 'ok,ok', APT_ATTEMPT_SECONDS: '77' });
    expect(r.sudo).toHaveLength(1);
    // The limit must sit INSIDE sudo: a timeout run by the runner's user cannot signal root's apt
    expect(r.sudo[0]).toMatch(/^sudo env DEBIAN_FRONTEND=noninteractive timeout --kill-after=15 77 bash -c /);
    expect(r.sudo[0]).toContain(PACKAGES.join(' '));
  });

  it('retries a failed update, repairing dpkg in between, and succeeds', () => {
    const r = run({ APT_PLAN: 'fail,ok,ok' });
    expect(r.status).toBe(0);
    // The failed update skips its install
    expect(r.updates).toBe(2);
    expect(r.installs).toBe(1);
    expect(r.dpkg).toEqual(['dpkg --configure -a']);
    expect(r.output).toContain('::warning::apt-get: attempt 1 of 3 failed');
  });

  it('retries a failed install and succeeds on the third attempt', () => {
    const r = run({ APT_PLAN: 'ok,fail,ok,fail,ok,ok' });
    expect(r.status).toBe(0);
    expect(r.updates).toBe(3);
    expect(r.installs).toBe(3);
    expect(r.dpkg).toHaveLength(2);
  });

  it('fails the step with the reason after one attempt and two retries', () => {
    const r = run({ APT_PLAN: 'ok,fail,ok,fail,ok,fail,ok,ok' });
    expect(r.status).toBe(1);
    expect(r.installs).toBe(3);
    expect(r.output).toContain('::warning::apt-get: attempt 3 of 3 failed');
    expect(r.output).toContain('::error::The packages could not be installed in 3 attempts');
    expect(r.output).not.toContain('Packages installed.');
  });

  it('pauses between attempts, never after the last one', () => {
    const r = run({ APT_PLAN: 'fail,fail,fail', APT_PAUSE_SECONDS: '1' });
    expect(r.status).toBe(1);
    expect(r.updates).toBe(3);
    // After attempts 1 and 2, the configured length, and really waited
    expect(r.pauses).toEqual(['sleep 1', 'sleep 1']);
    expect(r.seconds).toBeGreaterThanOrEqual(2);
  });

  it('stops an attempt that passes its limit, counts it as failed, and goes on', () => {
    // The first update would sleep for a minute; the limit is one second
    const r = run({ APT_PLAN: 'hang,ok,ok', APT_ATTEMPT_SECONDS: '1' });
    expect(r.status).toBe(0);
    expect(r.updates).toBe(2);
    expect(r.output).toContain('attempt 1 of 3 failed or passed its 1s limit');
    expect(r.seconds).toBeLessThan(30);
  });

  it('refuses to run with no package, or with something that is not a package name', () => {
    for (const args of [[], ['-o', 'APT::Get::AllowUnauthenticated=true'], ['libssl-dev', 'evil; rm -rf /'], ['Libssl']]) {
      rmSync(log, { force: true });
      const r = run({ APT_PLAN: 'ok,ok' }, args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.calls, JSON.stringify(args)).toEqual([]);
      expect(r.output).toContain('::error::apt-install.sh:');
    }
  });
});

describe('the release build installs its Linux packages through the bounded script', () => {
  const release = readFileSync(RELEASE, 'utf8').replace(/\r\n/g, '\n');

  /** The lines of one step, from its `- name:` to the next step. */
  function step(name: string): string {
    const start = release.indexOf(`      - name: ${name}\n`);
    expect(start, `step "${name}" not found in release.yml`).toBeGreaterThan(-1);
    const next = release.indexOf('\n      - name: ', start + 1);
    return release.slice(start, next === -1 ? undefined : next);
  }

  /** The command of a `run: >-` folded block: its lines joined by single spaces. */
  function foldedRun(stepText: string): string {
    const lines = stepText.split('\n');
    const at = lines.findIndex((l) => l === '        run: >-');
    expect(at, 'a folded run block').toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith('          ')) break;
      body.push(line.trim());
    }
    return body.join(' ');
  }

  it('calls the script on Linux only, with the same six packages as before', () => {
    const s = step('Install Linux system dependencies');
    expect(s).toContain("if: matrix.os == 'ubuntu-latest'");
    expect(foldedRun(s)).toBe(`bash .github/scripts/apt-install.sh ${PACKAGES.join(' ')}`);
  });

  it('no workflow calls apt-get without the bound', () => {
    const workflows = path.join(ROOT, '.github/workflows');
    for (const file of ['ci.yml', 'release.yml', 'docker.yml', 'desktop-shell.yml', 'crypto-deps-watch.yml']) {
      const text = readFileSync(path.join(workflows, file), 'utf8')
        .split(/\r?\n/)
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      expect(text, file).not.toMatch(/\bapt-get\b/);
    }
  });

  it("the script's worst case fits inside the step limit, and the step inside the job's", () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const attempts = Number(/APT_ATTEMPTS:-(\d+)/.exec(script)?.[1]);
    const seconds = Number(/APT_ATTEMPT_SECONDS:-(\d+)/.exec(script)?.[1]);
    const pause = Number(/APT_PAUSE_SECONDS:-(\d+)/.exec(script)?.[1]);
    // One attempt and two retries
    expect(attempts).toBe(3);
    const stepMinutes = Number(/timeout-minutes: (\d+)/.exec(step('Install Linux system dependencies'))?.[1]);
    const jobMinutes = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(release)?.[1]);
    // Every attempt at its limit plus its kill grace, the pauses, and a minute for dpkg
    const worstSeconds = attempts * (seconds + 15) + (attempts - 1) * pause + 60;
    expect(worstSeconds).toBeLessThan(stepMinutes * 60);
    expect(stepMinutes).toBeLessThan(jobMinutes);
  });
});
