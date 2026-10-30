// @vitest-environment node
// Pure filesystem check: a high or critical advisory in a production dependency
// fails CI (it used to be a step that could never fail), the tooling audit stays
// informational, and the update bot never touches the crypto engine, whose
// vodozemac pin is deliberate and watched by crypto-deps-watch.yml. The Tauri
// family (crates, CLI, api, plugins) moves only by hand and at one minor.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8').replace(/\r\n/g, '\n');

/** The YAML block of one workflow step, from its `- name:` line to the next step. */
function step(yml: string, name: string): string {
  const start = yml.indexOf(`- name: ${name}\n`);
  expect(start, `step "${name}"`).toBeGreaterThan(-1);
  const next = yml.indexOf('\n      - name:', start + 1);
  return yml.slice(start, next === -1 ? undefined : next);
}

/** The dependabot.yml entry of one ecosystem, from its `- package-ecosystem:` line to the next. */
function ecosystem(bot: string, name: string): string {
  const chunks = bot.split(/^ {2}- package-ecosystem: /m).slice(1);
  const found = chunks.filter((c) => c.startsWith(`${name}\n`));
  expect(found, `ecosystem "${name}"`).toHaveLength(1);
  return found[0];
}

describe('dependency audit policy', () => {
  const ci = read('.github/workflows/ci.yml');

  it('the production audit blocks on high and critical advisories', () => {
    const prod = step(ci, 'Security audit (production dependencies)');
    expect(prod).toContain('pnpm audit --prod --audit-level=high');
    expect(prod).not.toContain('continue-on-error');
  });

  it('the full audit (build and test tooling) is reported without blocking', () => {
    const all = step(ci, 'Security audit (all dependencies, informational)');
    expect(all).toContain('pnpm audit --audit-level=high');
    expect(all).toContain('continue-on-error: true');
  });

  it('dependabot proposes npm, cargo and actions updates into develop, never for the crypto engine', () => {
    const bot = read('.github/dependabot.yml');
    expect(bot).toContain('package-ecosystem: npm');
    expect(bot).toContain('directory: /apps/desktop/src-tauri');
    expect(bot).toContain('package-ecosystem: github-actions');
    expect(bot).not.toMatch(/^\s*directory: \/packages\/crypto-engine/m);
    const ecosystems = bot.match(/package-ecosystem:/g) ?? [];
    const targets = bot.match(/target-branch: develop/g) ?? [];
    expect(targets.length).toBe(ecosystems.length);
  });

  it('dependabot never proposes a Tauri minor on its own, for the crates or the packages', () => {
    const bot = read('.github/dependabot.yml');
    const ignoreMinor = (dep: string) =>
      `    ignore:\n      - dependency-name: "${dep}"\n        update-types: ["version-update:semver-minor"]\n`;
    expect(ecosystem(bot, 'cargo')).toContain(ignoreMinor('tauri*'));
    expect(ecosystem(bot, 'npm')).toContain(ignoreMinor('@tauri-apps/*'));
    expect(ecosystem(bot, 'cargo')).not.toContain('@tauri-apps/*');
    expect(ecosystem(bot, 'npm')).not.toContain('"tauri*"');
  });

  it('the Tauri CLI and @tauri-apps/api are both held to one minor, the same one', () => {
    const desktop = JSON.parse(read('apps/desktop/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const api = desktop.dependencies['@tauri-apps/api'];
    const cli = desktop.devDependencies['@tauri-apps/cli'];
    expect(api).toMatch(/^~\d+\.\d+\.\d+$/);
    expect(cli).toMatch(/^~\d+\.\d+\.\d+$/);
    const minor = (spec: string) => spec.slice(1).split('.').slice(0, 2).join('.');
    expect(minor(cli)).toBe(minor(api));
  });
});
