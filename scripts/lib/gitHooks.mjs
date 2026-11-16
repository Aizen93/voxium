// What scripts/install-git-hooks.mjs decides. `pnpm install` runs it (the root
// package.json's `prepare`) to make git run the pre-commit hook the repository
// keeps in .githooks/.
//
// It writes ONE file, a small shim, at the path git reads its pre-commit hook
// from (`git rev-parse --git-path hooks/pre-commit`: the clone's common hooks
// directory, shared by every worktree). It sets no git config. The shim runs
// the branch's own .githooks/pre-commit, or `pnpm typecheck` on a branch made
// before that file existed, so every branch and every worktree is checked.
//
// It replaces a file there only when its text (line endings aside) is a shim
// this project shipped, one of KNOWN_SHIM_SHA256. Anything else is kept byte
// for byte, and every install says in one line that the repository's hook does
// not run: a hook of your own, a shim edited in place, a hook into which the
// shim was pasted. A newer shim (from a newer branch) is kept silently. With
// core.hooksPath set, or a hooks directory that leads outside the repository's
// git directory (`git rev-parse --git-common-dir`: .git, or .git/modules/<name>
// for a submodule; a link to a folder other repositories share, or into the
// work tree), it writes nothing and says so.
//
// It never fails an install: every outcome is one line on the console (none
// when the current shim is already in place) and a result the caller may
// ignore. It does nothing when CI is set, when the hook file is missing, when
// there is no git to run, when git refuses (outside a work tree, an unsafe
// directory), or when the work tree around it is not this checkout (a copy of
// the sources inside another repository).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The repository's own hook, which the shim runs when the branch tracks it. */
export const TRACKED_HOOK = '.githooks/pre-commit';

/**
 * The shim's version. A change to its text is a new version, with a new entry
 * in KNOWN_SHIM_SHA256: an install replaces a known shim, never a newer one.
 */
export const SHIM_VERSION = 2;

/** The second line of the shim, after its shebang line. */
export const SHIM_MARKER = `# voxium-pre-commit-shim: v${SHIM_VERSION}`;

/**
 * A newer installer's shim: a shebang line, then its marker line, at the very
 * start of the file. Kept silently, so two branches do not rewrite each other.
 */
const NEWER_SHIM_START_RE = /^#![^\r\n]*\r?\n# voxium-pre-commit-shim: v(\d+)\r?\n/;

/** The shim, LF only. Git runs a hook at the root of the work tree that commits. */
export const SHIM = [
  '#!/bin/sh',
  SHIM_MARKER,
  '# Written by scripts/install-git-hooks.mjs, which `pnpm install` runs. It runs',
  '# the pre-commit hook of the branch being committed: .githooks/pre-commit when',
  '# the branch tracks it, else `pnpm typecheck` when package.json has that script',
  '# (a branch made before the hook was kept in the repository), else nothing.',
  '# To keep a hook of your own here, put it in place of this file: the installer',
  '# replaces this file only while it is, unedited, a shim it wrote.',
  '',
  `if git ls-files --error-unmatch -- ${TRACKED_HOOK} >/dev/null 2>&1 && [ -f ${TRACKED_HOOK} ]; then`,
  `  exec sh ${TRACKED_HOOK} "$@"`,
  'fi',
  '',
  '# Shell builtins only: a check that needed a missing tool would let the commit',
  '# through. A key: "typecheck", then any blanks, then a colon (not the word as a',
  '# value or in a list).',
  'has_typecheck_script() {',
  '  [ -f package.json ] || return 1',
  '  while IFS= read -r line || [ -n "$line" ]; do',
  '    while :; do',
  `      case $line in *'"typecheck"'*) ;; *) break ;; esac`,
  `      line=\${line#*'"typecheck"'}`,
  '      rest=$line',
  '      while :; do',
  "        case $rest in ' '*|'\t'*) rest=${rest#?} ;; *) break ;; esac",
  '      done',
  '      case $rest in :*) return 0 ;; esac',
  '    done',
  '  done < package.json',
  '  return 1',
  '}',
  '',
  'if has_typecheck_script; then',
  '  if ! command -v pnpm >/dev/null 2>&1; then',
  `    echo "[pre-commit] FAILED: pnpm is not on this shell's PATH, so the typecheck cannot run" >&2`,
  '    exit 1',
  '  fi',
  `  echo "[pre-commit] Running pnpm typecheck (this branch keeps no ${TRACKED_HOOK})..."`,
  '  if ! pnpm typecheck; then',
  '    echo "[pre-commit] FAILED: pnpm typecheck reported errors; fix them, then commit again" >&2',
  '    exit 1',
  '  fi',
  '  echo "[pre-commit] pnpm typecheck passed"',
  'fi',
  'exit 0',
  '',
].join('\n');

