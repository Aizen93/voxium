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

// The Contributors page shows a person's GitHub username, profile link and
// avatar to everyone. Nobody is put there by default: the author asks for it.
describe('public credit', () => {
  const CONTRIBUTORS_PAGE = 'https://voxium.app/contributors';

  it('the pull request template asks before a contributor is listed on the public page, in an optional unticked checkbox', () => {
    const lines = read('.github/pull_request_template.md').split(/\r?\n/);
    const boxes = lines.filter((l) => l.includes(CONTRIBUTORS_PAGE));
    expect(boxes).toHaveLength(1);
    const box = boxes[0];
    expect(box.startsWith('- [ ] Optional: ')).toBe(true);
    // what is shown, so the tick is an informed one
    for (const shown of ['GitHub username', 'profile link', 'avatar', 'name']) expect(box).toContain(shown);
    // opt-in, and not for ever
    expect(box).toContain('Left unticked, you are not listed');
    expect(box).toContain('added or removed at any time');
  });

  it('is the only optional box, after the confirmations every pull request makes', () => {
    const boxes = read('.github/pull_request_template.md').split(/\r?\n/).filter((l) => l.startsWith('- [ ] '));
    expect(boxes.filter((l) => l.startsWith('- [ ] Optional: '))).toHaveLength(1);
    expect(boxes[boxes.length - 1]).toContain(CONTRIBUTORS_PAGE);
    expect(boxes[0]).toContain(TERMS_ANCHOR);
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

  it('the issue-template chooser offers the private form first', () => {
    const chooser = read('.github/ISSUE_TEMPLATE/config.yml').replace(/\r\n/g, '\n');
    // Blank issues stay off: every public issue goes through a template
    expect(chooser).toMatch(/^blank_issues_enabled: false$/m);
    const links = [...chooser.matchAll(/^ {2}- name: (.+)\n {4}url: (\S+)$/gm)].map((m) => ({ name: m[1], url: m[2] }));
    expect(links[0]).toEqual({ name: 'Report a security vulnerability', url: PRIVATE_REPORT_URL });
    expect(links.map((l) => l.url)).toContain('https://github.com/Aizen93/voxium/discussions');
  });
});
