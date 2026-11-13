import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .github/scripts/e2e-quarantine.sh, the CI step that runs the specs tagged
// @quarantine (non-blocking), and the "No concurrent queries" step that reads
// what that run left. The script runs for real under bash; `npx` is a stub
// first on PATH that records each call and answers the listing each case
// scripts. The check step's own `run:` block is taken out of ci.yml and run
// as it is written there.

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/e2e-quarantine.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');

/** A bash that understands the paths this test hands it (on Windows: Git's, not WSL's). */
function usableBash(): boolean {
  const probe = spawnSync('bash', ['-c', 'uname -s && command -v sed && command -v grep'], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const kernel = probe.stdout.split('\n')[0].trim();
  return process.platform === 'win32' ? /^(MINGW|MSYS)/.test(kernel) : true;
}

/** Forward slashes: Git's bash on Windows reads them as well as a Unix one does. */
const slash = (p: string) => p.replace(/\\/g, '/');

// A `--list` call prints LIST_FILE and exits LIST_STATUS; any other call is the run
const NPX_STUB = `#!/usr/bin/env bash
if printf '%s\\n' "$@" | grep -qx -- '--list'; then
  echo "list|$*|report=\${PG_OVERLAP_REPORT-unset}" >> "$STUB_LOG"
  cat "$LIST_FILE"
  exit "\${LIST_STATUS:-0}"
fi
echo "run|$*|report=\${PG_OVERLAP_REPORT-unset}|node_options=\${NODE_OPTIONS-unset}" >> "$STUB_LOG"
exit "\${RUN_STATUS:-0}"
`;

const NOTHING_TAGGED = 'Listing tests:\nTotal: 0 tests in 0 files\n';
const ONE_TAGGED =
  'Listing tests:\n  [chromium] › flaky.spec.ts:12:3 › something @quarantine\nTotal: 1 test in 1 file\n';

const workflow = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

/** The lines of one step, from its `- name:` to the next step. */
function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  expect(start, `step "${name}" not found in ci.yml`).toBeGreaterThan(-1);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

/** The `run: |` block of a step, unindented: the shell script the runner executes. */
function runBlock(name: string): string {
  const lines = step(name).split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at, `step "${name}" has no run block`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

describe.runIf(usableBash())('e2e-quarantine.sh', () => {
  let dir: string;
  let log: string;
  let output: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-quarantine-'));
    log = path.join(dir, 'calls.log');
    output = path.join(dir, 'github_output');
    const stub = path.join(dir, 'npx');
    writeFileSync(stub, NPX_STUB, { encoding: 'utf8' });
    chmodSync(stub, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(listing: string, env: Record<string, string> = {}, args = ['--reporter=github,line']) {
    const listFile = path.join(dir, 'listing.txt');
    writeFileSync(listFile, listing, { encoding: 'utf8' });
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
        STUB_LOG: slash(log),
        LIST_FILE: slash(listFile),
        GITHUB_OUTPUT: slash(output),
        PG_OVERLAP_REPORT: '/runner/temp/pg-overlaps-quarantine.jsonl',
        NODE_OPTIONS: '--trace-deprecation',
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      lists: calls.filter((c) => c.startsWith('list|')),
      runs: calls.filter((c) => c.startsWith('run|')),
      recorded: existsSync(output) ? readFileSync(output, 'utf8') : '',
    };
  }

  it('starts nothing when no spec is tagged, and records that it did not run', () => {
    const r = run(NOTHING_TAGGED);
    expect(r.status).toBe(0);
    expect(r.lists).toHaveLength(1);
    expect(r.runs).toEqual([]);
    expect(r.recorded).toBe('ran=false\n');
    expect(r.output).toContain('No spec is tagged @quarantine: nothing to run, so the stack is not started.');
  });

  it('lists with the list reporter and the overlap guard disarmed', () => {
    const r = run(NOTHING_TAGGED);
    // The listing is not part of the measured run: an empty report path leaves the guard off
    expect(r.lists[0]).toBe('list|playwright test --grep @quarantine --list --pass-with-no-tests --reporter=list|report=');
  });

  it('runs a tagged spec with the reporters it is given and the environment it was started with', () => {
    const r = run(ONE_TAGGED);
    expect(r.status).toBe(0);
    expect(r.runs).toEqual([
      'run|playwright test --grep @quarantine --pass-with-no-tests --reporter=github,line' +
        '|report=/runner/temp/pg-overlaps-quarantine.jsonl|node_options=--trace-deprecation',
    ]);
    expect(r.recorded).toBe('ran=true\n');
    // The log names what is quarantined
    expect(r.output).toContain('flaky.spec.ts:12:3');
  });

  it('fails the step when a quarantined spec fails', () => {
    const r = run(ONE_TAGGED, { RUN_STATUS: '1' });
    expect(r.status).toBe(1);
    expect(r.runs).toHaveLength(1);
    expect(r.recorded).toBe('ran=true\n');
  });

  it('runs the specs anyway when the listing fails', () => {
    const r = run('Error: something broke while loading the config\n', { LIST_STATUS: '1' });
    expect(r.status).toBe(0);
    expect(r.runs).toHaveLength(1);
    expect(r.recorded).toBe('ran=true\n');
    expect(r.output).toContain('::warning::Listing the @quarantine specs failed (exit 1); running them anyway.');
  });

  it('never reads a failed listing as an empty one', () => {
    const r = run(NOTHING_TAGGED, { LIST_STATUS: '1' });
    expect(r.runs).toHaveLength(1);
    expect(r.recorded).toBe('ran=true\n');
  });

  it('runs the specs anyway when it cannot read the listing', () => {
    for (const listing of ['', 'Listing tests:\n', 'Total: zero tests\n', 'Total: 0 tests in 0 files and more\n']) {
      rmSync(log, { force: true });
      rmSync(output, { force: true });
      const r = run(listing);
      expect(r.runs, JSON.stringify(listing)).toHaveLength(1);
      expect(r.recorded).toBe('ran=true\n');
    }
  });

  it('reads an empty listing through colour codes and carriage returns', () => {
    const r = run('Listing tests:\r\n\u001b[2mTotal: 0 tests in 0 files\u001b[22m\r\n');
    expect(r.runs).toEqual([]);
    expect(r.recorded).toBe('ran=false\n');
  });

  it('works without a GITHUB_OUTPUT, as on a developer machine', () => {
    const r = run(NOTHING_TAGGED, { GITHUB_OUTPUT: '' });
    expect(r.status).toBe(0);
    expect(r.runs).toEqual([]);
    expect(existsSync(output)).toBe(false);
  });
});

describe('the end-to-end job runs the quarantined specs through the script', () => {
  it('keeps the step non-blocking, bounded, with an overlap report of its own', () => {
    const q = step('E2E quarantined specs (non-blocking)');
    expect(q).toContain('id: quarantine');
    expect(q).toContain('continue-on-error: true');
    expect(q).toContain('run: bash .github/scripts/e2e-quarantine.sh --reporter=github,line');
    expect(q).toContain('NODE_OPTIONS: --require ${{ github.workspace }}/scripts/lib/pg-overlap-guard.cjs');
    expect(q).toContain('PG_OVERLAP_REPORT: ${{ runner.temp }}/pg-overlaps-quarantine.jsonl');
    // A hang must end inside the job's limit, or the non-blocking step fails the job
    const stepLimit = Number(/timeout-minutes: (\d+)/.exec(q)?.[1]);
    const jobLimit = Number(/\n {2}e2e:\n[\s\S]*?\n {4}timeout-minutes: (\d+)\n/.exec(workflow)?.[1]);
    expect(stepLimit).toBeGreaterThan(0);
    expect(stepLimit).toBeLessThan(jobLimit);
  });

  it('hands the check step whether the quarantined run happened', () => {
    expect(step('No concurrent queries on one pg connection')).toContain(
      'QUARANTINE_RAN: ${{ steps.quarantine.outputs.ran }}',
    );
  });
});

describe.runIf(usableBash())('the "No concurrent queries" step', () => {
  let dir: string;
  const script = runBlock('No concurrent queries on one pg connection');
  const SERVER = '{"pid":1,"argv":["/w/apps/server/src/index.ts"]}\n';
  const RECORD = '{"pid":1,"query":"SELECT 1","active":"SELECT 2"}\n';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pg-overlap-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the step with these report files (absent when not given) and this `ran` output. */
  function check(files: Record<string, string>, ran: string) {
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body, { encoding: 'utf8' });
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        REPORT: slash(path.join(dir, 'main.jsonl')),
        QUARANTINE_REPORT: slash(path.join(dir, 'quarantine.jsonl')),
        QUARANTINE_RAN: ran,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const clean = { 'main.jsonl': '', 'main.jsonl.armed': SERVER };

  it('says nothing about the quarantined run when no spec was tagged', () => {
    const r = check(clean, 'false');
    expect(r.status).toBe(0);
    expect(r.output).toContain('No spec is tagged @quarantine: no quarantined run to check.');
    expect(r.output).not.toContain('::warning::');
  });

  it('warns, without failing, when a quarantined run never armed the guard in the server', () => {
    for (const ran of ['true', '']) {
      const r = check(clean, ran);
      expect(r.status, `ran=${JSON.stringify(ran)}`).toBe(0);
      expect(r.output).toContain('::warning::the pg overlap guard did not arm in the server during the quarantined specs');
    }
  });

  it("reports a quarantined run's overlaps as a warning only", () => {
    const r = check({ ...clean, 'quarantine.jsonl': RECORD, 'quarantine.jsonl.armed': SERVER }, 'true');
    expect(r.status).toBe(0);
    expect(r.output).toContain('::warning::1 pg queries issued on a busy client during the quarantined specs');
    expect(r.output).not.toContain('did not arm');
  });

  it('still fails on an overlap in the blocking run when the quarantined run was skipped', () => {
    const r = check({ 'main.jsonl': RECORD, 'main.jsonl.armed': SERVER }, 'false');
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::1 pg queries issued on a busy client');
  });

  it('still fails when the guard never armed in the blocking run, whatever the quarantined run did', () => {
    const r = check({ 'main.jsonl': '' }, 'false');
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::the pg overlap guard never armed in the server process');
  });

  it('passes a clean, armed blocking run', () => {
    const r = check(clean, 'false');
    expect(r.output).toContain('No query was issued on a busy pg client (guard armed in: 1 server process(es)).');
  });
});
