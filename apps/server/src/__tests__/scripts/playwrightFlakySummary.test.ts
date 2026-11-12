import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .github/scripts/playwright-flaky-summary.mjs, the end-to-end job's list of
// tests that failed and then passed on a retry. The script runs for real
// under node, on reports shaped like Playwright's JSON reporter writes them
// (the shape was taken from a real 1.65 report), and once on a report real
// Playwright writes for a probe spec that needs no browser and no server.

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/playwright-flaky-summary.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const RESET = '\u001b[39m';

type Result = { status: string; retry: number; error?: { message: string } };
const spec = (title: string, line: number, status: string, results: Result[], file = 'admin-flow.spec.ts') => ({
  title,
  ok: status !== 'unexpected',
  tags: [],
  id: `${file}-${line}`,
  file,
  line,
  column: 3,
  tests: [{ timeout: 60000, annotations: [], expectedStatus: 'passed', projectId: 'chromium', projectName: 'chromium', status, results }],
});
const failedThenPassed = (message: string, failures = 1): Result[] => [
  ...Array.from({ length: failures }, (_, retry) => ({ status: 'failed', retry, error: { message } })),
  { status: 'passed', retry: failures },
];

/** A report: one file suite with top-level specs and one describe block. */
function report(rootDir: string, opts: { top?: unknown[]; grouped?: unknown[]; stats?: Record<string, number> } = {}) {
  return {
    config: { rootDir },
    suites: [
      {
        title: 'admin-flow.spec.ts',
        file: 'admin-flow.spec.ts',
        line: 0,
        column: 0,
        specs: opts.top ?? [],
        suites: [{ title: 'Admin flow', file: 'admin-flow.spec.ts', line: 8, column: 6, specs: opts.grouped ?? [], suites: [] }],
      },
    ],
    errors: [],
    stats: { expected: 72, skipped: 0, unexpected: 0, flaky: 0, ...opts.stats },
  };
}

