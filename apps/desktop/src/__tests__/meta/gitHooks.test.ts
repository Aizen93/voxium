// @vitest-environment node
// The pre-commit hook lives in the repository (.githooks/pre-commit), runs the
// one typecheck CI runs, and `pnpm install` installs it without ever failing an
// install: the root `prepare` script imports scripts/install-git-hooks.mjs only
// when that file exists, because the server image installs from the manifests
// alone (no scripts/, no .git, no git; Dockerfile, .dockerignore).
// The installer's decisions are tested in the server suite
// (apps/server/src/__tests__/scripts/gitHooks.test.ts).
//
// Nothing here runs the installer or the `prepare` script inside this
// repository: it would write the clone's own .git/hooks/pre-commit, which
// every worktree of the clone shares.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const HOOK = '.githooks/pre-commit';
const INSTALLER = 'scripts/install-git-hooks.mjs';
const INSTALLER_LIB = 'scripts/lib/gitHooks.mjs';

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const rootManifest = () => JSON.parse(read('package.json')) as { scripts: Record<string, string> };

const sandbox = mkdtempSync(join(tmpdir(), 'voxium-hook-meta-'));
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** This process's environment without CI and without anything that points git at a repository. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // LC_ALL: git's messages in English, which an assertion reads
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', ...extra };
  for (const name of ['CI', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) {
    delete env[name];
  }
  return env;
}

/**
 * The sh git runs hooks with: on Windows Git for Windows' own (from
 * `git --exec-path`, three levels up, usr/bin/sh.exe), never whichever sh a
 * PATH happens to name; elsewhere the sh on PATH, by its absolute path.
 */
