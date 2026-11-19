import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// .gitleaks.toml, the configuration of ci.yml's Security Scan, which the CI
// gate makes a required check. The file held an allowlist and nothing else:
// gitleaks then loads NO rule, and the scan could never find anything (a
// GitHub token in a workflow passed it). It now extends gitleaks' default
// rules, and allowlists the test paths and the dummy values the CI jobs boot
// their servers with, which the default generic rule takes for keys.

const ROOT = path.resolve(__dirname, '../../../../..');
const config = readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8').replace(/\r\n/g, '\n');
const workflowsDir = path.join(ROOT, '.github/workflows');
const workflows = readdirSync(workflowsDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => readFileSync(path.join(workflowsDir, f), 'utf8').replace(/\r\n/g, '\n'))
  .join('\n');

/** The allowlist's regexes, as written between ''' quotes. */
const regexes = [...(/^ {2}regexes = \[\n([\s\S]*?)\n {2}\]$/m.exec(config)?.[1] ?? '').matchAll(/'''(.+?)'''/g)].map((m) => new RegExp(m[1]));
const allowed = (value: string) => regexes.some((r) => r.test(value));

describe('the Gitleaks configuration', () => {
  it('runs gitleaks\' default rules, with its allowlist on top', () => {
    expect(config).toMatch(/^\[extend\]\nuseDefault = true$/m);
    expect(config.indexOf('[extend]')).toBeLessThan(config.indexOf('[allowlist]'));
    expect(config).not.toMatch(/^\[\[rules\]\]/m);
  });

  it('still allowlists the test files', () => {
    for (const p of ["'''__tests__/'''", "'''\\.test\\.ts$'''", "'''\\.spec\\.ts$'''"]) expect(config).toContain(p);
  });

  it('allowlists the dummy values the CI jobs boot their servers with, and nothing a real key looks like', () => {
    expect(regexes.length).toBeGreaterThan(0);
    for (const r of regexes) expect(r.source, 'anchored at both ends').toMatch(/^\^.*\$$/);
    const dummies = [
      ...[...workflows.matchAll(/TOTP_ENCRYPTION_KEY[:=] ?(\S+)/g)].map((m) => m[1]),
      ...[...workflows.matchAll(/JWT_(?:REFRESH_)?SECRET[:=] ?(\S+)/g)].map((m) => m[1]),
    ];
    // ci.yml, server-image.yml and integration-scripts.yml: a TOTP key and two JWT secrets each
    expect(dummies.length).toBeGreaterThanOrEqual(9);
    for (const value of dummies) expect(allowed(value), value).toBe(true);
    // What `openssl rand -hex 32` or a generated secret looks like
    for (let i = 0; i < 20; i++) {
      expect(allowed(randomBytes(32).toString('hex'))).toBe(false);
      expect(allowed(randomBytes(24).toString('base64url'))).toBe(false);
    }
    expect(allowed(`ghp_${randomBytes(27).toString('base64url').slice(0, 36)}`)).toBe(false);
  });

  it('allowlists exactly the six JWT placeholders, not every secret that starts like one', () => {
    for (const job of ['e2e', 'image', 'scripts']) {
      expect(allowed(`ci-${job}-secret-at-least-32-characters-long`)).toBe(true);
      expect(allowed(`ci-${job}-refresh-secret-at-least-32-chars`)).toBe(true);
      // the six cross-combinations of the two endings
      expect(allowed(`ci-${job}-secret-at-least-32-chars`)).toBe(false);
      expect(allowed(`ci-${job}-refresh-secret-at-least-32-characters-long`)).toBe(false);
    }
    expect(allowed('ci-x-secret-deadbeef')).toBe(false);
    expect(allowed(`ci-x-secret-${randomBytes(32).toString('hex')}`)).toBe(false);
    expect(allowed(`ci-e2e-secret-${randomBytes(32).toString('hex')}`)).toBe(false);
    expect(allowed('ci-e2e-secret-at-least-32-characters-long-and-more')).toBe(false);
  });

  it('is code-owned, with the ignore file beside it: either can silence a finding', () => {
    const owners = readFileSync(path.join(ROOT, '.github/CODEOWNERS'), 'utf8').replace(/\r\n/g, '\n');
    expect(owners).toMatch(/^\.gitleaks\.toml\s+@\S+$/m);
    expect(owners).toMatch(/^\.gitleaksignore\s+@\S+$/m);
  });
});

// .gitleaksignore: the findings that are not secrets, by fingerprint, in the
// commit form <commit>:<file>:<rule>:<line> only. gitleaks also accepts the
// file form <file>:<rule>:<line>, but it checks every finding of a GIT scan
// against that form too: an entry for an old false positive would hide any new
// finding later made on the same line of the same file (a new random key at
// that line passed the scan with it, and was found without it), and it goes
// stale without a word when the file shifts.
describe('the Gitleaks ignore file', () => {
  const lines = readFileSync(path.join(ROOT, '.gitleaksignore'), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const COMMIT_FORM = /^([0-9a-f]{40}):([\w./-]+):([\w-]+):(\d+)$/;

  it('holds commit-form fingerprints only, each naming a file of the repository', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const match = COMMIT_FORM.exec(line);
      expect(match, `${line}: every entry starts with a 40-character commit id`).not.toBeNull();
      expect(existsSync(path.join(ROOT, match![2])), match![2]).toBe(true);
    }
  });

  it('holds no file-form entry, which would hide new findings on that line', () => {
    for (const line of lines) expect(line, line).not.toMatch(/^(?![0-9a-f]{40}:)[^:]+:[\w-]+:\d+$/);
  });
});
