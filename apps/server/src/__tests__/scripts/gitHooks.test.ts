import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  KNOWN_SHIM_SHA256,
  LOCAL_ENV_VARS,
  SHIM,
  SHIM_MARKER,
  SHIM_VERSION,
  TRACKED_HOOK,
  gitEnv,
  installGitHooks,
  runGit,
  type GitEnv,
  type GitResult,
} from '../../../../../scripts/lib/gitHooks.mjs';

// The installer `pnpm install` runs (the root package.json's `prepare`, then
// scripts/install-git-hooks.mjs): it writes a shim where git reads the
// pre-commit hook (the clone's common hooks directory) and, in every other
// case, leaves the files alone and the install successful. The root scripts'
// helpers are tested in this suite (node environment).
//
// No test here touches the repository the suite runs in: the decision table
// runs on an injected git and temporary directories, and the real-git cases
// run in temporary repositories, with the user's and the machine's git config
// shut out (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM) and repository discovery
// stopped above the sandbox.

const REPO = resolve(__dirname, '../../../../..');
/** The shim text shipped as v1, byte for byte (LF: .gitattributes keeps *.sh so). */
const SHIM_V1 = readFileSync(join(__dirname, '..', 'fixtures', 'git-hooks', 'shim-v1.sh'), 'utf8');
// Its real name: git prints canonical paths, and a temporary folder can sit
// behind a link or a short name (macOS, some Windows accounts).
const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'voxium-git-hooks-')));
const emptyGlobalConfig = join(sandbox, 'global.gitconfig');
writeFileSync(emptyGlobalConfig, '');

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

let counter = 0;
const fresh = (name: string) => join(sandbox, `${name}-${++counter}`);

/** A checkout root holding the tracked hook (or not), with a `.git` directory of its own. */
function checkoutRoot(withHook = true): string {
  const root = fresh('root');
  mkdirSync(join(root, '.githooks'), { recursive: true });
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  if (withHook) writeFileSync(join(root, TRACKED_HOOK), '#!/bin/sh\nexit 0\n');
  return root;
}

/** git prints its paths with forward slashes, on Windows too. */
const slashes = (path: string) => path.replace(/\\/g, '/');
const REV_PARSE = 'rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-path hooks/pre-commit';

/** What git answers for a checkout whose hooks are read from `<root>/.git/hooks` (or `hooksAt`). */
function paths(root: string, hooksAt = join(root, '.git', 'hooks')): GitResult {
  return { status: 0, stdout: [root, join(root, '.git'), join(hooksAt, 'pre-commit')].map(slashes).join('\n'), stderr: '' };
}

/** An injected git answering rev-parse with `answer`, recording every call. */
function fakeGit(answer: GitResult) {
  const calls: { args: string[]; cwd: string; env: GitEnv }[] = [];
  const git = vi.fn((args: readonly string[], options: { cwd: string; env: GitEnv }) => {
    calls.push({ args: [...args], cwd: options.cwd, env: options.env });
    if (args.join(' ') !== REV_PARSE) throw new Error(`unexpected git ${args.join(' ')}`);
    return answer;
  });
  return { git, calls };
}

const hookOf = (root: string) => join(root, '.git', 'hooks', 'pre-commit');
const isWindows = process.platform === 'win32';

