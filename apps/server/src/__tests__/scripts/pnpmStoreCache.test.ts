import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The "Cache pnpm store" steps of ci.yml and release.yml. They cached
// ~/.pnpm-store, a directory pnpm never uses: every run logged "Path
// Validation Error ... no cache is being saved" and downloaded every package
// again. Each job now asks pnpm where its store is ("Locate the pnpm store")
// and caches that. The step's own run block is taken out of the workflow and
// run under bash with the real pnpm.

const ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOWS = ['ci.yml', 'release.yml'].map((f) => path.join(ROOT, '.github/workflows', f));

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Each job of a workflow: its id and its YAML block. */
function jobs(yml: string): { id: string; block: string }[] {
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const headers = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return headers.map((h, i) => ({
    id: h[1],
    block: body.slice(h.index, i + 1 < headers.length ? headers[i + 1].index : undefined),
  }));
}

/** The names of a job's steps, in order. */
const stepNames = (block: string) => [...block.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);

/** The lines of one step of a job, from its `- name:` to the next step. */
function step(block: string, name: string): string {
  const start = block.indexOf(`      - name: ${name}\n`);
  expect(start, `step "${name}"`).toBeGreaterThan(-1);
  const next = block.indexOf('\n      - name: ', start + 1);
  return block.slice(start, next === -1 ? undefined : next);
}

/** A step's `run: |` block, unindented. */
function runBlock(stepText: string): string {
  const lines = stepText.split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

const cachingJobs = WORKFLOWS.flatMap((file) =>
  jobs(read(file))
    .filter((j) => stepNames(j.block).includes('Cache pnpm store'))
    .map((j) => ({ file: path.basename(file), ...j })),
);

describe('the pnpm store cache', () => {
  it('is in the four jobs that install with pnpm', () => {
    expect(cachingJobs.map((j) => `${j.file}:${j.id}`).sort()).toEqual(
      ['ci.yml:build', 'ci.yml:e2e', 'ci.yml:lint-typecheck', 'release.yml:publish'].sort(),
    );
  });

  it('never names a guessed store directory', () => {
    for (const file of WORKFLOWS) {
      // Comments may explain the old path; no setting may use it
      const settings = read(file)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l));
      // (`steps.pnpm-store.outputs.dir` is the step id, not a directory)
      expect(settings.filter((l) => l.includes('/.pnpm-store')), path.basename(file)).toEqual([]);
    }
  });

  it.each(cachingJobs.map((j) => [`${j.file}:${j.id}`, j] as const))(
    '%s caches the path pnpm reports, asked after pnpm is installed and before the install',
    (_label, job) => {
      const names = stepNames(job.block);
      const locate = names.indexOf('Locate the pnpm store');
      expect(locate, 'the locate step').toBeGreaterThan(-1);
      expect(locate).toBeGreaterThan(names.indexOf('Install pnpm'));
      expect(locate).toBeLessThan(names.indexOf('Cache pnpm store'));
      expect(names.indexOf('Cache pnpm store')).toBeLessThan(names.indexOf('Install dependencies'));

      const locateStep = step(job.block, 'Locate the pnpm store');
      expect(locateStep).toContain('id: pnpm-store');
      // release.yml runs on Windows too, where the default shell is PowerShell
      expect(locateStep).toContain('shell: bash');
      expect(step(job.block, 'Cache pnpm store')).toContain('path: ${{ steps.pnpm-store.outputs.dir }}');
    },
  );
});

/** bash and pnpm, which the locate step runs (on Windows: Git's bash). */
function usableTools(): boolean {
  const probe = spawnSync('bash', ['-c', 'uname -s && pnpm --version'], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const kernel = probe.stdout.split('\n')[0].trim();
  return process.platform === 'win32' ? /^(MINGW|MSYS)/.test(kernel) : true;
}

describe.runIf(usableTools())('the "Locate the pnpm store" step', () => {
  let dir: string;
  const script = runBlock(step(cachingJobs[0].block, 'Locate the pnpm store'));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pnpm-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the same in every job', () => {
    for (const job of cachingJobs) {
      expect(runBlock(step(job.block, 'Locate the pnpm store')), `${job.file}:${job.id}`).toBe(script);
    }
  });

  it('writes the directory of the store pnpm really uses', () => {
    const output = path.join(dir, 'github_output');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GITHUB_OUTPUT: output.replace(/\\/g, '/') },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const line = readFileSync(output, 'utf8').trim();
    expect(line).toMatch(/^dir=.+/);
    const reported = line.slice('dir='.length);
    // The store of this very checkout: it exists, since the dependencies were installed from it
    expect(existsSync(reported), reported).toBe(true);
    expect(reported).not.toContain('.pnpm-store');
  });

  it('fails the step when pnpm names no store', () => {
    // A pnpm that prints nothing, first on PATH
    const fake = path.join(dir, 'bin');
    spawnSync('bash', ['-c', `mkdir -p "${fake.replace(/\\/g, '/')}" && printf '#!/usr/bin/env bash\\nexit 0\\n' > "${fake.replace(/\\/g, '/')}/pnpm" && chmod +x "${fake.replace(/\\/g, '/')}/pnpm"`]);
    const output = path.join(dir, 'github_output');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${fake}${path.delimiter}${process.env.PATH ?? ''}`, GITHUB_OUTPUT: output.replace(/\\/g, '/') },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::pnpm named no store path');
    expect(existsSync(output)).toBe(false);
  });
});
