// @vitest-environment node
// Pure filesystem check: Tailwind generates CSS only for the class names it finds
// in the sources the stylesheet names. Its automatic detection read every file of
// the app folder that git does not ignore, other than CSS, binary and lock files:
// the tests, the configs, the public files. A class-like word there added CSS to
// the stylesheet that ships. The stylesheet turns it off and names the app's code
// instead: src without its tests, and index.html (the Vite root, whose <body>
// carries the app's base classes).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(APP, 'src');
const STYLESHEET = join(SRC, 'styles', 'globals.css');
const TESTS = join(SRC, '__tests__');

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const css = withoutComments(readFileSync(STYLESHEET, 'utf8'));
const sourceLines = css.match(/@source\b[^;]*;/g)?.map((line) => line.trim()) ?? [];
const sourcePath = (line: string) => resolve(dirname(STYLESHEET), /"([^"]+)"/.exec(line)![1]);

// Every way a stylesheet brings Tailwind in or widens what it reads: an import of
// tailwindcss or of one of its parts (`tailwindcss/utilities.css`), an @tailwind
// layer, a source, or a JavaScript config or plugin. Tailwind adds the `content`
// paths a config carries, a plugin's own config included, to the sources, so
// whoever adds a plugin edits this test on purpose and checks what it brings.
// @reference is not one of them: it is how a second stylesheet uses @apply, and in
// reference mode Tailwind drops @tailwind utilities, so that stylesheet scans
// nothing.
const TAILWIND_ENTRY = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']|@tailwind\b|@source\b|@config\b|@plugin\b/;
const bringsTailwindIn = (stylesheet: string) => TAILWIND_ENTRY.test(withoutComments(stylesheet));

// Folders the walk for stylesheets skips: the directories the repository's
// .gitignore ignores at any depth, all installed or built output (dependencies,
// Vite's dist, coverage and Playwright reports). Everything else in the app folder
// is read, wherever it sits: a stylesheet beside index.html can be imported by
// globals.css or by main.tsx.
const BUILD_OUTPUT = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'test-results', 'playwright-report', 'blob-report']);

// Test code kept outside src/__tests__ would be read for class names again: the
// one exclusion is that folder. A test file anywhere else counts, and so does a
// folder whose name says it only holds test code.
const TEST_FOLDER = /\/(__tests__|__mocks__|__fixtures__|test-utils)\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Every file under `dir`, as a path relative to the app with forward slashes. */
function walk(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return skip.has(name) ? [] : walk(path, skip);
    return [relative(APP, path).split(sep).join('/')];
  });
}

describe('Tailwind sources (admin)', () => {
  it('turns automatic source detection off, in the one place Tailwind is imported', () => {
    const entries = css.match(/@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["'][^;]*;|@tailwind\b[^;]*;/g) ?? [];
    expect(entries.map((line) => line.trim())).toEqual(['@import "tailwindcss" source(none);']);
  });

  it('names src, src/__tests__ as excluded, and index.html, and nothing else', () => {
    expect([...sourceLines].sort()).toEqual(
      ['@source "../";', '@source not "../__tests__";', '@source "../../index.html";'].sort(),
    );
    expect(css).not.toMatch(/@(config|plugin)\b/);
  });

  it('resolves each source from the stylesheet to the app files it means', () => {
    const resolved = sourceLines.map(sourcePath);
    expect(resolved).toContain(resolve(SRC));
    expect(resolved).toContain(resolve(TESTS));
    expect(resolved).toContain(resolve(APP, 'index.html'));
    for (const path of resolved) expect(existsSync(path), path).toBe(true);
    expect(statSync(resolve(APP, 'index.html')).isFile()).toBe(true);
  });

  it('keeps index.html a source: it is the Vite root and its <body> carries classes', () => {
    const html = readFileSync(join(APP, 'index.html'), 'utf8');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(html).toMatch(/<body class="[^"]*bg-vox-bg-primary/);
    expect(sourceLines).toContain('@source "../../index.html";');
  });

  it('leaves Tailwind to globals.css alone: no other stylesheet of the app folder brings it in or names a source', () => {
    const ignored = readFileSync(join(APP, '..', '..', '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
    for (const name of BUILD_OUTPUT) expect(ignored, `${name}/ in .gitignore`).toContain(`${name}/`);
    const entries = walk(APP, BUILD_OUTPUT)
      .filter((path) => path.endsWith('.css'))
      .filter((path) => bringsTailwindIn(readFileSync(join(APP, path), 'utf8')));
    expect(entries).toEqual(['src/styles/globals.css']);
  });

  it('tells a stylesheet that brings Tailwind in from one that only references it', () => {
    expect(bringsTailwindIn('@reference "../styles/globals.css";\n.card { @apply rounded-lg; }')).toBe(false);
    expect(bringsTailwindIn('@reference "tailwindcss";\n.card { @apply flex; }')).toBe(false);
    expect(bringsTailwindIn('/* @source "../public"; */\n.card { color: red; }')).toBe(false);
    for (const line of [
      '@import "tailwindcss";',
      '@import "tailwindcss/utilities.css" layer(utilities);',
      "@import url('tailwindcss');",
      '@tailwind utilities;',
      '@source "./public";',
      '@config "../tailwind.config.js";',
      '@plugin "@tailwindcss/typography";',
    ]) {
      expect(bringsTailwindIn(line), line).toBe(true);
    }
  });

  it('keeps every test file and test helper folder under src/__tests__, the one path the stylesheet excludes', () => {
    const outside = walk(SRC)
      .filter((path) => !path.startsWith('src/__tests__/'))
      .filter((path) => TEST_FILE.test(path) || TEST_FOLDER.test(path));
    expect(outside).toEqual([]);
  });
});
