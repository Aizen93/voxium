import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The mail-block page tells the person what the block covers. Every mail
 * sent to a typed address carries the block link (sign-up codes, the
 * existing-account notice, address verification, password reset), so the
 * note must name all of them: a person who blocks from an unwanted sign-up
 * code has to read that the block stops those codes too.
 */

const LOCALES_DIR = join(__dirname, '..', '..', 'i18n', 'locales');
const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

function note(file: string): string {
  const tree = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8')) as {
    auth: { mailBlock: { note: string } };
  };
  return tree.auth.mailBlock.note;
}

describe('auth.mailBlock.note', () => {
  it('names every kind of account mail in English', () => {
    const en = note('en.json');
    for (const kind of ['sign-up codes', 'address verification', 'password reset', 'account notices']) {
      expect(en).toContain(kind);
    }
  });

  it('names the sign-up codes in French, with typographic apostrophes', () => {
    const fr = note('fr.json');
    expect(fr).toContain('codes d’inscription');
    expect(fr).not.toContain("'");
  });

  it.each(localeFiles)('%s lists four kinds of mail, as English does', (file) => {
    // Each translation lists the four kinds in one parenthesis, separated by
    // its own commas (and one conjunction): at least two list separators
    const inside = /[(（]([^)）]*)[)）]/.exec(note(file))?.[1] ?? '';
    expect(inside.split(/[,،、]/).length, file).toBeGreaterThanOrEqual(3);
  });
});
