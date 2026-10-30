// @vitest-environment node
// Pure filesystem check — pins the supported Node.js runtime so the places that
// name it cannot drift apart again (the server image ran an end-of-life Node 20
// while CI tested 24), and keeps the two Node 25+ traps closed: Corepack is no
// longer bundled, and Node's own Web Storage globals hide jsdom's under vitest 4.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8');

const RUNTIME_MAJOR = 26;
const MINIMUM_MAJOR = 24;

const rootPkg = JSON.parse(read('package.json')) as {
  packageManager: string;
  engines: { node: string };
};
const pnpmVersion = rootPkg.packageManager.replace(/^pnpm@/, '');

describe('supported Node.js runtime', () => {
  it('engines.node names the minimum major', () => {
    expect(rootPkg.engines.node).toBe(`>=${MINIMUM_MAJOR}.0.0`);
  });

  it('both Dockerfile stages run the runtime major, pinned by digest', () => {
    const froms = read('Dockerfile').split(/\r?\n/).filter((l) => l.startsWith('FROM '));
    expect(froms).toHaveLength(2);
    for (const line of froms) {
      expect(line).toMatch(new RegExp(`^FROM node:${RUNTIME_MAJOR}\\.\\d+\\.\\d+-slim@sha256:[0-9a-f]{64} AS (build|production)$`));
    }
  });

  it('the Dockerfile installs exactly the pnpm that package.json names, without Corepack', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).not.toMatch(/corepack (enable|prepare)/i);
    const installs = dockerfile.match(/RUN npm install -g pnpm@\S+/g) ?? [];
    expect(installs).toEqual([`RUN npm install -g pnpm@${pnpmVersion}`, `RUN npm install -g pnpm@${pnpmVersion}`]);
  });

  it('workflows set up Node at the runtime major (the lint/test matrix also keeps the minimum) and never rely on Corepack', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const yml = read(file);
      expect(yml, file).not.toMatch(/corepack (enable|prepare)/i);
      const versions = [...yml.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
      expect(versions.length, file).toBeGreaterThan(0);
      for (const v of versions) {
        // a literal version is the runtime major; the matrix entry is checked below
        if (!v.startsWith('${{')) expect(v, file).toBe(String(RUNTIME_MAJOR));
      }
    }
    expect(read('.github/workflows/ci.yml')).toContain(`node: [${MINIMUM_MAJOR}, ${RUNTIME_MAJOR}]`);
  });

  it('workflows install pnpm through an env var checked to be an exact version, never interpolated into the script', () => {
    for (const [file, count] of [['.github/workflows/ci.yml', 3], ['.github/workflows/release.yml', 1]] as const) {
      const yml = read(file).replace(/\r\n/g, '\n');
      expect(yml, file).not.toMatch(/run:.*\$\{\{\s*steps\.pnpm-ver/);
      const steps = yml.split('\n      - name: ').filter((s) => s.startsWith('Install pnpm\n'));
      expect(steps, file).toHaveLength(count);
      for (const s of steps) {
        expect(s, file).toContain('          PNPM_VERSION: ${{ steps.pnpm-ver.outputs.version }}\n');
        expect(s, file).toContain('[[ $PNPM_VERSION =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || {');
        expect(s, file).toContain('npm install -g "pnpm@$PNPM_VERSION"');
      }
    }
  });

  it('the jsdom suites run with Node Web Storage off (vitest 4 keeps Node\'s storage globals otherwise)', () => {
    for (const file of ['apps/desktop/vitest.config.ts', 'apps/admin/vitest.config.ts']) {
      expect(read(file), file).toContain("execArgv: ['--no-experimental-webstorage']");
    }
  });
});
