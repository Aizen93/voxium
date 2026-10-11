import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Every translation key the code names literally must exist in every locale.
 *
 * Why this exists: `authStore.login` fell back to `auth.login.loginFailed`
 * for seven months while no locale had the key, so a sign-in attempt that
 * never reached the server (an unreachable API address) showed the user the
 * raw key instead of a sentence. The fallback of getTranslatedError /
 * translateServerError is the path that only runs when something is already
 * wrong, which is exactly when a missing key goes unnoticed in development.
 *
 * Two scans: the fallback keys of the two error helpers, and every direct
 * `t('a.b.c')` literal. Keys built from expressions (templates, ternaries)
 * are covered by the feature-specific parity tests, not here.
 */

const SRC = join(__dirname, '..', '..');
const LOCALES_DIR = join(SRC, 'i18n', 'locales');
const LANGS = ['en', 'fr', 'de', 'es', 'pt', 'ru', 'uk', 'ar', 'ja', 'ko', 'zh'];

type Tree = { [k: string]: Tree | string };
const locales = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(join(LOCALES_DIR, `${l}.json`), 'utf-8')) as Tree]));

function resolves(tree: Tree, key: string): boolean {
  const walk = (k: string): boolean => {
    let node: Tree | string = tree;
    for (const part of k.split('.')) {
      if (typeof node !== 'object' || node === null || !(part in node)) return false;
      node = node[part];
    }
    return true;
  };
  // a plural family answers for its base key
  return walk(key) || walk(`${key}_one`) || walk(`${key}_other`);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'locales') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FALLBACK_RE = /(?:getTranslatedError|translateServerError)\([^;]*?,\s*'([a-zA-Z0-9_.]+)'\s*\)/g;
const LITERAL_RE = /\bt\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g;

function collect(re: RegExp): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(re)) found.push({ key: m[1], file: relative(SRC, file) });
  }
  return found;
}

describe('translation keys named in the code exist in every locale', () => {
  it('the error helpers\' fallback keys resolve everywhere', () => {
    const found = collect(FALLBACK_RE);
    expect(found.length).toBeGreaterThan(40);
    const missing = found.flatMap(({ key, file }) => LANGS.filter((l) => !resolves(locales[l], key)).map((l) => `${l}: ${key} (${file})`));
    expect(missing).toEqual([]);
  });

  it('every direct t(\'a.b.c\') literal resolves everywhere', () => {
    const found = collect(LITERAL_RE);
    expect(found.length).toBeGreaterThan(500);
    const missing = found.flatMap(({ key, file }) => LANGS.filter((l) => !resolves(locales[l], key)).map((l) => `${l}: ${key} (${file})`));
    expect(missing).toEqual([]);
  });
});
