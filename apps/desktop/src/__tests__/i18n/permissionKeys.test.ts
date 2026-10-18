// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSION_LIST } from '@voxium/shared';

// RoleEditor and ChannelPermissionsEditor render every PERMISSION_LIST entry
// through `t(\`permissions.${key}.name\`)` / `.description` — a template the
// literal-key scans cannot see. A flag added to the shared list without its
// labels renders as the raw key in every role editor (MANAGE_WEBHOOKS, the
// 22nd bit, is what this was written for).

const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));
const locales = readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({
    file,
    bundle: JSON.parse(readFileSync(`${LOCALE_DIR}${file}`, 'utf8')) as { permissions?: Record<string, { name?: unknown; description?: unknown }> },
  }));

describe('permission labels', () => {
  it('covers all 11 locales', () => {
    expect(locales).toHaveLength(11);
  });

  it.each(locales.map((l) => [l.file, l.bundle] as const))('%s labels every shared permission', (_file, bundle) => {
    for (const perm of PERMISSION_LIST) {
      const entry = bundle.permissions?.[perm.key];
      expect(typeof entry?.name, `permissions.${perm.key}.name`).toBe('string');
      expect((entry!.name as string).length, `permissions.${perm.key}.name`).toBeGreaterThan(0);
      expect(typeof entry?.description, `permissions.${perm.key}.description`).toBe('string');
      expect((entry!.description as string).length, `permissions.${perm.key}.description`).toBeGreaterThan(0);
    }
  });
});
