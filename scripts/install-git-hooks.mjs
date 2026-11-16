// Installs the pre-commit shim that runs the repository's hook
// (.githooks/pre-commit): run by `pnpm install` through the root package.json's
// `prepare`, or by hand after an install that skipped scripts:
// `node scripts/install-git-hooks.mjs`. What it decides, and when it does
// nothing: scripts/lib/gitHooks.mjs.
//
// It never fails the install that runs it. The `prepare` script imports this
// file only when it exists (the server image installs from the manifests alone,
// with no scripts/ folder) and turns a failure to load it into one line.

import { fileURLToPath } from 'node:url';
import { installGitHooks } from './lib/gitHooks.mjs';

try {
  installGitHooks({ root: fileURLToPath(new URL('..', import.meta.url)), env: process.env });
} catch (err) {
  console.warn(`[git hooks] not installed: ${err instanceof Error ? err.message : String(err)}`);
}
