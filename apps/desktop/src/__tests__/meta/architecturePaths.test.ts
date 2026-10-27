// @vitest-environment node
// Pure filesystem check: the architecture document is read from the repository root.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `Architecture.md` names files and directories in backticks. A path that no
 * longer exists is the first sign the document drifted from the code
 * (issue #61), so every path-like token it names must resolve somewhere a
 * reader would look: the repository root or one of the package source roots.
 * Routes, globs and placeholders are not paths; a few directories are named
 * as future work on purpose.
 */

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const DOC = readFileSync(join(ROOT, 'Architecture.md'), 'utf8');

/** Where a relative token may live, in the order a reader would try. */
const SOURCE_ROOTS = ['', 'apps/server', 'apps/server/src', 'apps/desktop', 'apps/desktop/src', 'apps/admin/src', 'packages/shared/src', 'packages/crypto-engine'];

/** Named as planned structure, not as something that exists. */
const FUTURE = new Set(['apps/mobile/', 'packages/ui/']);

const EXTENSIONS = /\.(?:ts|tsx|rs|json|md|yml|yaml|toml|sql|prisma|css|html|js|mjs|cjs)$/;

/** Backticked tokens that read as a file or directory path. */
function pathTokens(markdown: string): string[] {
  const tokens = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  return tokens.filter((t) =>
    t.includes('/')
    && !/^https?:/.test(t)
    && !t.startsWith('/') // API routes and client routes
    && !/[*{}<>|?]/.test(t) // globs and placeholders
    && !/\s/.test(t)
    && (EXTENSIONS.test(t) || t.endsWith('/')),
  );
}

const resolves = (token: string) => SOURCE_ROOTS.some((root) => existsSync(join(ROOT, root, token)));

describe('Architecture.md names only files and directories that exist', () => {
  const tokens = [...new Set(pathTokens(DOC))];

  it('finds the paths it is meant to check (the scan is not vacuous)', () => {
    expect(tokens.length).toBeGreaterThan(40);
    expect(tokens).toContain('utils/permissionCalculator.ts');
  });

  it('every path resolves in the repository', () => {
    const missing = tokens.filter((t) => !FUTURE.has(t) && !resolves(t));
    expect(missing).toEqual([]);
  });

  it('cites nothing under docs/local (git-ignored, so readers cannot open it)', () => {
    expect(DOC).not.toMatch(/docs\/local\//);
  });
});
