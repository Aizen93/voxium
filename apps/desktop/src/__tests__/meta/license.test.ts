// @vitest-environment node
// Pure filesystem check — pins the repo's licensing contract so it cannot
// drift silently (the way packages/crypto-engine once shipped marked
// "Apache-2.0" while the project was AGPL, unnoticed for weeks).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8');

const PACKAGE_JSONS = [
  'package.json',
  'apps/server/package.json',
  'apps/desktop/package.json',
  'apps/admin/package.json',
  'packages/shared/package.json',
  'packages/crypto-engine/package.json',
];

describe('licensing contract (Voxium Community License)', () => {
  it('LICENSE.md is the Voxium Community License', () => {
    const license = read('LICENSE.md');
    expect(license.startsWith('# Voxium Community License')).toBe(true);
    // The AGPL text must never reappear here — history lives in NOTICE.md
    expect(license).not.toMatch(/GNU AFFERO|AGPL/);
  });

  it('every workspace package declares the same custom license reference', () => {
    for (const file of PACKAGE_JSONS) {
      const pkg = JSON.parse(read(file)) as { license?: string };
      expect(pkg.license, file).toBe('SEE LICENSE IN LICENSE.md');
    }
  });

  it('NOTICE.md documents the AGPL boundary precisely', () => {
    const notice = read('NOTICE.md');
    expect(notice).toContain('v1.7.3');
    expect(notice).toContain('e3cb3687af09ea3b9bdcd04ce174b55a6d31561c');
    expect(notice).toContain('AGPL-3.0-only');
    expect(notice).toContain('Voxium Community License 1.0');
  });

  it('the trademark policy exists and is referenced by the license', () => {
    expect(read('TRADEMARK.md')).toContain('Voxium');
    expect(read('LICENSE.md')).toContain('TRADEMARK.md');
  });

  it('README and CONTRIBUTING claim source-available, never open source', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      const text = read(file);
      expect(text, file).toContain('source-available');
      // "open source" as a claim about Voxium would be openwashing under
      // VCL-1.0. (Historical AGPL references are fine — they're what NOTICE.md
      // and the README history line exist for.)
      expect(text, file).not.toMatch(/open[- ]source/i);
    }
  });
});