describe('installGitHooks — the decision table (injected git)', () => {
  for (const value of ['true', '1', 'false', 'yes']) {
    it(`does nothing when CI is set, whatever the value ("${value}")`, () => {
      const root = checkoutRoot();
      const { git } = fakeGit(paths(root));
      const log = vi.fn();
      expect(installGitHooks({ root, env: { CI: value }, git, log })).toMatchObject({ action: 'skipped', reason: 'ci' });
      expect(git).not.toHaveBeenCalled();
      expect(existsSync(hookOf(root))).toBe(false);
      expect(log).toHaveBeenCalledWith('[git hooks] CI is set: no hook installed.');
    });
  }

  it('an empty CI is not set', () => {
    const root = checkoutRoot();
    const { git } = fakeGit(paths(root));
    expect(installGitHooks({ root, env: { CI: '' }, git, log: vi.fn() }).action).toBe('installed');
  });

  it('does nothing, and runs no git, when the tracked hook is missing', () => {
    const root = checkoutRoot(false);
    const { git } = fakeGit(paths(root));
    expect(installGitHooks({ root, env: {}, git, log: vi.fn() })).toMatchObject({ action: 'skipped', reason: 'no-hook' });
    expect(git).not.toHaveBeenCalled();
  });

  it('does nothing when git is not installed, or does not answer', () => {
    const root = checkoutRoot();
    expect(installGitHooks({ root, env: {}, git: fakeGit({ missing: true }).git, log: vi.fn() })).toMatchObject({ reason: 'no-git' });
    const timedOut = installGitHooks({ root, env: {}, git: fakeGit({ failed: 'spawnSync git ETIMEDOUT' }).git, log: vi.fn() });
    expect(timedOut).toMatchObject({ action: 'skipped', reason: 'git-failed' });
    expect(timedOut.message).toContain('ETIMEDOUT');
    expect(existsSync(hookOf(root))).toBe(false);
  });

  it("outside a work tree, says so in git's own words", () => {
    const root = checkoutRoot();
    const stderr = 'fatal: not a git repository (or any of the parent directories): .git';
    const log = vi.fn();
    expect(installGitHooks({ root, env: {}, git: fakeGit({ status: 128, stdout: '', stderr }).git, log })).toMatchObject({
      action: 'skipped',
      reason: 'no-work-tree',
    });
    expect(log).toHaveBeenCalledWith(`[git hooks] no hook installed: git rev-parse answered "${stderr}".`);
  });

  it('a refusal of another kind (an unsafe directory) is reported as git said it, never as "not a work tree"', () => {
    const root = checkoutRoot();
    const stderr = [
      "fatal: detected dubious ownership in repository at '/srv/voxium'",
      "To add an exception for this directory, call:",
      "\tgit config --global --add safe.directory /srv/voxium",
    ].join('\n');
    const result = installGitHooks({ root, env: {}, git: fakeGit({ status: 128, stdout: '', stderr }).git, log: vi.fn() });
    expect(result).toMatchObject({ action: 'skipped', reason: 'git-refused' });
    expect(result.message).toBe(`no hook installed: git rev-parse answered "fatal: detected dubious ownership in repository at '/srv/voxium'".`);
    expect(result.message).not.toContain('work tree');
    expect(existsSync(hookOf(root))).toBe(false);
  });

  it('an answer it cannot read (a git older than --path-format echoes the option back) installs nothing', () => {
    const root = checkoutRoot();
    const answer: GitResult = { status: 0, stdout: `--path-format=absolute\n${slashes(root)}\n.git\n.git/hooks/pre-commit`, stderr: '' };
    expect(installGitHooks({ root, env: {}, git: fakeGit(answer).git, log: vi.fn() })).toMatchObject({ action: 'skipped', reason: 'git-failed' });
    expect(existsSync(hookOf(root))).toBe(false);
  });

  it('does nothing when the work tree around it is another one (the sources copied into another repository)', () => {
    const root = checkoutRoot();
    const outer = dirname(root);
    const answer: GitResult = { status: 0, stdout: [outer, join(outer, '.git'), join(outer, '.git', 'hooks', 'pre-commit')].map(slashes).join('\n'), stderr: '' };
    expect(installGitHooks({ root, env: {}, git: fakeGit(answer).git, log: vi.fn() })).toMatchObject({ action: 'skipped', reason: 'other-work-tree' });
    expect(existsSync(join(outer, '.git'))).toBe(false);
  });

  it('reads the top level as the same directory however git spells it', () => {
    const root = checkoutRoot();
    const spelled = isWindows ? slashes(root).toUpperCase() : `${root}/`;
    const answer: GitResult = { status: 0, stdout: [spelled, slashes(join(root, '.git')), slashes(hookOf(root))].join('\n'), stderr: '' };
    expect(installGitHooks({ root, env: {}, git: fakeGit(answer).git, log: vi.fn() }).action).toBe('installed');
  });

  it('writes nothing when a hooks path is configured, and says where git reads hooks from', () => {
    const root = checkoutRoot();
    const husky = join(root, '.husky');
    const log = vi.fn();
    const result = installGitHooks({ root, env: {}, git: fakeGit(paths(root, husky)).git, log });
    expect(result).toMatchObject({ action: 'skipped', reason: 'hooks-path' });
    expect(existsSync(hookOf(root))).toBe(false);
    expect(existsSync(husky)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(`git runs hooks from ${slashes(husky)}`);
    expect(log.mock.calls[0][0]).toContain('runs only if the pre-commit hook in that folder calls it');
  });

  it('writes the shim, LF only and executable, creating the hooks directory, and says so in one line', () => {
    const root = checkoutRoot();
    rmSync(join(root, '.git', 'hooks'), { recursive: true });
    const env = { HOME: '/home/someone' };
    const { git, calls } = fakeGit(paths(root));
    const log = vi.fn();
    expect(installGitHooks({ root, env, git, log })).toMatchObject({ action: 'installed', reason: 'written' });
    expect(calls).toEqual([{ args: REV_PARSE.split(' '), cwd: root, env }]);
    const written = readFileSync(hookOf(root), 'utf8');
    expect(written).toBe(SHIM);
    expect(written).not.toContain('\r');
    if (!isWindows) expect(statSync(hookOf(root)).mode & 0o777).toBe(0o755);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[git hooks\] pre-commit hook installed \(.+\): before each commit, git runs \.githooks\/pre-commit \(`pnpm typecheck`\)\.$/);
    // nothing left beside it
    expect(existsSync(join(root, '.git', 'hooks'))).toBe(true);
    expect(readdir(join(root, '.git', 'hooks'))).toEqual(['pre-commit']);
  });

  it('is silent, and leaves the file as it is, when the current shim is already there', () => {
    const root = checkoutRoot();
    writeFileSync(hookOf(root), SHIM);
    const before = statSync(hookOf(root)).mtimeMs;
    const log = vi.fn();
    expect(installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log })).toMatchObject({ action: 'already', reason: 'current', message: '' });
    expect(log).not.toHaveBeenCalled();
    expect(statSync(hookOf(root)).mtimeMs).toBe(before);
  });

  // Replaced: a shim text this project shipped, whatever its line endings.
  for (const [what, text] of [
    ['the shim it shipped as v1', SHIM_V1],
    ['a CRLF copy of the v1 shim', SHIM_V1.replace(/\n/g, '\r\n')],
    ['a CRLF copy of the current shim', SHIM.replace(/\n/g, '\r\n')],
  ] as const) {
    it(`replaces ${what}, in one line`, () => {
      const root = checkoutRoot();
      writeFileSync(hookOf(root), text);
      const log = vi.fn();
      expect(installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log })).toMatchObject({ action: 'installed', reason: 'replaced' });
      expect(readFileSync(hookOf(root), 'utf8')).toBe(SHIM);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(`updated to shim v${SHIM_VERSION}`);
    });
  }

  it('keeps a newer shim (a shebang line, then a marker of a higher version, at the start), silently', () => {
    const root = checkoutRoot();
    const newer = SHIM.replace(SHIM_MARKER, `# voxium-pre-commit-shim: v${SHIM_VERSION + 1}`).replace(/\n/g, '\r\n');
    writeFileSync(hookOf(root), newer);
    const log = vi.fn();
    expect(installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log })).toMatchObject({ action: 'already', reason: 'newer' });
    expect(readFileSync(hookOf(root), 'utf8')).toBe(newer);
    expect(log).not.toHaveBeenCalled();
  });

  /** Installs twice over `own`: each time it is kept byte for byte and one line says how to switch. */
  function expectKeptAsOwn(own: Buffer) {
    const root = checkoutRoot();
    writeFileSync(hookOf(root), own);
    for (let install = 0; install < 2; install++) {
      const log = vi.fn();
      expect(installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log })).toMatchObject({ action: 'kept', reason: 'own-hook' });
      expect(readFileSync(hookOf(root)).equals(own)).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain('is a hook of your own: left as it is');
      expect(line).toContain("the repository's pre-commit hook (.githooks/pre-commit, `pnpm typecheck`) does not run");
      expect(line).toContain('remove or rename that file, then run `node scripts/install-git-hooks.mjs`');
    }
  }

  // Kept: anything that is not, line endings aside, a shim text it shipped.
  it('keeps a hook without the marker, byte for byte, saying so at every install', () => {
    expectKeptAsOwn(Buffer.from('#!/bin/sh\r\n# my own checks\r\nexec ./my-lint\r\n', 'utf8'));
  });

  it("keeps a hook of the user's own with the shim's text pasted after their lines (the marker on a later line)", () => {
    expectKeptAsOwn(Buffer.from(`#!/bin/sh\n./my-lint || exit 1\n${SHIM}`, 'utf8'));
  });

  it('keeps a shim of this version edited in place', () => {
    expectKeptAsOwn(Buffer.from(SHIM.replace('exit 0\n', './my-lint\nexit 0\n'), 'utf8'));
  });

  it('keeps a higher-version marker that is not where a shim has it (not right after the shebang line)', () => {
    expectKeptAsOwn(Buffer.from(`#!/bin/sh\n# my hook\n# voxium-pre-commit-shim: v${SHIM_VERSION + 1}\n./my-lint\n`, 'utf8'));
  });

  it('leaves a directory where the hook should be, and says so', () => {
    const root = checkoutRoot();
    mkdirSync(hookOf(root));
    expect(installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log: vi.fn() })).toMatchObject({ action: 'skipped', reason: 'not-a-file' });
  });

  it('reports a failed write and returns, never throws, leaving no temporary file', () => {
    const root = checkoutRoot();
    rmSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'hooks'), 'a file where the hooks directory should be');
    const log = vi.fn();
    const result = installGitHooks({ root, env: {}, git: fakeGit(paths(root)).git, log });
    expect(result).toMatchObject({ action: 'skipped', reason: 'write-failed' });
    expect(log.mock.calls[0][0]).toMatch(/^\[git hooks\] could not write .+: no hook installed\.$/);
    expect(readdir(join(root, '.git'))).toEqual(['hooks']);
  });
});

