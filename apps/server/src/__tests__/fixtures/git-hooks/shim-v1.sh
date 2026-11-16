#!/bin/sh
# voxium-pre-commit-shim: v1
# Written by scripts/install-git-hooks.mjs, which `pnpm install` runs. It runs
# the pre-commit hook of the branch being committed: .githooks/pre-commit when
# the branch tracks it, else `pnpm typecheck` when package.json has that script
# (a branch made before the hook was kept in the repository), else nothing.
# To keep a hook of your own here, put it in place of this file: the installer
# never replaces a file without the marker line above.

if git ls-files --error-unmatch -- .githooks/pre-commit >/dev/null 2>&1 && [ -f .githooks/pre-commit ]; then
  exec sh .githooks/pre-commit "$@"
fi

# Shell builtins only: a check that needed a missing tool would let the commit through.
has_typecheck_script() {
  [ -f package.json ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in *'"typecheck"'*:*) return 0 ;; esac
  done < package.json
  return 1
}

if has_typecheck_script; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[pre-commit] FAILED: pnpm is not on this shell's PATH, so the typecheck cannot run" >&2
    exit 1
  fi
  echo "[pre-commit] Running pnpm typecheck (this branch keeps no .githooks/pre-commit)..."
  if ! pnpm typecheck; then
    echo "[pre-commit] FAILED: pnpm typecheck reported errors; fix them, then commit again" >&2
    exit 1
  fi
  echo "[pre-commit] pnpm typecheck passed"
fi
exit 0
