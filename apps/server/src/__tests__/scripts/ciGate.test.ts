import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The gate job of ci.yml (#107). Branch protection used to require "E2E
// Tests" alone, and that job `needs` the lint job: when lint, typecheck or a
// unit test failed, the e2e job was SKIPPED, and GitHub counts a skipped
// required check as passing, so nothing blocked the merge. The gate needs
// every other job, runs whatever happened to them, and fails unless each one
// succeeded: it is the one check the rulesets require. Its run block is taken
// out of the workflow and run under bash with stand-in results.

const ROOT = path.resolve(__dirname, '../../../../..');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** Each job of the workflow: its id and its YAML block. */
function jobs(yml: string): { id: string; block: string }[] {
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const headers = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return headers.map((h, i) => ({
    id: h[1],
    block: body.slice(h.index, i + 1 < headers.length ? headers[i + 1].index : undefined),
  }));
}

/** A step's `run: |` block, unindented. */
function runBlock(block: string): string {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at, 'run: |').toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

const all = jobs(ci);
const gate = all.find((j) => j.id === 'ci-ok');

function runGate(results: string) {
  return spawnSync('bash', ['-e', '-c', runBlock(gate!.block)], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, RESULTS: results, NEEDS: '{"stand-in": true}' },
  });
}

const bashWorks = spawnSync('bash', ['-c', 'exit 0']).status === 0;

describe('the CI gate job', () => {
  it('exists, under the name the rulesets require', () => {
    expect(gate, 'job ci-ok').toBeDefined();
    expect(gate!.block).toMatch(/^ {4}name: CI OK$/m);
  });

  it('needs every other job of the workflow', () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(gate!.block)?.[1].split(',').map((s) => s.trim()).sort();
    const others = all.filter((j) => j.id !== 'ci-ok').map((j) => j.id).sort();
    expect(others.length).toBeGreaterThanOrEqual(4);
    expect(needs).toEqual(others);
  });

  it('runs whatever happened to them, cancelled included (a skipped gate would count as passing)', () => {
    expect(gate!.block).toMatch(/^ {4}if: always\(\)$/m);
    expect(gate!.block).not.toMatch(/cancelled\(\)|success\(\)|failure\(\)/);
  });

  it('asks for no token scope and stops quickly', () => {
    expect(gate!.block).toMatch(/^ {4}permissions: \{\}$/m);
    expect(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(gate!.block)?.[1])).toBeLessThanOrEqual(5);
  });

  it('decides from the results passed through env, never from an expression inside the script', () => {
    expect(gate!.block).toContain("          RESULTS: ${{ join(needs.*.result, ' ') }}\n");
    expect(gate!.block).toContain('          NEEDS: ${{ toJSON(needs) }}\n');
    expect(runBlock(gate!.block)).not.toContain('${{');
  });

  it('leaves the jobs it gates as they were: e2e keeps its name and still waits for the lint job', () => {
    const e2e = all.find((j) => j.id === 'e2e');
    expect(e2e!.block).toMatch(/^ {4}name: E2E Tests$/m);
    expect(e2e!.block).toMatch(/^ {4}needs: lint-typecheck$/m);
  });
});

describe.runIf(bashWorks)('the gate\'s check', () => {
  it('passes when every job succeeded', () => {
    const result = runGate('success success success success');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Every CI job succeeded');
  });

  it.each([
    ['a failed job', 'success failure success success'],
    ['a skipped job (the e2e job after a failed lint)', 'failure skipped success success'],
    ['a cancelled job', 'success success cancelled success'],
    ['an unknown result', 'success neutral success success'],
    ['no result at all', ''],
  ])('fails on %s', (_label, results) => {
    const result = runGate(results);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
  });
});