const readdir = (dir: string) => readdirSync(dir).sort();

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the shim', () => {
  const lines = SHIM.split('\n');

  // An install replaces exactly the texts of this table, so a change to the
  // shim's text is a new version with a new entry here and in the module;
  // an entry, once shipped, is never edited or removed.
  it('is one of the known texts, under the highest version, and the known texts stay as shipped', () => {
    expect(KNOWN_SHIM_SHA256).toEqual({
      1: '2b088f279302738717cf6ff27e9aba3d751a3df2285eb5d74c516fe7e2bab45b',
      2: '90e8c33dfa0a52597223808793364c7336c2395220dbc5a3e8010ce76834df01',
    });
    expect(sha256(SHIM)).toBe(KNOWN_SHIM_SHA256[SHIM_VERSION]);
    expect(Math.max(...Object.keys(KNOWN_SHIM_SHA256).map(Number))).toBe(SHIM_VERSION);
    // the fixture is the v1 text itself
    expect(sha256(SHIM_V1)).toBe(KNOWN_SHIM_SHA256[1]);
  });

  it('is an sh script, LF only, carrying its marker and version on the second line', () => {
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe(`# voxium-pre-commit-shim: v${SHIM_VERSION}`);
    expect(SHIM).not.toContain('\r');
    expect(SHIM.endsWith('\nexit 0\n')).toBe(true);
  });

  it('runs the tracked hook through sh (its mode does not matter), only when the branch tracks it and it is there', () => {
    expect(SHIM).toContain('if git ls-files --error-unmatch -- .githooks/pre-commit >/dev/null 2>&1 && [ -f .githooks/pre-commit ]; then\n  exec sh .githooks/pre-commit "$@"\nfi');
  });

  it('otherwise runs `pnpm typecheck`, only when package.json has that script, and refuses the commit when it fails', () => {
    const body = SHIM.slice(SHIM.indexOf('if has_typecheck_script; then'));
    expect(body.length).toBeLessThan(SHIM.length);
    expect(body).toContain('if ! command -v pnpm >/dev/null 2>&1; then');
    expect(body).toContain('if ! pnpm typecheck; then');
    expect(body.match(/exit 1/g)).toHaveLength(2);
  });

  it('decides that with shell builtins alone: no grep, sed or awk that a PATH could lack', () => {
    const check = SHIM.slice(SHIM.indexOf('has_typecheck_script() {'), SHIM.indexOf('if has_typecheck_script; then'));
    expect(check).toContain(`line=\${line#*'"typecheck"'}`);
    expect(check).toContain('case $rest in :*) return 0 ;; esac');
    expect(check.replace(/^\s*#.*$/gm, '')).not.toMatch(/\b(grep|sed|awk|cat|node|tr)\b/);
  });
});

