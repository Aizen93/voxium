// @vitest-environment node
// Pure filesystem check. In Chromium-based engines (the Windows webview too) an
// element with the standard `scrollbar-width` property set ignores the
// `::-webkit-scrollbar` rules of globals.css, so its pane paints the grey native
// scrollbar instead of the app's themed one. A component therefore never sets
// `scrollbarWidth` inline: it relies on the global scrollbar theme.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const COMPONENTS = join(SRC, 'components');

// A file allowed to mention `scrollbarWidth`, with the reason. Empty on purpose.
const ALLOWED: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('no inline scrollbarWidth in components', () => {
  const files = sourceFiles(COMPONENTS);

  it('reads the component sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('sets scrollbarWidth in no component file', () => {
    const offenders = files
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .filter((rel) => !(rel in ALLOWED))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('scrollbarWidth'));
    expect(offenders, `inline scrollbarWidth hides the themed scrollbar: ${offenders.join(', ')}`).toEqual([]);
  });
});
