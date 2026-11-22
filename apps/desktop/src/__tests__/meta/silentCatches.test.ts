// @vitest-environment node
// A catch that says nothing hides the failure it caught. This scans the
// desktop sources (tests excluded) for an empty `.catch(() => {})`, and for a
// catch block that holds only a comment, and lists the few that are silent on
// purpose, each with its reason.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Silent on purpose: a file and the reason. A file not listed is reported.
const SILENT_ON_PURPOSE: Record<string, string> = {
  'components/auth/RegisterCodeStep.tsx': 'the store holds and shows the error',
  'pages/LoginPage.tsx': 'the store holds and shows the error',
  'pages/RegisterPage.tsx': 'the store holds and shows the error',
  'components/settings/SessionsSection.tsx': 'an unusable language tag falls back to the runtime default',
  'utils/maskStyles.ts': 'inside a handler that already logged; the black box below is what matters',
  'services/tokenStorage.ts': 'a decode failure is reported on the line right below the catch',
  'services/e2e/e2eService.ts': 'the run is reported to its caller; the queue only keeps going',
  'services/e2e/voiceFrameCipher.ts': 'a frame that fails to decrypt is dropped per frame; logging would flood',
};

const EMPTY_ARROW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined)\s*\)/;
const COMMENT_ONLY_CATCH = /\bcatch\s*(\([^)]*\))?\s*\{(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))+\s*\}/;

describe('desktop sources: no silent catches outside the listed ones', () => {
  it('finds none', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (SILENT_ON_PURPOSE[rel]) continue;
      const s = readFileSync(file, 'utf8');
      if (EMPTY_ARROW.test(s) || COMMENT_ONLY_CATCH.test(s)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the list honest: every listed file still exists', () => {
    for (const rel of Object.keys(SILENT_ON_PURPOSE)) {
      expect(() => readFileSync(join(SRC, rel), 'utf8')).not.toThrow();
    }
  });
});