describe('the environment git runs with', () => {
  it('has none of the variables git calls local to a repository, and keeps the rest', () => {
    const env: GitEnv = { PATH: '/bin', HOME: '/home/x', GIT_CONFIG_GLOBAL: '/x', GIT_CEILING_DIRECTORIES: '/tmp' };
    for (const name of LOCAL_ENV_VARS) env[name] = `/elsewhere/${name}`;
    const clean = gitEnv(env);
    for (const name of LOCAL_ENV_VARS) expect(clean).not.toHaveProperty(name);
    expect(clean).toEqual({ PATH: '/bin', HOME: '/home/x', GIT_CONFIG_GLOBAL: '/x', GIT_CEILING_DIRECTORIES: '/tmp' });
    expect(env.GIT_DIR).toBe('/elsewhere/GIT_DIR');
  });

  it('the copy holds every name this machine\'s git lists (`git rev-parse --local-env-vars`), the `git -c` carriers included', () => {
    const listed = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) expect(LOCAL_ENV_VARS).toContain(name);
    for (const name of ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
      expect(LOCAL_ENV_VARS).toContain(name);
    }
  });
});

/** This process's environment with git kept inside the sandbox. */
function isolatedEnv(extra: GitEnv = {}): GitEnv {
  const env: GitEnv = gitEnv({ ...process.env });
  delete env.CI;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // discovery never looks above the sandbox
    GIT_CEILING_DIRECTORIES: dirname(sandbox),
    // git's messages in English, which some assertions read
    LC_ALL: 'C',
    ...extra,
  };
}