/**
 * The SHA-256 of every shim text this project has shipped, LF only, by
 * version. An installed copy of one of them (CRLF included) is replaced by the
 * current text; nothing else is. Entries are never edited or removed.
 */
export const KNOWN_SHIM_SHA256 = Object.freeze({
  1: '2b088f279302738717cf6ff27e9aba3d751a3df2285eb5d74c516fe7e2bab45b',
  2: '90e8c33dfa0a52597223808793364c7336c2395220dbc5a3e8010ce76834df01',
});

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const PREFIX = '[git hooks]';

/**
 * The variables that make git use another repository, another config or
 * another index than the ones around its working directory: a static copy of
 * what `git rev-parse --local-env-vars` prints (git 2.51). A git hook exports
 * some of them, and GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT carry `git -c`
 * settings (core.hooksPath among them) into every git a process starts.
 */
export const LOCAL_ENV_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/**
 * A copy of `env` without the variables of LOCAL_ENV_VARS.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function gitEnv(env) {
  const clean = { ...env };
  for (const name of LOCAL_ENV_VARS) delete clean[name];
  return clean;
}

/**
 * Run git once. `{ missing: true }` when there is no git to run, `{ failed }`
 * when it could not be started or did not finish in 10 s, else its exit status
 * and its trimmed output.
 *
 * @param {readonly string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined> }} options
 * @returns {import('./gitHooks.d.mts').GitResult}
 */