function locateSh(): string | null {
  if (process.platform === 'win32') {
    const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    if (exec.status !== 0) return null;
    const sh = resolve(exec.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe');
    return existsSync(sh) ? sh : null;
  }
  const found = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  return path.startsWith('/') && existsSync(path) ? path : null;
}

/** Run the root `prepare` script the way pnpm does (through the platform's shell), in `cwd`. */
function runPrepare(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(rootManifest().scripts.prepare, { cwd, env, shell: true, encoding: 'utf8', timeout: 30_000 });
}

describe('the pre-commit hook kept in the repository', () => {
  it('is a POSIX sh script with LF line endings', () => {
    const hook = read(HOOK);
    expect(hook.split('\n', 1)[0]).toBe('#!/bin/sh');
    expect(hook).not.toContain('\r');
  });

  // The shim runs it with `sh`, so nothing depends on the mode; it stays executable for whoever runs it by hand.
  it('is executable in the index, stored with LF and checked out with LF on every platform', () => {
    expect(git('ls-files', '-s', '--', HOOK)).toMatch(/^100755 [0-9a-f]{40,64} 0\t\.githooks\/pre-commit$/);
    expect(git('cat-file', 'blob', `:${HOOK}`)).not.toContain('\r');
    // a no-CR check alone passes on a Linux checkout even without the attribute
    expect(git('check-attr', 'eol', '--', HOOK)).toBe(`${HOOK}: eol: lf`);
  });

  it('runs `pnpm typecheck`, the command CI runs, and stops the commit when it fails', () => {
    const lines = read(HOOK)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toContain('if ! pnpm typecheck; then');
    expect(lines.slice(lines.indexOf('if ! pnpm typecheck; then')).slice(0, 3)).toContain('exit 1');
    // the only pnpm command it runs, so the hook and CI cannot drift apart
    const invoked = lines
      .filter((l) => !l.startsWith('echo'))
      .flatMap((l) => [...l.matchAll(/\bpnpm\s+([a-z][\w:-]*)/g)].map((m) => m[1]));
    expect(invoked).toEqual(['typecheck']);
    expect(read('.github/workflows/ci.yml')).toMatch(/^\s+run: pnpm typecheck$/m);
    expect(rootManifest().scripts.typecheck).toContain('pnpm run typecheck:browser');
  });

  // The hook run by sh with nothing but a stand-in pnpm on PATH, or no pnpm at
  // all. Skipped only off CI on a machine without sh; a CI runner without one
  // fails here instead.
  const sh = locateSh();
  describe.skipIf(sh === null && !process.env.CI)('run by sh', () => {
    function runHook(stub: string | null) {
      expect(sh, 'no sh to run the hook with: CI must have one').not.toBeNull();
      const bin = mkdtempSync(join(sandbox, 'bin-'));
      if (stub !== null) {
        writeFileSync(join(bin, 'pnpm'), stub);
        chmodSync(join(bin, 'pnpm'), 0o755);
      }
      return spawnSync(sh as string, [join(REPO, HOOK)], { cwd: sandbox, env: cleanEnv({ PATH: bin }), encoding: 'utf8' });
    }

    it('lets the commit through when the typecheck passes', () => {
      const result = runHook('#!/bin/sh\necho "stand-in pnpm $*"\nexit 0\n');
      expect(result.stdout).toContain('stand-in pnpm typecheck');
      expect(result.status).toBe(0);
    });

    it('stops it when the typecheck fails', () => {
      const result = runHook('#!/bin/sh\necho "stand-in pnpm $*"\nexit 2\n');
      expect(result.stdout).toContain('stand-in pnpm typecheck');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[pre-commit] FAILED');
    });

    it('stops it, saying why, when pnpm cannot be found', () => {
      const result = runHook(null);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pnpm is not on');
    });
  });
});

describe('installed by `pnpm install`', () => {
  it('the root `prepare` script imports the installer, and only when the file exists', () => {
    const prepare = rootManifest().scripts.prepare;
    expect(prepare).toContain(`existsSync('${INSTALLER}')`);
    expect(prepare).toContain(`import('./${INSTALLER}')`);
    // a broken installer is one line, not a failed install
    expect(prepare).toMatch(/\.catch\(/);
    expect(existsSync(join(REPO, INSTALLER))).toBe(true);
  });

  it('does nothing and succeeds where only the manifests are (the server image install)', () => {
    const dir = mkdtempSync(join(sandbox, 'image-'));
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) cpSync(join(REPO, file), join(dir, file));
    const result = runPrepare(dir, cleanEnv());
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe('');
  });

  it('the server image installs before any scripts/ file and without .git (so the guard above is what runs there)', () => {
    const dockerfile = read('Dockerfile');
    const firstInstall = dockerfile.indexOf('RUN pnpm install');
    expect(firstInstall).toBeGreaterThan(-1);
    expect(dockerfile.slice(0, firstInstall)).not.toMatch(/^COPY (?!pnpm-workspace\.yaml package\.json pnpm-lock\.yaml|packages\/shared\/package\.json|apps\/server\/package\.json)/m);
    const ignored = read('.dockerignore').split(/\r?\n/);
    expect(ignored).toContain('scripts');
    expect(ignored).toContain('.git');
  });

  it('the installer does nothing and succeeds outside a git work tree, and creates no repository', () => {
    const dir = mkdtempSync(join(sandbox, 'tarball-'));
    for (const file of ['package.json', HOOK, INSTALLER, INSTALLER_LIB]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(REPO, file), join(dir, file));
    }
    // repository discovery stops above this directory, wherever the temporary folder is
    const result = runPrepare(dir, cleanEnv({ GIT_CEILING_DIRECTORIES: dirname(dir) }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\[git hooks\] no hook installed: git rev-parse answered "fatal: not a git repository[^"]*"\.$/);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('the installer does nothing when CI is set', () => {
    const dir = mkdtempSync(join(sandbox, 'ci-'));
    for (const file of ['package.json', HOOK, INSTALLER, INSTALLER_LIB]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(REPO, file), join(dir, file));
    }
    const result = runPrepare(dir, { ...cleanEnv({ GIT_CEILING_DIRECTORIES: dirname(dir) }), CI: 'true' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[git hooks] CI is set: no hook installed.');
  });
});
