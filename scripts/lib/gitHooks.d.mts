export const TRACKED_HOOK: string;

export const SHIM_VERSION: number;

export const SHIM_MARKER: string;

export const SHIM: string;

/** SHA-256 of every shim text shipped, LF only, by version. */
export const KNOWN_SHIM_SHA256: Readonly<Record<number, string>>;

export const LOCAL_ENV_VARS: readonly string[];

export type GitEnv = Record<string, string | undefined>;

export type GitResult =
  | { missing: true }
  | { failed: string }
  | { status: number | null; stdout: string; stderr: string };

export type InstallResult = {
  action: 'installed' | 'already' | 'kept' | 'skipped';
  reason:
    | 'written'
    | 'replaced'
    | 'current'
    | 'newer'
    | 'own-hook'
    | 'ci'
    | 'no-hook'
    | 'no-git'
    | 'git-failed'
    | 'git-refused'
    | 'no-work-tree'
    | 'other-work-tree'
    | 'hooks-path'
    | 'outside-git-dir'
    | 'not-a-file'
    | 'write-failed';
  /** The line printed after the "[git hooks]" prefix; empty when nothing is printed. */
  message: string;
};

export function gitEnv(env: GitEnv): GitEnv;

export function runGit(args: readonly string[], options: { cwd: string; env: GitEnv }): GitResult;

export function installGitHooks(options: {
  root: string;
  env: GitEnv;
  git?: (args: readonly string[], options: { cwd: string; env: GitEnv }) => GitResult;
  log?: (line: string) => void;
}): InstallResult;
