// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DM_SYSTEM_NOTICES } from '@voxium/shared';
import { dmNoticeTranslation, supportNoticeTranslation } from '../../utils/systemNotices';

// A missing translation renders the raw key. Every key the notice mapper can
// return must exist in all 11 locales, and one that takes a name must keep its
// {{name}} placeholder; the components must reach the mapper.

const SOURCES = [
  fileURLToPath(new URL('../../components/dm/DMMessageList.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/dm/DMList.tsx', import.meta.url)),
  fileURLToPath(new URL('../../components/dm/SupportTicketView.tsx', import.meta.url)),
];
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const SUPPORT_SAMPLES = [
  'Support ticket opened',
  'Support ticket reopened',
  'Staff member Dana has joined the conversation',
  'Ticket closed by Dana',
];
const translations = [
  ...DM_SYSTEM_NOTICES.map((s) => dmNoticeTranslation(s)),
  ...SUPPORT_SAMPLES.map((s) => supportNoticeTranslation(s)),
].map((n) => n as NonNullable<typeof n>);

function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, bundle: JSON.parse(readFileSync(LOCALE_DIR + f, 'utf8')) as unknown }));

describe('system notice keys', () => {
  it('covers all 11 locales and every sample maps', () => {
    expect(locales).toHaveLength(11);
    expect(translations.every((n) => n && n.key)).toBe(true);
  });

  for (const { name, bundle } of locales) {
    it(`${name} has every key, with {{name}} where a name is interpolated`, () => {
      for (const n of translations) {
        const value = lookup(bundle, n.key);
        expect(typeof value, `${name}: ${n.key}`).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
        if (n.params) expect(value as string, `${name}: ${n.key}`).toContain('{{name}}');
        else expect(value as string, `${name}: ${n.key}`).not.toContain('{{');
      }
    });
  }

  it('the components go through the mapper', () => {
    for (const file of SOURCES) expect(readFileSync(file, 'utf8')).toContain("utils/systemNotices'");
  });
});