describe('playwright-flaky-summary.mjs', () => {
  let dir: string;
  let summaryFile: string;
  // Reports name their files relative to the test directory, as the real ones do
  let e2eDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flaky-summary-'));
    summaryFile = path.join(dir, 'summary.md');
    e2eDir = path.join(dir, 'tests', 'e2e');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: unknown) {
    const file = path.join(dir, name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return file;
  }

  function run(args: string[], env: Record<string, string> = { GITHUB_STEP_SUMMARY: summaryFile }) {
    const { GITHUB_STEP_SUMMARY: _drop, ...rest } = process.env;
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...rest, ...env },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      warnings: result.stdout.split('\n').filter((l) => l.startsWith('::warning')),
      summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '',
    };
  }

  it('says no test needed a retry, with the counts, and warns about nothing', () => {
    const file = write('chromium.json', report(e2eDir, { grouped: [spec('full admin flow', 9, 'expected', [{ status: 'passed', retry: 0 }])] }));
    const r = run([`Chromium=${file}`]);
    expect(r.status).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.stdout).toContain('No end-to-end test needed a retry.');
    expect(r.summary).toContain('## End-to-end tests that passed only on a retry');
    expect(r.summary).toContain('None: every test passed at its first attempt.');
    expect(r.summary).toContain('- Chromium: 72 passed, 0 flaky, 0 failed, 0 skipped.');
  });

  it('warns on the flaky test\'s own line and lists it in the summary, without failing', () => {
    const file = write(
      'chromium.json',
      report(e2eDir, {
        grouped: [
          spec('full admin flow', 9, 'flaky', failedThenPassed(`Error: ${DIM}expect(${RESET}${RED}locator${RESET}) failed\n\nCall log:\n  - waiting`)),
          spec('steady', 40, 'expected', [{ status: 'passed', retry: 0 }]),
        ],
        stats: { expected: 72, flaky: 1 },
      }),
    );
    const r = run([`Chromium=${file}`]);
    expect(r.status).toBe(0);
    expect(r.warnings).toEqual([
      '::warning file=tests/e2e/admin-flow.spec.ts,line=9,title=Flaky test (Chromium)::Admin flow › full admin flow failed 1 time(s), then passed on retry 1: Error: expect(locator) failed',
    ]);
    expect(r.stdout).toContain('1 end-to-end test(s) passed only on a retry');
    expect(r.summary).toContain('| Run | Test | Failed attempts | First error |');
    expect(r.summary).toContain('| Chromium | `tests/e2e/admin-flow.spec.ts:9` Admin flow › full admin flow | 1 | Error: expect(locator) failed |');
    expect(r.summary).toContain('- Chromium: 72 passed, 1 flaky, 0 failed, 0 skipped.');
    expect(r.summary).not.toContain('steady');
  });

  it('counts every failed attempt before the pass', () => {
    const file = write('chromium.json', report(e2eDir, { top: [spec('top level', 3, 'flaky', failedThenPassed('Error: twice', 2))] }));
    const r = run([`Chromium=${file}`]);
    expect(r.warnings[0]).toContain('::top level failed 2 time(s), then passed on retry 2: Error: twice');
  });

  it('lists neither a failed test nor a skipped one: only the ones that passed on a retry', () => {
    const file = write(
      'chromium.json',
      report(e2eDir, {
        top: [
          spec('broken', 3, 'unexpected', [0, 1, 2].map((retry) => ({ status: 'failed', retry, error: { message: 'Error: no' } }))),
          spec('skipped', 5, 'skipped', [{ status: 'skipped', retry: 0 }]),
        ],
      }),
    );
    const r = run([`Chromium=${file}`]);
    expect(r.status).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.summary).toContain('None: every test passed at its first attempt.');
  });

  it('reads every run it is given, labelled, and says which report is missing or unreadable', () => {
    const chromium = write('chromium.json', report(e2eDir, { grouped: [spec('full admin flow', 9, 'flaky', failedThenPassed('Error: a'))] }));
    const firefox = write('firefox.json', report(e2eDir, { top: [spec('secure voice', 12, 'flaky', failedThenPassed('Error: b'), 'secure-voice.spec.ts')] }));
    const broken = write('broken.json', '{ not json');
    const r = run([`Chromium=${chromium}`, `Firefox secure voice=${firefox}`, `Broken=${broken}`, `Missing=${path.join(dir, 'nowhere.json')}`]);
    expect(r.status).toBe(0);
    expect(r.warnings.filter((w) => w.includes('title=Flaky test'))).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('file=tests/e2e/secure-voice.spec.ts,line=12,title=Flaky test (Firefox secure voice)'))).toBe(true);
    expect(r.summary).toContain('| Firefox secure voice | `tests/e2e/secure-voice.spec.ts:12` secure voice | 1 | Error: b |');
    expect(r.summary).toMatch(/- Broken: unreadable report \(/);
    expect(r.summary).toContain('- Missing: no report (the step did not finish).');
    expect(r.warnings.some((w) => w.startsWith('::warning title=Playwright report::Missing: no report'))).toBe(true);
  });

  it('escapes what would break an annotation or a table row', () => {
    const file = write(
      'chromium.json',
      report(e2eDir, { top: [spec('50% done, then: a | b', 3, 'flaky', failedThenPassed('Error: x | y'))] }),
    );
    const r = run(['Run, with: punctuation=' + file]);
    expect(r.warnings[0]).toContain('title=Flaky test (Run%2C with%3A punctuation)::');
    expect(r.warnings[0]).toContain('::50%25 done, then: a | b failed 1 time(s)');
    expect(r.summary).toContain('50% done, then: a \\| b | 1 | Error: x \\| y |');
  });

  it('prints the summary when there is no job summary to write to', () => {
    const file = write('chromium.json', report(e2eDir));
    const r = run([`Chromium=${file}`], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('## End-to-end tests that passed only on a retry');
  });

  it('refuses an argument that is not label=path', () => {
    const r = run(['chromium.json']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});

/** The repository's Playwright, to write a real report (no browser, no server needed). */
function playwright(): { cli: string; entry: string } | null {
  try {
    const req = createRequire(path.join(ROOT, 'package.json'));
    return { cli: req.resolve('@playwright/test/cli'), entry: req.resolve('@playwright/test') };
  } catch {
    return null;
  }
}
const pw = playwright();

describe.runIf(pw !== null)('on a report real Playwright writes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flaky-real-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the test that passed on its retry, and only that one', () => {
    // CommonJS, so the probe can require the repository's @playwright/test by its absolute path
    const entry = JSON.stringify(pw!.entry);
    writeFileSync(
      path.join(dir, 'probe.config.cjs'),
      `const { defineConfig } = require(${entry});\nmodule.exports = defineConfig({ testDir: '.', retries: 2, workers: 1, outputDir: './out' });\n`,
    );
    writeFileSync(
      path.join(dir, 'probe.spec.cjs'),
      [
        `const { test, expect } = require(${entry});`,
        "test.describe('a group', () => {",
        "  test('passes on its second attempt', () => { expect(test.info().retry, 'the first attempt fails').toBeGreaterThan(0); });",
        "  test('always passes', () => {});",
        '});',
        "test('always fails', () => { expect(1).toBe(2); });",
        '',
      ].join('\n'),
    );
    const reportFile = path.join(dir, 'report.json');
    const pwRun = spawnSync(process.execPath, [pw!.cli, 'test', '-c', path.join(dir, 'probe.config.cjs'), '--reporter=json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, CI: '', PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
    });
    // One test fails on purpose
    expect(pwRun.status, pwRun.stderr).toBe(1);
    expect(existsSync(reportFile)).toBe(true);

    const summaryFile = path.join(dir, 'summary.md');
    const r = spawnSync(process.execPath, [SCRIPT, `Chromium=${reportFile}`], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    });
    expect(r.status).toBe(0);
    const warnings = r.stdout.split('\n').filter((l) => l.startsWith('::warning'));
    expect(warnings).toEqual([
      '::warning file=probe.spec.cjs,line=3,title=Flaky test (Chromium)::a group › passes on its second attempt failed 1 time(s), then passed on retry 1: Error: the first attempt fails',
    ]);
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('| Chromium | `probe.spec.cjs:3` a group › passes on its second attempt | 1 | Error: the first attempt fails |');
    expect(summary).toContain('- Chromium: 1 passed, 1 flaky, 1 failed, 0 skipped.');
  });
});

