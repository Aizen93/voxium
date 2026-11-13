import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .github/workflows/crypto-deps-watch.yml, step "Check for a newer vodozemac
// release": its `run:` block is taken out of the workflow and run under
// `bash -e` as the runner does, in a directory holding a Cargo.toml with the
// pin, with a `curl` stub first on PATH that records its arguments and
// answers what each case scripts. python3 is the real one.

const ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/crypto-deps-watch.yml');
const STEP = 'Check for a newer vodozemac release';

/** bash (Git's on Windows), grep -P and python3, which the step runs on. */
function usableTools(): boolean {
  const probe = spawnSync(
    'bash',
    ['-c', 'uname -s && echo "a=1" | grep -oP "a=\\K1" && python3 -c "print(1)"'],
    // grep -P wants a UTF-8 locale, which the runner has and Git's bash may not
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } },
  );
  if (probe.status !== 0) return false;
  const kernel = probe.stdout.split('\n')[0].trim();
  return process.platform === 'win32' ? /^(MINGW|MSYS)/.test(kernel) : true;
}

const slash = (p: string) => p.replace(/\\/g, '/');

/** The `run: |` block of the step, unindented. */
function runBlock(): string {
  const yml = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
  const start = yml.indexOf(`      - name: ${STEP}\n`);
  expect(start, STEP).toBeGreaterThan(-1);
  const end = yml.indexOf('\n      - name: ', start + 1);
  const lines = yml.slice(start, end === -1 ? undefined : end).split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

// Prints CURL_BODY and exits CURL_STATUS
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
[ -n "\${CURL_BODY:-}" ] && cat "$CURL_BODY"
exit "\${CURL_STATUS:-0}"
`;

describe.runIf(usableTools())('crypto-deps-watch: newer vodozemac check', () => {
  let dir: string;
  const script = runBlock();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'crypto-watch-'));
    writeFileSync(path.join(dir, 'Cargo.toml'), '[dependencies]\nvodozemac = "=0.11.2"\n', 'utf8');
    const stub = path.join(dir, 'curl');
    writeFileSync(stub, CURL_STUB, 'utf8');
    chmodSync(stub, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(answer: { body?: string; status?: number }) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
      STUB_LOG: slash(path.join(dir, 'calls.log')),
      CURL_STATUS: String(answer.status ?? 0),
      LC_ALL: 'C.UTF-8',
    };
    if (answer.body !== undefined) {
      writeFileSync(path.join(dir, 'body.json'), answer.body, 'utf8');
      env.CURL_BODY = slash(path.join(dir, 'body.json'));
    }
    const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    const log = path.join(dir, 'calls.log');
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    };
  }

  const crate = (version: string | null) => JSON.stringify({ crate: { max_stable_version: version } });

  it('passes when the pin is the latest release', () => {
    const r = run({ body: crate('0.11.2') });
    expect(r.status).toBe(0);
    expect(r.output).toContain('pinned=0.11.2 latest=0.11.2');
  });

  it('fails, naming the release, when a newer one exists', () => {
    const r = run({ body: crate('0.12.0') });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::vodozemac 0.12.0 is available (pinned: 0.11.2)');
  });

  it('asks crates.io with a bound, retries, and fails on an HTTP error', () => {
    const r = run({ body: crate('0.11.2') });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/ -fsS /);
    expect(r.calls[0]).toMatch(/ --max-time \d+ /);
    expect(r.calls[0]).toMatch(/ --retry \d+ /);
    expect(r.calls[0]).toContain('https://crates.io/api/v1/crates/vodozemac');
  });

  it('says crates.io did not answer instead of reading an error as a version', () => {
    const r = run({ body: '<html>503</html>', status: 22 });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::crates.io did not answer for vodozemac');
    expect(r.output).not.toContain('is available');
  });

  it('refuses an answer that names no stable version', () => {
    for (const body of [crate(null), crate(''), crate('not-a-version')]) {
      const r = run({ body });
      expect(r.status, body).toBe(1);
      expect(r.output).toContain('::error::crates.io named no stable vodozemac version');
      expect(r.output).not.toContain('is available');
    }
  });
});
