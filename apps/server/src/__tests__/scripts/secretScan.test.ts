import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ci.yml's Security Scan: the range .github/scripts/secret-scan.sh gives
// gitleaks, and the job that runs it. gitleaks-action v3.0.0 listed a pull
// request's commits without paging and scanned `--no-merges --first-parent
// <first>^..<30th>`, so a long pull request was scanned up to its 30th commit,
// a merged branch's commits never, and a merge-commit push not at all. The
// script runs here under bash in real git repositories, with a stand-in
// gitleaks that records how it was called.

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/secret-scan.sh');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** One job of ci.yml: from its key to the next job's. */
function jobOf(job: string): string {
  const start = ci.indexOf(`\n  ${job}:\n`);
  expect(start, job).toBeGreaterThan(-1);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

/** The steps of a job: each one's name and text up to the next step. */
const stepsOf = (job: string) =>
  job.split('\n      - name: ').slice(1).map((text) => ({ name: text.slice(0, text.indexOf('\n')), text }));

const security = jobOf('security');
const steps = stepsOf(security);
const step = (name: string) => {
  const found = steps.find((s) => s.name === name);
  expect(found, name).toBeDefined();
  return found!.text;
};

describe('the Security Scan job', () => {
  it('runs gitleaks itself, not gitleaks-action, in every workflow', () => {
    const workflows = readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows).toContain('ci.yml');
    for (const file of workflows) expect(read(file), file).not.toMatch(/gitleaks\/gitleaks-action/);
    expect(security).not.toContain('secrets.GITHUB_TOKEN');
    expect(security).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}steps:/);
  });

  it('checks out the whole history, so the range is in the clone', () => {
    expect(step('Checkout')).toContain('          fetch-depth: 0\n');
  });

  it('installs the pinned release, checked against its published checksum, bounded', () => {
    const install = step('Install gitleaks');
    expect(install).toMatch(/\n {10}GITLEAKS_VERSION: \d+\.\d+\.\d+ # tag v\d+\.\d+\.\d+\n/);
    const version = /GITLEAKS_VERSION: (\S+)/.exec(install)![1];
    expect(install).toContain(`# tag v${version}`);
    expect(install).toMatch(/\n {10}GITLEAKS_SHA256: [0-9a-f]{64}\n/);
    expect(install).toContain('https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz');
    expect(install).toContain('echo "$GITLEAKS_SHA256  $archive" | sha256sum -c -');
    expect(install.indexOf('sha256sum -c')).toBeLessThan(install.indexOf('tar -xzf'));
    expect(install).toMatch(/curl -fsSL --max-time \d+ /);
    expect(Number(/timeout-minutes: (\d+)/.exec(install)?.[1])).toBeLessThanOrEqual(5);
  });

  it('scans the base-to-head range of a pull request and the before-to-after range of a push, from env', () => {
    const scan = step('Gitleaks (secrets detection)');
    expect(scan).toContain('          EVENT_NAME: ${{ github.event_name }}\n');
    expect(scan).toContain('          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n');
    expect(scan).toContain('          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n');
    expect(scan).toContain('          BEFORE_SHA: ${{ github.event.before }}\n');
    expect(scan).toContain('          AFTER_SHA: ${{ github.event.after }}\n');
    expect(scan).toContain('        run: bash .github/scripts/secret-scan.sh "$RUNNER_TEMP/gitleaks"\n');
    // the only expressions are those five, none in the script line
    expect(scan.match(/\$\{\{.*?\}\}/g)).toHaveLength(5);
    expect(readFileSync(SCRIPT, 'utf8')).toContain('range="$BASE_SHA..$HEAD_SHA"');
    expect(readFileSync(SCRIPT, 'utf8')).toContain('range="$before..$AFTER_SHA"');
  });

  it('may not fail quietly or be skipped: no continue-on-error, no condition, no path filter', () => {
    for (const s of steps) {
      expect(s.text, s.name).not.toMatch(/continue-on-error/);
      expect(s.text, s.name).not.toMatch(/^ {8}if: /m);
    }
    expect(security).not.toMatch(/^ {4}(if|continue-on-error): /m);
    const on = ci.slice(ci.indexOf('\non:\n'), ci.indexOf('\npermissions:'));
    expect(on).not.toMatch(/paths(-ignore)?:|branches-ignore:/);
    expect(on).toMatch(/\n {2}pull_request:\n/);
    // and the gate needs it
    expect(jobOf('ci-ok')).toMatch(/needs: \[[^\]]*\bsecurity\b[^\]]*\]/);
  });

  it('reads what merges add (--remerge-diff), after checking git can', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('--log-opts="--remerge-diff $range"');
    expect(script.indexOf('git 2.36 or later is needed')).toBeLessThan(script.indexOf('--log-opts='));
  });

  it('runs every develop push to the end: a push gets a concurrency group of its own, a pull request cancels its older runs', () => {
    // A shared group with cancel-in-progress off would still lose pushes:
    // GitHub cancels a run that is still PENDING in the group when a newer one
    // queues, so of three quick pushes the middle one would never run
    const head = ci.slice(ci.indexOf('\nconcurrency:\n'), ci.indexOf('\njobs:\n'));
    expect(head).toContain("\n  group: ci-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}\n");
    expect(head).toContain("\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n");
    // ci.yml runs on pushes and pull requests only, so 'pr' or the pushed commit is every case
    const on = ci.slice(ci.indexOf('\non:\n'), ci.indexOf('\npermissions:'));
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(['  push:', '  pull_request:']);
    // no job sets a concurrency of its own that could cancel it
    for (const job of ['lint-typecheck', 'e2e', 'security', 'build', 'ci-ok']) expect(jobOf(job), job).not.toMatch(/^ {4}concurrency:/m);
  });
});