describe('the end-to-end job lists the tests that passed only on a retry', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

  function step(name: string): string {
    const start = workflow.indexOf(`      - name: ${name}`);
    expect(start, `step "${name}"`).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - name: ', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  }

  it('each blocking run writes a JSON report of its own', () => {
    const chromium = step('E2E tests (Chromium)');
    const firefox = step('E2E secure voice (Firefox');
    expect(chromium).toContain('PLAYWRIGHT_JSON_OUTPUT_FILE: ${{ runner.temp }}/playwright-chromium.json');
    expect(chromium).toMatch(/--reporter=github,line,json\n/);
    expect(firefox).toContain('PLAYWRIGHT_JSON_OUTPUT_FILE: ${{ runner.temp }}/playwright-firefox.json');
    expect(firefox).toMatch(/--reporter=github,line,json\n/);
  });

  it('a step after them reads both, even when one failed, and cannot fail the job', () => {
    const s = step('Tests that passed only on a retry');
    expect(workflow.indexOf('- name: Tests that passed only on a retry')).toBeGreaterThan(
      workflow.indexOf('- name: E2E secure voice (Firefox'),
    );
    expect(s).toContain('if: ${{ !cancelled() }}');
    expect(s).toContain('CHROMIUM_REPORT: ${{ runner.temp }}/playwright-chromium.json');
    expect(s).toContain('FIREFOX_REPORT: ${{ runner.temp }}/playwright-firefox.json');
    expect(s).toContain(
      'run: node .github/scripts/playwright-flaky-summary.mjs "Chromium=$CHROMIUM_REPORT" "Firefox secure voice=$FIREFOX_REPORT"',
    );
  });
});
