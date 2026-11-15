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
    const start = ci.indexOf('      - name: Start the object store and create the assets bucket\n');
    expect(start).toBeGreaterThan(-1);
    const store = ci.slice(start, ci.indexOf('\n      - name: ', start + 1));
    expect(Number(/timeout-minutes: (\d+)/.exec(store)?.[1])).toBeLessThan(30);
  });
});

// The end-to-end job's object store (#110, #275). It used to be a frozen build
// of MinIO whose entrypoint started the server twice (a bucket call meeting
// the stop between the two was reset); it is now a maintained image, pinned
// in .github/ci/compose.yml where Dependabot can move it, started once. The
// bucket is there when head-bucket says so and its CORS rule when
// get-bucket-cors says so, each asked again in a bounded loop.
describe('the end-to-end job\'s object store', () => {
  const ci = readFileSync(WORKFLOWS + 'ci.yml', 'utf8').replace(/\r\n/g, '\n');
  const start = ci.indexOf('      - name: Start the object store and create the assets bucket\n');
  const step = ci.slice(start, ci.indexOf('\n      - name: ', start + 1));
  /** The step's script lines, comments dropped, continued lines joined. */
  const script = step.replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const awsCalls = script.filter((l) => /(?:^|\s)aws\s/.test(l));
  /** The compose file the step starts, as its `docker compose -f` names it. */
  const composePath = /^docker compose -f (\S+) /.exec(script.find((l) => l.startsWith('docker compose ')) ?? '')?.[1] ?? '';
  const compose = composePath
    ? readFileSync(fileURLToPath(new URL(`../../../../../${composePath}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    : '';
  const dependabot = readFileSync(fileURLToPath(new URL('../../../../../.github/dependabot.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

  it('starts the one store service of .github/ci/compose.yml, once, and no container of its own', () => {
    expect(start).toBeGreaterThan(-1);
    const up = script.filter((l) => l.startsWith('docker compose '));
    expect(up).toEqual(['docker compose -f .github/ci/compose.yml up -d --quiet-pull object-store']);
    expect(script.some((l) => l.startsWith('docker run '))).toBe(false);
    expect(compose).toMatch(/^ {2}object-store:\n/m);
    expect(compose).toMatch(/^ {4}container_name: object-store$/m);
    expect(compose).toMatch(/^ {6}- "9000:9000"$/m);
  });

  it('pins every image of the compose file by tag and digest, where Dependabot\'s docker-compose entry reads it', () => {
    const images = [...compose.matchAll(/^ {4}image: (\S+)$/gm)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toMatch(/^[a-z0-9][a-z0-9./-]*:[\w][\w.-]*@sha256:[0-9a-f]{64}$/);
    // Dependabot's docker-compose fetcher reads only the files of its entry's
    // directory whose NAME its pattern matches (FILENAME_REGEX, dependabot-core
    // docker/lib/dependabot/docker_compose/file_fetcher.rb): the file the step
    // starts must be such a file, in that directory
    const name = composePath.slice(composePath.lastIndexOf('/') + 1);
    const dir = composePath.slice(0, composePath.lastIndexOf('/'));
    expect(name).toMatch(/(docker-)?compose(-[\w]+)?(?:\.[\w-]+)?\.ya?ml/i);
    const entry = dependabot.slice(dependabot.indexOf('  - package-ecosystem: docker-compose\n'));
    expect(entry.startsWith('  - package-ecosystem: docker-compose\n'), 'a docker-compose entry').toBe(true);
    const block = entry.slice(0, (entry.slice(1).search(/\n {2}- package-ecosystem: /) + 1) || undefined);
    expect(dir).not.toBe('');
    expect(block).toContain(`\n    directory: /${dir}\n`);
    expect(block).toMatch(/\n {4}target-branch: develop\n/);
    expect(block).toMatch(/\n {6}default-days: 3\n/);
  });

  it('starts the store with the job\'s own S3 credentials, and the CLI signs with the same', () => {
    expect(compose).toMatch(/^ {6}RUSTFS_ACCESS_KEY: \$\{S3_ACCESS_KEY:\?[^}]*\}$/m);
    expect(compose).toMatch(/^ {6}RUSTFS_SECRET_KEY: \$\{S3_SECRET_KEY:\?[^}]*\}$/m);
    expect(step).toMatch(/\n {10}AWS_ACCESS_KEY_ID: \$\{\{ env\.S3_ACCESS_KEY \}\}\n/);
    expect(step).toMatch(/\n {10}AWS_SECRET_ACCESS_KEY: \$\{\{ env\.S3_SECRET_KEY \}\}\n/);
  });

  it('starts the store with its update check off: no outbound call from the store in CI', () => {
    // RustFS asks its vendor's version host for a newer release at every start
    // unless told not to; its version in CI is the pin
    expect(compose).toMatch(/^ {6}RUSTFS_CHECK_UPDATE: "false"$/m);
  });

  it('waits for the readiness probe and fails with the container log when it never answers', () => {
    expect(script.some((l) => l.includes('http://127.0.0.1:9000/health/ready'))).toBe(true);
    const notReady = script.indexOf('if [ -z "$ready" ]; then');
    expect(notReady).toBeGreaterThan(-1);
    expect(script.slice(notReady, notReady + 5)).toEqual(expect.arrayContaining(['docker logs object-store', 'exit 1']));
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
    expect(script.slice(missing + 1, missing + 4)).toEqual(['echo "The assets bucket was not there after 10 rounds"', 'docker logs object-store', 'exit 1']);
    expect(script[missing + 4]).toBe('fi');
  });

  it('gives the bucket the CORS rule the browser\'s upload needs, decided by get-bucket-cors in a bounded loop', () => {
    // The e2e pages run on Playwright's baseURL, and the store answers a
    // preflight only for an origin a rule names
    const baseUrl = /baseURL: '([^']+)'/.exec(readFileSync(fileURLToPath(new URL('../../../../../playwright.config.ts', import.meta.url)), 'utf8'))?.[1];
    expect(baseUrl).toBe('http://localhost:8080');
    const rule = script.find((l) => l.startsWith("cors='"));
    expect(rule).toBeDefined();
    const parsed = JSON.parse(rule!.slice("cors='".length, -1)) as { CORSRules: Array<{ AllowedOrigins: string[]; AllowedMethods: string[] }> };
    expect(parsed.CORSRules).toHaveLength(1);
    expect(parsed.CORSRules[0].AllowedOrigins).toEqual([baseUrl]);
    expect(parsed.CORSRules[0].AllowedMethods).toContain('PUT');

    const loop = script.findIndex((l, i) => /^for i in \$\(seq 1 \d+\); do$/.test(l) && script[i + 1]?.includes('get-bucket-cors'));
    expect(loop, 'a counted loop whose first statement asks get-bucket-cors').toBeGreaterThan(-1);
    const rounds = Number(/seq 1 (\d+)/.exec(script[loop])?.[1]);
    expect(rounds).toBeGreaterThan(1);
    expect(rounds).toBeLessThanOrEqual(10);
    const end = script.indexOf('done', loop);
    const body = script.slice(loop + 1, end);
    expect(body[0]).toMatch(/^if aws .*s3api get-bucket-cors .*\| grep -q 'http:\/\/localhost:8080'; then applied=1; break; fi$/);
    expect(script.filter((l) => l.includes('applied=1'))).toHaveLength(1);
    const put = body.filter((l) => l.includes(' put-bucket-cors '));
    expect(put).toHaveLength(1);
    expect(put[0]).toMatch(/--cors-configuration "\$cors" && continue$/);
    expect(body).toContain('sleep 2');
    const missing = script.findIndex((l, i) => i > end && /^if \[ -z "\$applied" \] && ! aws .*s3api get-bucket-cors .*\| grep -q 'http:\/\/localhost:8080'; then$/.test(l));
    expect(missing, 'one more get-bucket-cors decides after the loop').toBeGreaterThan(-1);
    expect(script.slice(missing + 2, missing + 4)).toEqual(['docker logs object-store', 'exit 1']);
  });

  it('prints the store\'s own log file when the job fails, bounded', () => {
    const at = ci.indexOf('      - name: Object store logs (on failure)\n');
    expect(at).toBeGreaterThan(-1);
    const logs = ci.slice(at, ci.indexOf('\n  security:\n', at));
    expect(logs).toContain('        if: failure()\n');
    expect(logs).toContain('docker logs object-store || true');
    expect(logs).toMatch(/timeout \d+ docker exec object-store /);
    expect(ci).not.toMatch(/docker logs minio/);
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
