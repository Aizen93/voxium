import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkLicenses,
  describeFinding,
  isPackageName,
  judgeLicense,
  validatePolicy,
} from '../../../../../scripts/lib/licensePolicy.mjs';

// The npm licence gate (#111): the decision logic of
// scripts/lib/licensePolicy.mjs on fixtures, the script that drives it on saved
// `pnpm licenses list --json` documents, the tracked policy file, and the job
// of ci.yml that runs it. Offline: no pnpm, no registry.

const ROOT = path.resolve(__dirname, '../../../../..');
const ALLOWED = ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'BlueOak-1.0.0'];

describe('judgeLicense', () => {
  it('accepts a single allowed licence, without regard to case', () => {
    expect(judgeLicense('MIT', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('apache-2.0', ALLOWED)).toEqual({ ok: true });
  });

  it('refuses a copyleft licence and names it', () => {
    for (const license of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'GPL-2.0+', 'SSPL-1.0']) {
      const verdict = judgeLicense(license, ALLOWED);
      expect(verdict, license).toEqual({ ok: false, kind: 'copyleft', terms: [license] });
    }
  });

  it('refuses a licence that is not on the allow-list and is not copyleft by name', () => {
    expect(judgeLicense('EPL-2.0', ALLOWED)).toEqual({ ok: false, kind: 'not-allowed', terms: ['EPL-2.0'] });
    expect(judgeLicense('MPL-2.0', ALLOWED)).toEqual({ ok: false, kind: 'not-allowed', terms: ['MPL-2.0'] });
  });

  it('refuses unknown, missing and unreadable licences', () => {
    for (const license of ['Unknown', 'UNKNOWN', 'UNLICENSED', 'SEE LICENSE IN LICENSE.txt', '', '   ', null, undefined]) {
      const verdict = judgeLicense(license as string | null | undefined, ALLOWED);
      expect(verdict.ok, String(license)).toBe(false);
      expect((verdict as { kind: string }).kind, String(license)).toBe('unknown');
    }
    expect(judgeLicense('(MIT OR', ALLOWED)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(judgeLicense('MIT OR OR ISC', ALLOWED)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(judgeLicense('MIT)', ALLOWED)).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('accepts an OR expression when one alternative is allowed (the Rust gate rule)', () => {
    expect(judgeLicense('(MIT OR GPL-3.0)', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('GPL-3.0-only OR Apache-2.0', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('Apache-2.0 OR MIT', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('(GPL-2.0 OR (LGPL-3.0 OR ISC))', ALLOWED)).toEqual({ ok: true });
  });

  it('refuses an OR expression when no alternative is allowed, naming every blocker', () => {
    expect(judgeLicense('GPL-3.0 OR LGPL-3.0', ALLOWED)).toEqual({ ok: false, kind: 'copyleft', terms: ['GPL-3.0', 'LGPL-3.0'] });
    expect(judgeLicense('MPL-2.0 OR EPL-2.0', ALLOWED)).toMatchObject({ ok: false, kind: 'not-allowed' });
  });

  it('needs every part of an AND expression, in any case of the operator', () => {
    expect(judgeLicense('MIT and ISC', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('(MIT AND BSD-3-Clause)', ALLOWED)).toEqual({ ok: true });
    expect(judgeLicense('MIT AND GPL-3.0', ALLOWED)).toEqual({ ok: false, kind: 'copyleft', terms: ['GPL-3.0'] });
  });

  it('lets AND bind tighter than OR', () => {
    // MIT OR (GPL-3.0 AND ISC): MIT alone is enough
    expect(judgeLicense('MIT OR GPL-3.0 AND ISC', ALLOWED)).toEqual({ ok: true });
    // (GPL-3.0 OR MIT) AND EPL-2.0: the EPL part blocks
    expect(judgeLicense('(GPL-3.0 OR MIT) AND EPL-2.0', ALLOWED)).toEqual({ ok: false, kind: 'not-allowed', terms: ['EPL-2.0'] });
  });

  it('treats "X WITH exception" as one term that is not allowed unless listed', () => {
    expect(judgeLicense('GPL-2.0 WITH Classpath-exception-2.0', ALLOWED)).toMatchObject({ ok: false, kind: 'copyleft' });
    expect(judgeLicense('GPL-2.0 WITH Classpath-exception-2.0', [...ALLOWED, 'GPL-2.0 WITH Classpath-exception-2.0'])).toEqual({ ok: true });
  });
});

describe('validatePolicy', () => {
  it('accepts the shape and returns it', () => {
    const policy = { allowed: ['MIT'], exceptions: [{ package: 'a', license: 'EPL-2.0', reason: 'reviewed' }] };
    expect(validatePolicy(policy)).toEqual({ ...policy, allowedDevelopmentOnly: [] });
  });

  it('refuses an empty allow-list, a missing exceptions list and an exception without a reason', () => {
    expect(() => validatePolicy({ allowed: [], exceptions: [] })).toThrow(/allowed/);
    expect(() => validatePolicy({ allowed: ['MIT'] })).toThrow(/exceptions/);
    expect(() => validatePolicy({ allowed: ['MIT'], exceptions: [{ package: 'a', license: 'EPL-2.0', reason: ' ' }] })).toThrow(/reason/);
    expect(() => validatePolicy({ allowed: ['MIT'], exceptions: [{ package: 'a', reason: 'x' }] })).toThrow(/license/);
    expect(() => validatePolicy(null)).toThrow();
  });

  it('refuses the same exception twice', () => {
    const e = { package: 'a', license: 'EPL-2.0', reason: 'r' };
    expect(() => validatePolicy({ allowed: ['MIT'], exceptions: [e, { ...e }] })).toThrow(/twice/);
  });
});

describe('checkLicenses', () => {
  const tree = {
    MIT: [{ name: 'left-pad', versions: ['1.0.0'] }],
    'Apache-2.0 OR MIT': [{ name: 'dual-ok', versions: ['2.0.0'] }],
    '(MIT OR GPL-3.0)': [{ name: 'dual-choice', versions: ['1.2.3'] }],
    'GPL-3.0': [{ name: 'copyleft-lib', versions: ['3.0.0', '3.1.0'] }],
    Unknown: [{ name: 'mystery', versions: ['0.1.0'] }],
    'EPL-2.0': [{ name: 'layout', versions: ['0.11.1'] }],
  };

  it('refuses copyleft, unknown and unlisted packages and passes the rest, sorted by name', () => {
    const result = checkLicenses(tree, { allowed: ALLOWED, exceptions: [] });

    expect(result.refused.map((f) => f.name)).toEqual(['copyleft-lib', 'layout', 'mystery']);
    expect(result.refused.map((f) => f.kind)).toEqual(['copyleft', 'not-allowed', 'unknown']);
    expect(result.excepted).toEqual([]);
  });

  it('lets a reviewed exception through, by package AND exact licence, and reports it', () => {
    const exceptions = [{ package: 'layout', license: 'EPL-2.0', reason: 'used only in the admin graph; reviewed' }];

    const result = checkLicenses(tree, { allowed: ALLOWED, exceptions });

    expect(result.refused.map((f) => f.name)).toEqual(['copyleft-lib', 'mystery']);
    expect(result.excepted).toHaveLength(1);
    expect(result.excepted[0]).toMatchObject({ name: 'layout', reason: 'used only in the admin graph; reviewed' });
    expect(result.unusedExceptions).toEqual([]);
  });

  it('does not excuse a package whose licence changed since the review', () => {
    const exceptions = [{ package: 'copyleft-lib', license: 'LGPL-3.0', reason: 'was LGPL' }];

    const result = checkLicenses(tree, { allowed: ALLOWED, exceptions });

    expect(result.refused.map((f) => f.name)).toContain('copyleft-lib');
    expect(result.unusedExceptions).toEqual(exceptions);
  });

  it('reports an exception for a package no longer in the tree', () => {
    const exceptions = [{ package: 'gone', license: 'EPL-2.0', reason: 'removed' }];
    expect(checkLicenses(tree, { allowed: ALLOWED, exceptions }).unusedExceptions).toEqual(exceptions);
  });

  it('labels each finding production or development-only when the production names are given', () => {
    const result = checkLicenses(tree, { allowed: ALLOWED, exceptions: [] }, new Set(['layout']));

    expect(result.refused.find((f) => f.name === 'layout')?.production).toBe(true);
    expect(result.refused.find((f) => f.name === 'mystery')?.production).toBe(false);
  });

  it('names the package, its versions and its licence in a finding line', () => {
    const [finding] = checkLicenses({ 'GPL-3.0': [{ name: 'copyleft-lib', versions: ['3.0.0', '3.1.0'] }] }, { allowed: ALLOWED, exceptions: [] }, new Set(['copyleft-lib'])).refused;

    expect(describeFinding(finding)).toBe('copyleft-lib@3.0.0,3.1.0: GPL-3.0 (copyleft licence) [production]');
  });
});

describe('development-only licences', () => {
  const policy = { allowed: ALLOWED, allowedDevelopmentOnly: ['MPL-2.0'], exceptions: [] };
  const tree = {
    'MPL-2.0': [{ name: 'tool', versions: ['1.0.0'] }, { name: 'tool-linux-x64', versions: ['1.0.0'] }, { name: 'shipped', versions: ['2.0.0'] }],
    'MIT OR MPL-2.0': [{ name: 'dual', versions: ['1.0.0'] }],
    'MPL-2.0 OR GPL-3.0': [{ name: 'dual-prod', versions: ['1.0.0'] }],
  };

  it('passes a package under the licence when it is absent from the production tree, and lists it', () => {
    const result = checkLicenses(tree, policy, new Set(['shipped', 'dual-prod']));

    expect(result.developmentOnly.map((f) => f.name)).toEqual(['tool', 'tool-linux-x64']);
    expect(result.refused.map((f) => f.name)).toEqual(['dual-prod', 'shipped']);
  });

  it('refuses the same licence in the production tree with a message that says so', () => {
    const [finding] = checkLicenses({ 'MPL-2.0': [{ name: 'shipped', versions: ['2.0.0'] }] }, policy, new Set(['shipped'])).refused;

    expect(finding.kind).toBe('development-only');
    expect(describeFinding(finding)).toBe('shipped@2.0.0: MPL-2.0 (licence accepted for development-only tooling, but this package is in the production tree) [production]');
  });

  it('refuses it when the production tree is not known (every package counts as production)', () => {
    expect(checkLicenses({ 'MPL-2.0': [{ name: 'tool', versions: ['1.0.0'] }] }, policy).refused).toHaveLength(1);
  });

  it('passes a dual expression on its allowed-everywhere alternative, in production too, without listing it', () => {
    const result = checkLicenses({ 'MIT OR MPL-2.0': tree['MIT OR MPL-2.0'] }, policy, new Set(['dual']));

    expect(result.refused).toEqual([]);
    expect(result.developmentOnly).toEqual([]);
  });

  it('does not accept a licence that is neither allowed nor development-only', () => {
    const result = checkLicenses({ 'GPL-3.0': [{ name: 'tool', versions: ['1.0.0'] }] }, policy, new Set());

    expect(result.refused.map((f) => f.kind)).toEqual(['copyleft']);
  });

  it('refuses a malformed development-only list', () => {
    expect(() => validatePolicy({ allowed: ['MIT'], allowedDevelopmentOnly: 'MPL-2.0', exceptions: [] })).toThrow(/allowedDevelopmentOnly/);
  });
});

describe('exceptions bound to their dependents', () => {
  const tree = { 'EPL-2.0': [{ name: 'layout', versions: ['0.11.1'] }] };
  const policy = {
    allowed: ALLOWED,
    exceptions: [{ package: 'layout', license: 'EPL-2.0', reason: 'only through the CLI', onlyRequiredBy: ['studio-core'] }],
  };

  it('applies while only the named package depends on it', () => {
    const result = checkLicenses(tree, policy, new Set(), () => ['studio-core']);

    expect(result.refused).toEqual([]);
    expect(result.excepted).toHaveLength(1);
  });

  it('stops applying when another package starts to depend on it, and names that package', () => {
    const [finding] = checkLicenses(tree, policy, new Set(), () => ['studio-core', 'app-code']).refused;

    expect(finding.strayDependents).toEqual(['app-code']);
    expect(describeFinding(finding)).toContain('required by app-code');
  });

  it('fails closed when the dependents cannot be read', () => {
    expect(checkLicenses(tree, policy, new Set(), () => null).refused).toHaveLength(1);
    expect(checkLicenses(tree, policy, new Set()).refused).toHaveLength(1);
  });

  it('refuses an empty or malformed onlyRequiredBy', () => {
    const entry = { package: 'layout', license: 'EPL-2.0', reason: 'r' };
    expect(() => validatePolicy({ allowed: ['MIT'], exceptions: [{ ...entry, onlyRequiredBy: [] }] })).toThrow(/onlyRequiredBy/);
    expect(() => validatePolicy({ allowed: ['MIT'], exceptions: [{ ...entry, onlyRequiredBy: 'x' }] })).toThrow(/onlyRequiredBy/);
  });
});

describe('isPackageName', () => {
  it('accepts the names the registry writes, scoped or not, old capitals included', () => {
    for (const name of ['react', 'lodash.merge', '@prisma/studio-core', '@fontsource/inter', 'JSONStream', 'a_b-c~d', '7zip-bin', 'x'.repeat(214)]) {
      expect(isPackageName(name), name).toBe(true);
    }
  });

  it('refuses what a command line would read as an option or as more than one word', () => {
    for (const name of ['-r', '--json', '-', 'a b', ' a', 'a\tb', 'a\nb', '']) {
      expect(isPackageName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('refuses every character a shell interprets', () => {
    for (const ch of ['&', '|', ';', '<', '>', '^', '%', '"', "'", '`', '$', '(', ')', '!', '*', '?', '=', ',', '\\', '{', '}', '[', ']', '#', ':', '+']) {
      expect(isPackageName(`a${ch}b`), ch).toBe(false);
    }
  });

  it('refuses a malformed scope, a path, a leading dot or underscore, a name past 214 characters and a non-string', () => {
    for (const name of ['@scope', '@scope/', '@/name', 'a/b', '@a/b/c', '.hidden', '_private', '@-a/b', '@a/-b', 'x'.repeat(215)]) {
      expect(isPackageName(name), name).toBe(false);
    }
    for (const value of [undefined, null, 7, ['react'], { name: 'react' }]) {
      expect(isPackageName(value)).toBe(false);
    }
  });
});

describe('scripts/check-npm-licenses.mjs', () => {
  let dir: string;
  const script = path.join(ROOT, 'scripts/check-npm-licenses.mjs');

  // A guard on the script's SOURCE TEXT. The rule it holds: no argument list is
  // ever given to a shell, and a word that is not written in the script is a
  // package name that passed isPackageName(). A refactor that keeps the rule
  // updates the strings below.
  it('starts pnpm from one function, through a shell only as ONE command string, and checks a package name before it reaches a command line', () => {
    const src = readFileSync(script, 'utf8');
    expect(src.match(/spawnSync\(/g)).toHaveLength(2);
    expect(src).toContain("spawnSync(`pnpm ${words.join(' ')}`, { ...options, shell: true })");
    expect(src).toContain("spawnSync('pnpm', words, options)");
    // no argument list is ever handed to a shell
    expect(src).not.toMatch(/shell:\s*process\.platform/);
    expect(src.match(/shell: true \}\)/g)).toHaveLength(1);
    const dependents = src.slice(src.indexOf('function pnpmDirectDependents'));
    const guard = dependents.indexOf('if (!isPackageName(name)) return null;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dependents.indexOf('runPnpm('));
    // every other word is written in the script: the two calls, and the two
    // lists `extra` can be
    expect(src.match(/runPnpm\(\[[^\]]*\]\)/g)).toEqual([
      "runPnpm(['licenses', 'list', '--json', ...extra])",
      "runPnpm(['why', name, '-r', '--json'])",
    ]);
    expect(src).toContain("load(option('--input'), [])");
    expect(src).toContain("load(option('--prod-input'), ['--prod'])");
  });

  beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'lic-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const run = (all: unknown, prod: unknown, policy: unknown, why: unknown = {}, env: Record<string, string> = {}) => spawnSync(
    process.execPath,
    [script, '--input', write('all.json', all), '--prod-input', write('prod.json', prod), '--policy', write('policy.json', policy), '--why-input', write('why.json', why)],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', ...env } },
  );

  it('exits 0 on a clean tree', () => {
    const all = { MIT: [{ name: 'a', versions: ['1.0.0'] }], '(MIT OR GPL-3.0)': [{ name: 'b', versions: ['1.0.0'] }] };

    const result = run(all, all, { allowed: ['MIT'], exceptions: [] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Licence tree clean.');
  });

  it('exits 1 and names the package and its licence for a copyleft dependency', () => {
    const all = { MIT: [{ name: 'a', versions: ['1.0.0'] }], 'AGPL-3.0': [{ name: 'bad-dep', versions: ['9.9.9'] }] };

    const result = run(all, { 'AGPL-3.0': all['AGPL-3.0'] }, { allowed: ['MIT'], exceptions: [] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad-dep@9.9.9: AGPL-3.0 (copyleft licence) [production]');
  });

  it('exits 0 for the same tree once the package is a reviewed exception', () => {
    const all = { 'AGPL-3.0': [{ name: 'bad-dep', versions: ['9.9.9'] }] };

    const result = run(all, all, { allowed: ['MIT'], exceptions: [{ package: 'bad-dep', license: 'AGPL-3.0', reason: 'reviewed' }] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('bad-dep@9.9.9: AGPL-3.0: reviewed');
  });

  it('lists the development-only allowances and the exceptions it used, once', () => {
    const all = { 'MPL-2.0': [{ name: 'tool', versions: ['1.0.0'] }], 'EPL-2.0': [{ name: 'layout', versions: ['2.0.0'] }] };
    const policy = {
      allowed: ['MIT'],
      allowedDevelopmentOnly: ['MPL-2.0'],
      exceptions: [{ package: 'layout', license: 'EPL-2.0', reason: 'reviewed reason', onlyRequiredBy: ['cli'] }],
    };

    const result = run(all, { 'EPL-2.0': all['EPL-2.0'] }, policy, { layout: ['cli'] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Tolerated as development-only tooling');
    expect(result.stdout.match(/tool@1\.0\.0: MPL-2\.0/g)).toHaveLength(1);
    expect(result.stdout).toContain('layout@2.0.0: EPL-2.0: reviewed reason');
  });

  it('exits 1 for a development-only licence found in the production tree', () => {
    const all = { 'MPL-2.0': [{ name: 'tool', versions: ['1.0.0'] }] };

    const result = run(all, all, { allowed: ['MIT'], allowedDevelopmentOnly: ['MPL-2.0'], exceptions: [] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('this package is in the production tree');
  });

  it('exits 1 when a bound exception gains a dependent it does not name', () => {
    const all = { 'EPL-2.0': [{ name: 'layout', versions: ['2.0.0'] }] };
    const policy = { allowed: ['MIT'], exceptions: [{ package: 'layout', license: 'EPL-2.0', reason: 'r', onlyRequiredBy: ['cli'] }] };

    const result = run(all, all, policy, { layout: ['cli', 'app'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required by app');
  });

  it('fails when pnpm reported no packages, for an empty object or list', () => {
    for (const empty of [{}, []]) {
      const result = run(empty, { MIT: [{ name: 'a', versions: ['1.0.0'] }] }, { allowed: ['MIT'], exceptions: [] });

      expect(result.status, JSON.stringify(empty)).toBe(1);
      expect(result.stderr).toContain('pnpm reported no packages');
      expect(result.stdout).not.toContain('Licence tree clean');
    }
  });

  it('fails when the production listing is empty, so a development-only licence cannot pass', () => {
    const all = { 'MPL-2.0': [{ name: 'tool', versions: ['1.0.0'] }] };
    const policy = { allowed: ['MIT'], allowedDevelopmentOnly: ['MPL-2.0'], exceptions: [] };

    for (const empty of [{}, []]) {
      const result = run(all, empty, policy);

      expect(result.status, JSON.stringify(empty)).toBe(1);
      expect(result.stderr).toContain('no production packages');
      expect(result.stdout).not.toContain('Licence tree clean');
    }
  });

  describe('text from package metadata is never read as a workflow command', () => {
    const hostile = [
      'evil\n::error::injected',
      '::warning::at the start',
      'x\r\n::stop-commands::token',
      '100%\n::add-mask::secret',
    ];
    const all = {
      MIT: [{ name: 'fine', versions: ['1.0.0'] }],
      [`GPL-3.0\n::error::licence-line`]: [{ name: hostile[0], versions: ['1.0.0\n::warning::version'] }, { name: hostile[1], versions: ['1.0.0'] }],
      [`Weird\r\n::stop-commands::licence`]: [{ name: hostile[2], versions: ['1.0.0'] }],
      'MPL-2.0': [{ name: hostile[3], versions: ['1.0.0'] }],
      'EPL-2.0': [{ name: 'layout\n::error::excepted', versions: ['2.0.0'] }],
    };
    const policy = {
      allowed: ['MIT'],
      allowedDevelopmentOnly: ['MPL-2.0'],
      exceptions: [
        { package: 'layout\n::error::excepted', license: 'EPL-2.0', reason: 'why\n::error::reason' },
        { package: 'gone\n::error::unused', license: 'MIT', reason: 'r' },
      ],
    };
    const prod = { MIT: all.MIT };

    /** Every line of both streams that begins with `::`. */
    const commandLines = (r: { stdout: string; stderr: string }) =>
      `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => l.startsWith('::'));

    it('prints no line of its own beginning with :: outside a workflow run', () => {
      const result = run(all, prod, policy);

      expect(result.status).toBe(1);
      expect(commandLines(result)).toEqual([]);
      // the text is still there, on one line, with the break shown
      expect(result.stderr).toContain('evil\\n::error::injected');
    });

    it('inside a workflow run, only its own annotations begin with :: and their text is encoded', () => {
      const result = run(all, prod, policy, {}, { GITHUB_ACTIONS: 'true' });

      expect(result.status).toBe(1);
      const lines = commandLines(result);
      // one ::error:: per refused package (3 of 4: the MPL-2.0 one is development-only), one for the summary, one ::warning:: for the unused exception
      expect(lines.filter((l) => l.startsWith('::error::'))).toHaveLength(4);
      expect(lines.filter((l) => l.startsWith('::warning::'))).toHaveLength(1);
      expect(lines).toHaveLength(5);
      for (const line of lines) {
        expect(line, line).toMatch(/^::(error|warning)::/);
        // after the prefix, no further command opener at a line start and no raw % that a line break could hide behind
        expect(line.slice(line.indexOf('::', 2) + 2)).not.toMatch(/[\r\n]/);
      }
      expect(result.stdout).not.toMatch(/(^|\n)::/);
    });

    it('encodes % in an annotation message', () => {
      const result = run({ 'GPL-3.0': [{ name: '100%\nname', versions: ['1.0.0'] }] }, { MIT: [{ name: 'a', versions: ['1'] }] }, { allowed: ['MIT'], exceptions: [] }, {}, { GITHUB_ACTIONS: 'true' });

      expect(result.stderr).toContain('::error::100%25\\nname@1.0.0: GPL-3.0');
    });
  });

  it('exits 1 on an unusable policy file', () => {
    const result = run({}, {}, { allowed: [], exceptions: [] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The licence policy is unusable');
  });
});

describe('the tracked policy and its CI job', () => {
  const policy = JSON.parse(readFileSync(path.join(ROOT, 'scripts/npm-license-policy.json'), 'utf8'));
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('names the two reviewed exceptions and the development-only class', () => {
    const valid = validatePolicy(policy);

    expect(valid.allowedDevelopmentOnly).toEqual(['MPL-2.0']);
    expect(valid.exceptions.map((e) => `${e.package} ${e.license}`).sort()).toEqual(['@fontsource/inter OFL-1.1', 'elkjs EPL-2.0']);
    expect(valid.exceptions.find((e) => e.package === 'elkjs')?.onlyRequiredBy).toEqual(['@prisma/studio-core']);
  });

  it('is well formed and allows no copyleft identifier', () => {
    const { allowed } = validatePolicy(policy);
    for (const id of allowed) {
      expect(judgeLicense(id, allowed), id).toEqual({ ok: true });
      expect(id, id).not.toMatch(/GPL|SSPL|EUPL|MPL|EPL|CDDL/i);
    }
  });

  it('puts the check in ci.yml as a job the gate waits for, with no job-level condition', () => {
    const start = ci.indexOf('\n  licenses:\n');
    expect(start, 'job licenses').toBeGreaterThan(-1);
    const next = ci.indexOf('\n  build:\n', start);
    const block = ci.slice(start, next);

    expect(block).toMatch(/^ {4}timeout-minutes: \d+$/m);
    expect(block).not.toMatch(/^ {4}if:/m);
    expect(block).toContain('node scripts/check-npm-licenses.mjs');
    expect(block).toContain('pnpm install --frozen-lockfile');
    expect(/^ {4}needs: \[([^\]]*)\]$/m.exec(ci.slice(ci.indexOf('\n  ci-ok:\n')))?.[1]).toContain('licenses');
  });
});