function git(cwd: string, args: string[], env: GitEnv = isolatedEnv()) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

function gitOk(cwd: string, args: string[], env?: GitEnv): string {
  const result = git(cwd, args, env);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository whose root holds the tracked hook, committed. */
function repository(): string {
  const root = fresh('repo');
  mkdirSync(join(root, '.githooks'), { recursive: true });
  gitOk(root, ['init', '-q', '-b', 'main']);
  gitOk(root, ['config', 'user.name', 'Hook Test']);
  gitOk(root, ['config', 'user.email', 'hooks@example.invalid']);
  cpSync(join(REPO, TRACKED_HOOK), join(root, TRACKED_HOOK));
  return root;
}

describe('installGitHooks — real git, in temporary repositories', () => {
  it('installs once, then stays silent', () => {
    const root = repository();
    const log = vi.fn();
    expect(installGitHooks({ root, env: isolatedEnv(), log }).action).toBe('installed');
    expect(readFileSync(hookOf(root), 'utf8')).toBe(SHIM);
    const again = vi.fn();
    expect(installGitHooks({ root, env: isolatedEnv(), log: again }).action).toBe('already');
    expect(again).not.toHaveBeenCalled();
  });

  it('writes nothing when the repository sets core.hooksPath', () => {
    const root = repository();
    gitOk(root, ['config', 'core.hooksPath', '.husky']);
    expect(installGitHooks({ root, env: isolatedEnv(), log: vi.fn() }).reason).toBe('hooks-path');
    expect(existsSync(hookOf(root))).toBe(false);
    expect(existsSync(join(root, '.husky'))).toBe(false);
  });

  it('is not misled by a core.hooksPath carried in the environment (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT)', () => {
    for (const carried of [
      { GIT_CONFIG_PARAMETERS: "'core.hookspath'='/elsewhere'" },
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/elsewhere' },
    ]) {
      const root = repository();
      // the carrier does reach a git that is not given the clean environment
      expect(gitOk(root, ['rev-parse', '--git-path', 'hooks'], isolatedEnv(carried))).toContain('elsewhere');
      expect(installGitHooks({ root, env: isolatedEnv(carried), log: vi.fn() }).action).toBe('installed');
      expect(readFileSync(hookOf(root), 'utf8')).toBe(SHIM);
    }
  });

  // GIT_DIR alone is the dangerous shape: git then takes the working directory
  // as that repository's work tree, so the top-level check alone would pass.
  for (const withWorkTree of [false, true]) {
    it(`writes into the checkout it was given when GIT_DIR${withWorkTree ? ' and GIT_WORK_TREE name' : ' names'} another repository (an install run from a git hook)`, () => {
      const root = repository();
      const other = repository();
      const env = isolatedEnv({ GIT_DIR: join(other, '.git'), ...(withWorkTree ? { GIT_WORK_TREE: other } : {}) });
      expect(installGitHooks({ root, env, log: vi.fn() }).action).toBe('installed');
      expect(existsSync(hookOf(root))).toBe(true);
      expect(existsSync(hookOf(other))).toBe(false);
    });
  }

  it("does nothing in a directory that is not a work tree, in git's words, and creates no repository", () => {
    const root = fresh('plain');
    mkdirSync(join(root, '.githooks'), { recursive: true });
    cpSync(join(REPO, TRACKED_HOOK), join(root, TRACKED_HOOK));
    const log = vi.fn();
    expect(installGitHooks({ root, env: isolatedEnv(), log })).toMatchObject({ action: 'skipped', reason: 'no-work-tree' });
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(log.mock.calls[0][0]).toMatch(/^\[git hooks\] no hook installed: git rev-parse answered "fatal: not a git repository/);
  });

  it('does nothing to the repository around a copy of the sources', () => {
    const outer = repository();
    const root = join(outer, 'vendor', 'voxium');
    mkdirSync(join(root, '.githooks'), { recursive: true });
    cpSync(join(REPO, TRACKED_HOOK), join(root, TRACKED_HOOK));
    expect(installGitHooks({ root, env: isolatedEnv(), log: vi.fn() })).toMatchObject({ action: 'skipped', reason: 'other-work-tree' });
    expect(existsSync(hookOf(outer))).toBe(false);
  });

  it('run from a linked worktree, writes the clone\'s common hooks directory, which every worktree reads', () => {
    const root = repository();
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', 'tracked hook']);
    const linked = fresh('linked');
    gitOk(root, ['worktree', 'add', '-q', '-b', 'side', linked]);
    expect(installGitHooks({ root: linked, env: isolatedEnv(), log: vi.fn() }).action).toBe('installed');
    expect(readFileSync(hookOf(root), 'utf8')).toBe(SHIM);
    expect(gitOk(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'])).toBe(slashes(hookOf(root)));
  });

  it('in a submodule, writes the submodule\'s own hooks directory (.git/modules/<name>/hooks)', () => {
    const library = repository();
    gitOk(library, ['add', '-A']);
    gitOk(library, ['commit', '-q', '-m', 'library with the tracked hook']);
    const superproject = repository();
    gitOk(superproject, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib']);
    const sub = join(superproject, 'lib');
    expect(installGitHooks({ root: sub, env: isolatedEnv(), log: vi.fn() }).action).toBe('installed');
    expect(readFileSync(join(superproject, '.git', 'modules', 'lib', 'hooks', 'pre-commit'), 'utf8')).toBe(SHIM);
    expect(existsSync(hookOf(superproject))).toBe(false);
  });

  // A junction on Windows (no privilege needed), a symlink elsewhere. Only off
  // Linux CI may the link be impossible to create; then the test says why.
  function linkDirectory(target: string, path: string, skip: (note: string) => void) {
    const type = isWindows ? 'junction' : 'dir';
    try {
      symlinkSync(target, path, type);
    } catch (err) {
      if (process.env.CI && process.platform === 'linux') throw err;
      skip(`cannot create a ${type} here: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
  }

  // Out of the git directory: to a folder other repositories share, and into
  // the work tree (a folder of the checkout itself, outside .git).
  for (const [where, linkTarget] of [
    ['a folder other repositories share', (_root: string) => fresh('shared-hooks')],
    ['a folder of the work tree', (root: string) => join(root, 'tools', 'hooks')],
  ] as const) {
    it(`refuses a hooks directory that is a link out of the git directory, to ${where}`, (ctx) => {
      const root = repository();
      const outside = linkTarget(root);
      mkdirSync(outside, { recursive: true });
      rmSync(join(root, '.git', 'hooks'), { recursive: true });
      linkDirectory(outside, join(root, '.git', 'hooks'), (note) => ctx.skip(note));
      const log = vi.fn();
      expect(installGitHooks({ root, env: isolatedEnv(), log })).toMatchObject({ action: 'skipped', reason: 'outside-git-dir' });
      expect(readdir(outside)).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      // the git directory's own name for the hooks directory, the git directory, then where it leads
      expect(log.mock.calls[0][0]).toBe(
        `[git hooks] the hooks directory ${join(root, '.git', 'hooks')} leads outside the git directory ${join(root, '.git')} (to ${realpathSync.native(outside)}): nothing written.`,
      );
    });
  }

  it('accepts a hooks directory that is a link to a folder inside the git directory', (ctx) => {
    const root = repository();
    const real = join(root, '.git', 'hooks-real');
    mkdirSync(real);
    rmSync(join(root, '.git', 'hooks'), { recursive: true });
    linkDirectory(real, join(root, '.git', 'hooks'), (note) => ctx.skip(note));
    expect(installGitHooks({ root, env: isolatedEnv(), log: vi.fn() }).action).toBe('installed');
    expect(readFileSync(join(real, 'pre-commit'), 'utf8')).toBe(SHIM);
  });

  it('leaves an unmarked hook byte for byte', () => {
    const root = repository();
    const own = Buffer.from('#!/bin/sh\r\necho "my own hook"\r\n', 'utf8');
    writeFileSync(hookOf(root), own);
    expect(installGitHooks({ root, env: isolatedEnv(), log: vi.fn() })).toMatchObject({ action: 'kept', reason: 'own-hook' });
    expect(readFileSync(hookOf(root)).equals(own)).toBe(true);
  });
});

// Commits through the shim: real git (which runs the hook with its own sh), the
// real TypeScript compiler, and a stand-in `pnpm` that runs it for `pnpm
// typecheck` (an install-free pnpm in a temporary directory is not something
// every machine has).
describe('commits through the shim (real git, the real compiler)', () => {
  const require = createRequire(__filename);
  const tsc = slashes(require.resolve('typescript/lib/tsc.js'));
  let bin = '';
  let root = '';

  const typeError = 'export const a: number = "not a number";\n';
  const clean = (n: number) => `export const a: number = ${n};\n`;

  /** Commit `text` as `file`; git sends a hook's output to stderr, so both streams are read as one. */
  function commit(cwd: string, file: string, text: string, message: string, stage: string[] = ['-A']) {
    writeFileSync(join(cwd, file), text);
    gitOk(cwd, ['add', ...stage]);
    const env = isolatedEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
    const result = git(cwd, ['commit', '-q', '-m', message], env);
    return { status: result.status, output: `${result.stdout}${result.stderr}`, head: gitOk(cwd, ['log', '-1', '--format=%s']) };
  }

  beforeAll(() => {
    bin = fresh('bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\n[ "$1" = typecheck ] || { echo "stand-in pnpm: only typecheck, not $*" >&2; exit 64; }\nexec node "${tsc}" --noEmit --strict a.ts\n`,
    );
    chmodSync(join(bin, 'pnpm'), 0o755);

    // main: the tracked hook; old: package.json's typecheck and no hook; bare: neither
    root = repository();
    writeFileSync(join(root, '.gitattributes'), '.githooks/* text eol=lf\n');
    writeFileSync(join(root, 'package.json'), '{\n  "scripts": {\n    "typecheck": "tsc --noEmit"\n  }\n}\n');
    writeFileSync(join(root, 'a.ts'), clean(1));
    rmSync(join(root, '.githooks'), { recursive: true });
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', 'old: no tracked hook']);
    gitOk(root, ['branch', 'old']);
    gitOk(root, ['switch', '-q', '-c', 'bare']);
    gitOk(root, ['rm', '-q', 'package.json']);
    gitOk(root, ['commit', '-q', '-m', 'bare: no typecheck script']);
    gitOk(root, ['switch', '-q', 'main']);
    mkdirSync(join(root, '.githooks'));
    cpSync(join(REPO, TRACKED_HOOK), join(root, TRACKED_HOOK));
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', 'main: tracked hook']);
    expect(installGitHooks({ root, env: isolatedEnv(), log: vi.fn() }).action).toBe('installed');
  });

  it('on a branch that tracks the hook: refuses a type error, from the root and from a subdirectory, and lets a clean commit through', () => {
    const refused = commit(root, 'a.ts', typeError, 'type error');
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(refused.output).toContain('[pre-commit] FAILED: pnpm typecheck reported errors');
    expect(refused.head).toBe('main: tracked hook');

    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'note.txt'), 'x\n');
    const fromSub = commit(join(root, 'sub'), join('..', 'a.ts'), typeError, 'type error from sub');
    expect(fromSub.status).not.toBe(0);
    expect(fromSub.head).toBe('main: tracked hook');

    const passed = commit(root, 'a.ts', clean(2), 'clean');
    expect(passed.status).toBe(0);
    expect(passed.output).toContain('[pre-commit] pnpm typecheck passed');
    expect(passed.head).toBe('clean');
  }, 60_000);

  it('in a linked worktree of a branch made before the hook: runs `pnpm typecheck` itself', () => {
    const linked = fresh('old-worktree');
    gitOk(root, ['worktree', 'add', '-q', linked, 'old']);
    expect(existsSync(join(linked, '.githooks'))).toBe(false);

    const refused = commit(linked, 'a.ts', typeError, 'old: type error');
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('[pre-commit] Running pnpm typecheck (this branch keeps no .githooks/pre-commit)');
    expect(refused.output).toContain('error TS2322');
    expect(refused.head).toBe('old: no tracked hook');

    const passed = commit(linked, 'a.ts', clean(3), 'old: clean');
    expect(passed.status).toBe(0);
    expect(passed.head).toBe('old: clean');
  }, 60_000);

  it('does not run a .githooks/pre-commit the branch does not track', () => {
    const linked = fresh('planted');
    gitOk(root, ['worktree', 'add', '-q', '-b', 'old-planted', linked, 'old']);
    mkdirSync(join(linked, '.githooks'));
    writeFileSync(join(linked, TRACKED_HOOK), '#!/bin/sh\necho "PLANTED HOOK RAN"\nexit 0\n');
    // only a.ts is staged: the planted file stays untracked
    const result = commit(linked, 'a.ts', typeError, 'planted', ['a.ts']);
    expect(result.output).not.toContain('PLANTED HOOK RAN');
    expect(result.output).toContain('[pre-commit] Running pnpm typecheck (this branch keeps no .githooks/pre-commit)');
    expect(result.status).not.toBe(0);
  }, 60_000);

  it('on a branch with neither the hook nor a typecheck script: commits, and prints nothing', () => {
    const linked = fresh('bare-worktree');
    gitOk(root, ['worktree', 'add', '-q', linked, 'bare']);
    const passed = commit(linked, 'a.ts', typeError, 'bare: anything');
    expect(passed.status).toBe(0);
    expect(passed.output).not.toContain('[pre-commit]');
    expect(passed.head).toBe('bare: anything');
  }, 60_000);
});

// The shim run by sh directly, with no pnpm (and no git) on PATH. On Windows,
// the sh git itself runs hooks with; a CI runner without one fails here
// instead of skipping.
function locateSh(): string | null {
  if (isWindows) {
    const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    if (exec.status !== 0) return null;
    const sh = resolve(exec.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe');
    return existsSync(sh) ? sh : null;
  }
  const found = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  return path.startsWith('/') && existsSync(path) ? path : null;
}

describe('the shim run by sh, with no pnpm (and no git) on PATH', () => {
  const sh = locateSh();
  const run = (packageJson: string | null) => {
    expect(sh, 'no sh to run hooks with: CI must have one').not.toBeNull();
    const dir = fresh('shim-run');
    const empty = join(dir, 'empty-bin');
    mkdirSync(empty, { recursive: true });
    if (packageJson !== null) writeFileSync(join(dir, 'package.json'), packageJson);
    writeFileSync(join(dir, 'shim'), SHIM);
    return spawnSync(sh as string, ['shim'], { cwd: dir, env: { PATH: empty }, encoding: 'utf8' });
  };

  it.skipIf(sh === null && !process.env.CI)('refuses the commit with a message when the typecheck has no pnpm to run it', () => {
    const result = run('{ "scripts": { "typecheck": "tsc" } }\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[pre-commit] FAILED: pnpm is not on this shell's PATH");
  });

  // Exit 1 (and that message) means the shim took the manifest for one with a
  // typecheck script; exit 0, for one without.
  for (const [what, manifest, hasScript] of [
    ['the key, spread over lines', '{\n  "scripts": {\n    "typecheck": "tsc"\n  }\n}\n', true],
    ['the key with blanks before its colon', '{ "scripts": { "typecheck" \t : "tsc" } }\n', true],
    ['the key, in a CRLF file without a last newline', '{\r\n  "scripts": {\r\n    "typecheck": "tsc"\r\n  }\r\n}', true],
    ['the key after the word as a value, on one line', '{"scripts":{"check":"typecheck","typecheck":"tsc"}}\n', true],
    ['the word as a value, minified', '{"scripts":{"check":"typecheck","lint":"eslint"}}\n', false],
    ['the word in a list', '{"keywords":["typecheck","lint"]}\n', false],
    ['another script starting with the word', '{"scripts":{"typecheck:browser":"tsc"}}\n', false],
    ['the word quoted inside a string', '{"description":"run \\"typecheck\\": later"}\n', false],
    ['no package.json', null, false],
  ] as const) {
    it.skipIf(sh === null && !process.env.CI)(`reads ${what} as ${hasScript ? 'a typecheck script' : 'no typecheck script'}`, () => {
      const result = run(manifest);
      expect(result.status).toBe(hasScript ? 1 : 0);
      if (hasScript) expect(result.stderr).toContain('pnpm is not on');
      else expect(result.stdout + result.stderr).toBe('');
    });
  }
});
