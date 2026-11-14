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

  it.each(files)('%s: every curl call has a time limit of its own', (file) => {
    const yml = readFileSync(WORKFLOWS + file, 'utf8').replace(/\r\n/g, '\n');
    // A call continued on the next line is read with its continuation
    const calls = [...yml.replace(/\\\n\s*/g, ' ').matchAll(/(?:^|[\s($|])curl\s[^\n]*/g)].map((m) => m[0]);
    for (const call of calls) expect(call, `${file}: ${call.trim()}`).toMatch(/\s(?:--max-time|-m)\s+\d+/);
  });

  it('bounds the image pull of the end-to-end job inside the job limit', () => {
    const ci = readFileSync(WORKFLOWS + 'ci.yml', 'utf8').replace(/\r\n/g, '\n');
    const start = ci.indexOf('      - name: Start MinIO and create the assets bucket\n');
    expect(start).toBeGreaterThan(-1);
    const minio = ci.slice(start, ci.indexOf('\n      - name: ', start + 1));
    expect(Number(/timeout-minutes: (\d+)/.exec(minio)?.[1])).toBeLessThan(30);
  });
});

// The end-to-end job's object store. The image's entrypoint starts the server
// twice unless told otherwise (once in the background to configure its bundled
// client, then for good), the readiness probe answers during the first start,
// and a bucket call that meets the stop between the two is reset: the step
// then fails before any test runs. The store starts once, and the bucket is
// there when head-bucket says so, asked again in a bounded loop.
describe('the end-to-end job\'s object store', () => {
  const ci = readFileSync(WORKFLOWS + 'ci.yml', 'utf8').replace(/\r\n/g, '\n');
  const start = ci.indexOf('      - name: Start MinIO and create the assets bucket\n');
  const step = ci.slice(start, ci.indexOf('\n      - name: ', start + 1));
  /** The step's script lines, comments dropped, continued lines joined. */
  const script = step.replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const awsCalls = script.filter((l) => /(?:^|\s)aws\s/.test(l));

  it('starts the server once', () => {
    const run = script.filter((l) => l.startsWith('docker run '));
    expect(run).toHaveLength(1);
    expect(run[0]).toContain(' -e MINIO_SKIP_CLIENT=yes ');
    // still the image pinned by digest
    expect(run[0]).toMatch(/ bitnamilegacy\/minio:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('waits for the readiness probe and fails with the container log when it never answers', () => {
    expect(script.some((l) => l.includes('/minio/health/ready'))).toBe(true);
    const notReady = script.indexOf('if [ -z "$ready" ]; then');
    expect(notReady).toBeGreaterThan(-1);
    expect(script.slice(notReady, notReady + 5)).toEqual(expect.arrayContaining(['docker logs minio', 'exit 1']));
  });

  it('takes head-bucket as the only proof of the bucket, in a bounded loop', () => {
    const loop = script.findIndex((l) => /^for i in \$\(seq 1 \d+\); do$/.test(l) && script[script.indexOf(l) + 1]?.includes('head-bucket'));
    expect(loop, 'a counted loop whose first statement asks head-bucket').toBeGreaterThan(-1);
    const rounds = Number(/seq 1 (\d+)/.exec(script[loop])?.[1]);
    expect(rounds).toBeGreaterThan(1);
    expect(rounds).toBeLessThanOrEqual(20);
    const end = script.indexOf('done', loop);
    const body = script.slice(loop + 1, end);
    // success is head-bucket answering, and nothing else sets it
    expect(body[0]).toMatch(/^if aws .*s3api head-bucket .*; then created=1; break; fi$/);
    expect(script.filter((l) => l.includes('created=1'))).toHaveLength(1);
    // a create call never decides: its success only skips the pause before the next question
    const create = body.filter((l) => l.includes(' s3 mb '));
    expect(create).toHaveLength(1);
    expect(create[0]).toMatch(/ && continue$/);
    expect(body).toContain('sleep 2');
    // A loop that ends without that answer (its last round may have created
    // the bucket) asks once more, and the step fails with the container log
    // only when that answer is no too.
    const missing = script.findIndex((l, i) => i > end && /^if \[ -z "\$created" \] && ! aws .*s3api head-bucket .*; then$/.test(l));
    expect(missing, 'one more head-bucket decides after the loop').toBeGreaterThan(-1);
    expect(script.slice(missing + 1, missing + 4)).toEqual(['echo "The assets bucket was not there after 10 rounds"', 'docker logs minio', 'exit 1']);
    expect(script[missing + 4]).toBe('fi');
  });

  it('gives every CLI call a time limit and a single attempt, so the loop is the only retry', () => {
    expect(awsCalls.length).toBeGreaterThanOrEqual(3);
    expect(script).toContainEqual(expect.stringMatching(/^limits="--cli-connect-timeout \d+ --cli-read-timeout \d+"$/));
    for (const call of awsCalls) expect(call, call).toMatch(/(?:^|\s)aws \$limits /);
    expect(step).toMatch(/\n {10}AWS_MAX_ATTEMPTS: 1\n/);
    // no chain that reads a create call's exit code as the outcome
    expect(step).not.toMatch(/\|\|\s*\\?\n?\s*aws /);
  });
});
