// @vitest-environment node
// Pure filesystem sweep — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the source tree against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The toast layer is the app's error channel, and the thing that failed is
 * usually the panel currently on top — the theme editor and the marketplace
 * render at z-[9999] behind a backdrop blur, member context menus at
 * z-[10000]. When the toast layer sat at z-[100], an error raised BY one of
 * those modals rendered underneath it and was never seen.
 *
 * So it outranks everything, and this sweeps the source to keep it that way:
 * the regression is not someone lowering the toast, it is someone adding the
 * NEXT modal at a bigger number.
 */

const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TOAST_FILE = join(SRC_DIR, 'components', 'layout', 'ToastContainer.tsx');

/** Every product source file under src/, tests excluded. */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'generated' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, acc);
    else if (/\.(tsx?|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Arbitrary-value Tailwind z utilities and inline zIndex values. */
function zIndexesIn(source: string): number[] {
  return [...source.matchAll(/z-\[(\d+)\]|z-index:\s*(\d+)|zIndex:\s*(\d+)/g)].map((m) =>
    Number(m[1] ?? m[2] ?? m[3]),
  );
}

describe('z-index layering', () => {
  const toastZ = Math.max(...zIndexesIn(readFileSync(TOAST_FILE, 'utf8')));

  it('gives the toast layer an explicit, deliberate z-index', () => {
    expect(Number.isFinite(toastZ)).toBe(true);
    expect(toastZ).toBeGreaterThan(10000);
  });

  it('leaves nothing else in the app able to cover an error toast', () => {
    const offenders: string[] = [];
    for (const file of collectSources(SRC_DIR)) {
      if (file === TOAST_FILE) continue;
      for (const z of zIndexesIn(readFileSync(file, 'utf8'))) {
        if (z >= toastZ) offenders.push(`${file.slice(SRC_DIR.length)} → z-index ${z}`);
      }
    }

    expect(
      offenders,
      `these layers can hide an error toast (toast layer is ${toastZ}):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