export function runGit(args, { cwd, env }) {
  const result = spawnSync('git', args, {
    cwd,
    env: gitEnv(env),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    return code === 'ENOENT' ? { missing: true } : { failed: result.error.message };
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * One spelling per path, so that two names of it compare equal: resolved,
 * through links and short names as far as it exists, without case on Windows.
 *
 * @param {string} path
 * @returns {string}
 */
function canonical(path) {
  let existing = resolve(path);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = existsSync(existing) ? join(realpathSync.native(existing), ...rest) : resolve(path);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** @param {string} a @param {string} b */
function samePath(a, b) {
  return canonical(a) === canonical(b);
}

/** The first line of what git printed, for a one-line report. @param {string | undefined} text */
function firstLine(text) {
  return (text ?? '').split(/\r?\n/, 1)[0] || 'no message';
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write the shim at `target` in one step (a commit running meanwhile reads the
 * old file or the new one, never half of it), executable.
 *
 * @param {string} target
 */
function writeShim(target) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.voxium-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, SHIM, { mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

/**
 * Install the shim when nothing of someone else's is in its place.
 *
 * @param {{
 *   root: string,
 *   env: Record<string, string | undefined>,
 *   git?: (args: readonly string[], options: { cwd: string, env: Record<string, string | undefined> }) => import('./gitHooks.d.mts').GitResult,
 *   log?: (line: string) => void,
 * }} options `root` is the checkout's root directory (where package.json and
 *   .githooks/ are); `env` the environment to judge and to run git with.
 * @returns {import('./gitHooks.d.mts').InstallResult}
 */
export function installGitHooks({ root, env, git = runGit, log = console.log }) {
  /** @param {import('./gitHooks.d.mts').InstallResult} result */
  const report = (result) => {
    if (result.message) log(`${PREFIX} ${result.message}`);
    return result;
  };

  // Any value at all: a CI runner, or someone who asked for CI behaviour.
  if (env.CI) {
    return report({ action: 'skipped', reason: 'ci', message: 'CI is set: no hook installed.' });
  }

  if (!existsSync(join(root, TRACKED_HOOK))) {
    return report({ action: 'skipped', reason: 'no-hook', message: `${TRACKED_HOOK} is missing: no hook installed.` });
  }

  // One call: the top of the work tree, the clone's common directory, and the
  // file git would run as the pre-commit hook (core.hooksPath moves that one).
  const paths = git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path', 'hooks/pre-commit'], {
    cwd: root,
    env,
  });
  if ('missing' in paths) {
    return report({ action: 'skipped', reason: 'no-git', message: 'git is not installed: no hook installed.' });
  }
  if ('failed' in paths) {
    return report({ action: 'skipped', reason: 'git-failed', message: `git did not answer (${paths.failed}): no hook installed.` });
  }
  if (paths.status !== 0) {
    // git's own words: "not a git repository" and "dubious ownership" are different stories
    const said = firstLine(paths.stderr);
    return report({
      action: 'skipped',
      reason: /not a git repository/i.test(said) ? 'no-work-tree' : 'git-refused',
      message: `no hook installed: git rev-parse answered "${said}".`,
    });
  }
  const lines = paths.stdout.split(/\r?\n/);
  if (lines.length !== 3 || !lines.every((line) => isAbsolute(line))) {
    return report({
      action: 'skipped',
      reason: 'git-failed',
      message: 'git rev-parse gave an unexpected answer (git older than 2.31?): no hook installed.',
    });
  }
  const [top, commonDir, target] = lines;
  if (!samePath(top, root)) {
    return report({
      action: 'skipped',
      reason: 'other-work-tree',
      message: `the git work tree here is ${top}, not this checkout: no hook installed.`,
    });
  }
  if (!samePath(target, join(commonDir, 'hooks', 'pre-commit'))) {
    return report({
      action: 'skipped',
      reason: 'hooks-path',
      message: `a hooks path is configured (core.hooksPath: git runs hooks from ${dirname(target)}): nothing written there; ${TRACKED_HOOK} runs only if the pre-commit hook in that folder calls it.`,
    });
  }

  // A hooks directory that is a link out of the repository's git directory (to
  // a folder other repositories share, a junction or a symlink, or into the
  // work tree) would carry the shim where it does not belong: refuse it.
  const hooksDir = dirname(target);
  const inside = relative(canonical(commonDir), canonical(hooksDir));
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    // git may print the hooks directory through the link already: name the git directory's own path
    const gitDir = resolve(commonDir);
    const leadsTo = existsSync(hooksDir) ? realpathSync.native(hooksDir) : hooksDir;
    return report({
      action: 'skipped',
      reason: 'outside-git-dir',
      message: `the hooks directory ${join(gitDir, 'hooks')} leads outside the git directory ${gitDir} (to ${leadsTo}): nothing written.`,
    });
  }

  let current = null;
  if (existsSync(target)) {
    if (!statSync(target).isFile()) {
      return report({ action: 'skipped', reason: 'not-a-file', message: `${target} is not a file: left as it is, no hook installed.` });
    }
    current = readFileSync(target, 'utf8');
    if (current === SHIM) return report({ action: 'already', reason: 'current', message: '' });
    const known = Object.values(KNOWN_SHIM_SHA256).includes(sha256(current.replace(/\r\n/g, '\n')));
    if (!known) {
      const newer = NEWER_SHIM_START_RE.exec(current);
      if (newer && Number(newer[1]) > SHIM_VERSION) return report({ action: 'already', reason: 'newer', message: '' });
      return report({
        action: 'kept',
        reason: 'own-hook',
        message: `${target} is a hook of your own: left as it is, so the repository's pre-commit hook (${TRACKED_HOOK}, \`pnpm typecheck\`) does not run. To switch to it, remove or rename that file, then run \`node scripts/install-git-hooks.mjs\`.`,
      });
    }
  }

  try {
    writeShim(target);
  } catch (err) {
    return report({ action: 'skipped', reason: 'write-failed', message: `could not write ${target} (${messageOf(err)}): no hook installed.` });
  }
  return current === null
    ? report({
        action: 'installed',
        reason: 'written',
        message: `pre-commit hook installed (${target}): before each commit, git runs ${TRACKED_HOOK} (\`pnpm typecheck\`).`,
      })
    : report({ action: 'installed', reason: 'replaced', message: `pre-commit hook updated to shim v${SHIM_VERSION} (${target}).` });
}
