// @vitest-environment node
// Pure filesystem check — pins the two ways in from outside the project: every
// pull request confirms the contribution terms (the license grant that keeps
// the code relicensable), and a security problem has a private way to be
// reported instead of a public issue.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8');
// Wrapped prose: compare on single spaces
const flat = (s: string) => s.replace(/\s+/g, ' ');

const TERMS_ANCHOR = 'CONTRIBUTING.md#license-and-contributions';
const PRIVATE_REPORT_URL = 'https://github.com/Aizen93/voxium/security/advisories/new';

describe('contribution terms', () => {
  it('CONTRIBUTING.md holds the license grant the pull request template links to', () => {
    const contributing = read('CONTRIBUTING.md');
    // GitHub derives the #license-and-contributions anchor from this heading
    expect(contributing).toMatch(/^## License and contributions\r?$/m);
    expect(flat(contributing)).toContain('sublicense, and relicense your contribution');
    expect(flat(contributing)).toContain('under any other terms, including commercial licenses');
  });

  it('the pull request template asks for the terms in an unticked checkbox', () => {
    const lines = read('.github/pull_request_template.md').split(/\r?\n/);
    const box = lines.find((l) => l.includes(TERMS_ANCHOR));
    expect(box).toBeDefined();
    expect(box?.startsWith('- [ ] ')).toBe(true);
  });
});

describe('security disclosure', () => {
  it('SECURITY.md sends reports to the private form, never to a public issue', () => {
    const policy = flat(read('SECURITY.md'));
    expect(policy).toContain(PRIVATE_REPORT_URL);
    expect(policy).toContain('Please do not report a security problem in a public issue');
  });

  it('CONTRIBUTING.md and the pull request template point to SECURITY.md', () => {
    expect(read('CONTRIBUTING.md')).toContain('[SECURITY.md](SECURITY.md)');
    expect(read('.github/pull_request_template.md')).toContain('SECURITY.md');
  });
});