function read(file: string) {
  return readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
}

const bashWorks = spawnSync('bash', ['-c', 'git --version']).status === 0;

describe.runIf(bashWorks)('secret-scan.sh', () => {
  let dir: string;
  let repo: string;
  let stub: string;
  let calls: string;
  const sha: Record<string, string> = {};
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
    return r.stdout.trim();
  };
  const commit = (name: string) => {
    writeFileSync(path.join(repo, `${name}.txt`), name);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    sha[name] = git('rev-parse', 'HEAD');
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-'));
    repo = path.join(dir, 'repo');
    calls = path.join(dir, 'calls');
    stub = path.join(dir, 'gitleaks');
    // records its arguments one per line, exits with STUB_EXIT
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${calls.replace(/\\/g, '/')}'\nexit "\${STUB_EXIT:-0}"\n`);
    chmodSync(stub, 0o755);
    spawnSync('git', ['init', '-q', '-b', 'main', repo]);
    commit('base');
    git('checkout', '-q', '-b', 'feature');
    commit('one');
    git('checkout', '-q', '-b', 'side');
    commit('side');
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    commit('two');
    sha.merge = git('rev-parse', 'HEAD~1');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function scan(env: Record<string, string>) {
    rmSync(calls, { force: true });
    const result = spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), stub.replace(/\\/g, '/')], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, EVENT_NAME: '', BASE_SHA: '', HEAD_SHA: '', BEFORE_SHA: '', AFTER_SHA: '', ...env },
    });
    const args = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : null;
    return { ...result, args, logOpts: args?.find((a) => a.startsWith('--log-opts='))?.slice('--log-opts='.length) };
  }


  it('a pull request: every commit from its base to its head, the merged branch included, merges read', () => {
    const r = scan({ EVENT_NAME: 'pull_request', BASE_SHA: sha.base, HEAD_SHA: sha.two });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    // --remerge-diff: what a merge holds beyond merging its parents again
    expect(r.logOpts).toBe(`--remerge-diff ${sha.base}..${sha.two}`);
    // one, side, the merge, two: nothing first-parent or paged about it
    expect(r.stdout).toContain(`Scanning 4 commits: ${sha.base}..${sha.two}`);
    expect(r.args).toEqual(expect.arrayContaining(['git', '--redact', '--config', '.gitleaks.toml', '--gitleaks-ignore-path', '.gitleaksignore']));
    expect(r.args![r.args!.length - 1]).toBe('.');
  });

  it('a push: every commit from the previous tip to the pushed one, merges included', () => {
    const r = scan({ EVENT_NAME: 'push', BEFORE_SHA: sha.one, AFTER_SHA: sha.two });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.logOpts).toBe(`--remerge-diff ${sha.one}..${sha.two}`);
    expect(r.stdout).toContain('Scanning 3 commits');
  });

  it('a merge-commit push: the merged commits, not zero', () => {
    const r = scan({ EVENT_NAME: 'push', BEFORE_SHA: sha.one, AFTER_SHA: sha.merge });
    expect(r.logOpts).toBe(`--remerge-diff ${sha.one}..${sha.merge}`);
    expect(r.stdout).toContain('Scanning 2 commits');
  });

  it('the first push of a branch (before all zeros): every commit reachable from the pushed one', () => {
    const r = scan({ EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40), AFTER_SHA: sha.two });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe(`--remerge-diff ${sha.two}`);
    expect(r.stdout).toContain('A new branch');
    expect(r.stdout).toContain('Scanning 5 commits');
  });

  it('a force-push whose old tip the clone does not hold: every commit reachable from the pushed one', () => {
    const r = scan({ EVENT_NAME: 'push', BEFORE_SHA: 'ab'.repeat(20), AFTER_SHA: sha.two });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe(`--remerge-diff ${sha.two}`);
    expect(r.stdout).toContain('force-push');
  });

  it('any other event: every commit reachable from HEAD', () => {
    const r = scan({ EVENT_NAME: 'workflow_dispatch' });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe('--remerge-diff HEAD');
  });

  it('passes gitleaks\' failure on: a finding fails the step', () => {
    const r = scan({ EVENT_NAME: 'pull_request', BASE_SHA: sha.base, HEAD_SHA: sha.two, STUB_EXIT: '1' });
    expect(r.status).toBe(1);
  });

  /** A refusal: the step fails with an error line, and gitleaks never ran. */
  const refused = (r: ReturnType<typeof scan>, message: string) => {
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toContain(`::error::${message}`);
    expect(r.args).toBeNull();
    expect(existsSync(path.join(repo, 'pwned'))).toBe(false);
  };

  it('refuses a real commit id shortened (git would resolve it), by its format', () => {
    const short = sha.base.slice(0, 12);
    expect(git('rev-parse', '--verify', `${short}^{commit}`)).toBe(sha.base);
    refused(scan({ EVENT_NAME: 'pull_request', BASE_SHA: short, HEAD_SHA: sha.two }), `the pull request's base commit '${short}' is not a full commit id`);
  });

  it('refuses a real commit id in upper case (git would resolve it), by its format', () => {
    const upper = sha.two.toUpperCase();
    refused(scan({ EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40), AFTER_SHA: upper }), `the pushed commit '${upper}' is not a full commit id`);
  });

  it('refuses a previous tip that is not a commit id, instead of taking it for a force-push', () => {
    refused(scan({ EVENT_NAME: 'push', BEFORE_SHA: 'develop', AFTER_SHA: sha.two }), "the previous tip 'develop' is not a full commit id");
  });

  it.each([
    ['a missing base', { EVENT_NAME: 'pull_request', HEAD_SHA: 'HEAD' }, "the pull request's base commit '' is not a full commit id"],
    ['a branch name for a commit', { EVENT_NAME: 'pull_request', BASE_SHA: 'main', HEAD_SHA: 'feature' }, "the pull request's base commit 'main' is not a full commit id"],
    ['a command in the value', { EVENT_NAME: 'pull_request', BASE_SHA: '$(touch pwned)', HEAD_SHA: '`touch pwned`' }, "the pull request's base commit '$(touch pwned)' is not a full commit id"],
    ['a pushed commit the clone does not hold', { EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40), AFTER_SHA: 'cd'.repeat(20) }, `the pushed commit '${'cd'.repeat(20)}' is not in this clone`],
  ])('refuses %s, before gitleaks runs', (_label, env, message) => {
    refused(scan(env as Record<string, string>), message);
  });

  it('refuses a git older than 2.36, which cannot read what a merge adds', () => {
    // A git first on PATH that answers its version as 2.35 and does nothing else
    const bin = path.join(dir, 'old-git');
    rmSync(bin, { recursive: true, force: true });
    spawnSync('bash', ['-c', `mkdir -p '${bin.replace(/\\/g, '/')}'`]);
    writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\necho "git version 2.35.8"\n');
    chmodSync(path.join(bin, 'git'), 0o755);
    rmSync(calls, { force: true });
    const r = spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), stub.replace(/\\/g, '/')], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, EVENT_NAME: 'pull_request', BASE_SHA: sha.base, HEAD_SHA: sha.two },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::git 2.36 or later is needed to read what merges add (--remerge-diff); this is 'git version 2.35.8'");
    expect(existsSync(calls), 'gitleaks ran').toBe(false);
  });
});
