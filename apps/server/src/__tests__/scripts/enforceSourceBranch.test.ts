import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// .github/workflows/enforce-source-branch.yml (#108): a pull request into
// main must come from THIS repository's develop. The check compared the head
// branch's name alone, so a fork's branch named develop passed. Its run block
// is taken out of the workflow and run under bash with stand-in contexts.

const ROOT = path.resolve(__dirname, '../../../../..');
const workflow = readFileSync(path.join(ROOT, '.github/workflows/enforce-source-branch.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The step's `run: |` block, unindented. */
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

const THIS_REPO = 'Aizen93/voxium';

function check(headRef: string, headRepo: string) {
  return spawnSync('bash', ['-e', '-c', runBlock(workflow)], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HEAD_REF: headRef, HEAD_REPO: headRepo, BASE_REPO: THIS_REPO },
  });
}

const bashWorks = spawnSync('bash', ['-c', 'exit 0']).status === 0;

describe('the source-branch check', () => {
  it('runs on pull requests into main, in the job main requires, with no token scope', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[main\]\n/m);
    expect(workflow).toMatch(/^ {2}check-source:\n/m);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
  });

  it('reads the branch and both repositories through env, never inside the script', () => {
    expect(workflow).toContain('          HEAD_REF: ${{ github.head_ref }}\n');
    expect(workflow).toContain('          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}\n');
    expect(workflow).toContain('          BASE_REPO: ${{ github.repository }}\n');
    expect(runBlock(workflow)).not.toContain('${{');
    // The decision is the script's, so the test below runs all of it
    expect(workflow).not.toMatch(/^ {8}if: /m);
  });
});

describe.runIf(bashWorks)('the check\'s decision', () => {
  it('passes this repository\'s develop', () => {
    const result = check('develop', THIS_REPO);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('fails a fork\'s branch named develop, naming the branch and the head repository', () => {
    const result = check('develop', 'someone/voxium');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
    expect(result.stdout).toContain("'develop'");
    expect(result.stdout).toContain("'someone/voxium'");
    expect(result.stdout).toContain(THIS_REPO);
  });

  it.each([
    ['another branch of this repository', 'feature/x', THIS_REPO],
    ['a branch whose name only looks like develop', 'Develop', THIS_REPO],
    ['a head repository that no longer exists (a deleted fork)', 'develop', ''],
  ])('fails %s', (_label, headRef, headRepo) => {
    const result = check(headRef, headRepo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
  });
});
