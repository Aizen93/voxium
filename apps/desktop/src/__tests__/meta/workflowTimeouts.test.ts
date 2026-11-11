// @vitest-environment node
// Pure filesystem check: every job of every workflow has its own time limit.
// Without one a job that hangs (a network wait with no bound of its own: a
// package mirror, a registry, a download) holds its runner for GitHub's six
// hours before anyone sees a red X, and a release waits as long.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../../../../../.github/workflows/', import.meta.url));
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

/** Each job of a workflow: its id and its YAML block. */
function jobs(yml: string): { id: string; block: string }[] {
  const at = yml.indexOf('\njobs:\n');
  expect(at, 'jobs:').toBeGreaterThan(-1);
  const body = yml.slice(at + '\njobs:\n'.length);
  const headers = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return headers.map((h, i) => ({
    id: h[1],
    block: body.slice(h.index, i + 1 < headers.length ? headers[i + 1].index : undefined),
  }));
}

describe('workflow time limits', () => {
  it('finds the workflows', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'desktop-shell.yml', 'release.yml']));
  });

  it.each(files)('%s: every job stops within an hour', (file) => {
    const yml = readFileSync(WORKFLOWS + file, 'utf8').replace(/\r\n/g, '\n');
    const list = jobs(yml);
    expect(list.length).toBeGreaterThan(0);
    for (const { id, block } of list) {
      const limit = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(block)?.[1]);
      expect(limit, `${file}: job "${id}" has no timeout-minutes`).toBeGreaterThan(0);
      expect(limit, `${file}: job "${id}"`).toBeLessThanOrEqual(60);
    }
  });

  it('bounds the image pull of the end-to-end job inside the job limit', () => {
    const ci = readFileSync(WORKFLOWS + 'ci.yml', 'utf8').replace(/\r\n/g, '\n');
    const start = ci.indexOf('      - name: Start MinIO and create the assets bucket\n');
    expect(start).toBeGreaterThan(-1);
    const minio = ci.slice(start, ci.indexOf('\n      - name: ', start + 1));
    expect(Number(/timeout-minutes: (\d+)/.exec(minio)?.[1])).toBeLessThan(30);
  });
});
