// Sets French typography in the French locale file, in place: the typographic
// apostrophe (U+2019) between two letters, and a no-break space (U+00A0)
// before `? ! : ;` and inside « ». Run it after adding or editing French
// strings: `node scripts/fix-french-typography.mjs [path-to-fr.json]`.
// Idempotent (a second run changes nothing and writes nothing). The rules are
// in scripts/lib/frenchTypography.mjs; the desktop test holds them for the
// whole file.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setFrenchTypographyInJson } from './lib/frenchTypography.mjs';

const DEFAULT_FILE = fileURLToPath(new URL('../apps/desktop/src/i18n/locales/fr.json', import.meta.url));

/** Rewrites one locale file; returns whether the file changed. */
export function fixFile(file) {
  const before = readFileSync(file, 'utf8');
  const after = setFrenchTypographyInJson(before);
  if (after === before) return false;
  writeFileSync(file, after, 'utf8');
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] ?? DEFAULT_FILE;
  try {
    console.log(fixFile(file) ? `[french typography] rewrote ${file}` : `[french typography] nothing to change in ${file}`);
  } catch (err) {
    console.error(`[french typography] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
