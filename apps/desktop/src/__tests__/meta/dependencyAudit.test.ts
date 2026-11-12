// @vitest-environment node
// Pure filesystem check: a high or critical advisory in a production dependency
// fails CI (it used to be a step that could never fail), the tooling audit stays
// informational, and the update bot never touches the crypto engine, whose
// vodozemac pin is deliberate and watched by crypto-deps-watch.yml. The Tauri
// family (crates, CLI, api, plugins) moves only by hand and at one minor. The
// desktop shell's Cargo.lock is cargo-audited, and every advisory it ignores
// carries its reason beside the entry.
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

  it('the production audit blocks on high and critical advisories, and on a registry error', () => {
    const prod = step(ci, 'Security audit (production dependencies)');
    expect(prod).toContain('pnpm audit --prod --audit-level=high');
    expect(prod).not.toContain('continue-on-error');
    expect(prod).not.toContain('--ignore-registry-errors');
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

  it('dependabot waits the same three days as the install guard before proposing a release', () => {
    const bot = read('.github/dependabot.yml');
    const minutes = /^minimumReleaseAge: (\d+)$/m.exec(read('pnpm-workspace.yaml'))?.[1];
    expect(minutes, 'minimumReleaseAge').toBeDefined();
    const days = Number(minutes) / (24 * 60);
    expect(days).toBe(3);
    for (const name of ['npm', 'cargo', 'github-actions']) {
      expect(ecosystem(bot, name), name).toContain(`    cooldown:\n      default-days: ${days}\n`);
    }
    const ecosystems = bot.match(/package-ecosystem:/g) ?? [];
    expect(bot.match(/^ {4}cooldown:$/gm) ?? []).toHaveLength(ecosystems.length);
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

describe('the minimatch override', () => {
  const overrides = (JSON.parse(read('package.json')) as { pnpm: { overrides: Record<string, string> } }).pnpm
    .overrides;

  it('moves only the vulnerable range, so a minimatch 3 dependent keeps its own major', () => {
    // GHSA-g3hv-75wg-m249: >=7.0.0 <11.0.1. Unscoped, the override would hand
    // minimatch 11 to anything asking for 3 (whose export is a bare function)
    expect(overrides).not.toHaveProperty('minimatch');
    expect(overrides['minimatch@>=7 <11.0.1']).toBe('>=11.0.1 <12');
  });

  it('the lockfile records the same override', () => {
    expect(read('pnpm-lock.yaml')).toContain("  minimatch@>=7 <11.0.1: '>=11.0.1 <12'\n");
  });
});

describe('desktop shell Cargo.lock audit', () => {
  const workflow = read('.github/workflows/desktop-shell.yml');
  const config = read('apps/desktop/src-tauri/.cargo/audit.toml');

  /** The `ignore = [ ... ]` entries of audit.toml, each with the comment lines right above it. */
  function ignores(): { id: string; comment: string }[] {
    const start = config.indexOf('\nignore = [\n');
    expect(start, 'ignore list').toBeGreaterThan(-1);
    const lines = config.slice(start + '\nignore = [\n'.length, config.indexOf('\n]', start)).split('\n');
    const found: { id: string; comment: string }[] = [];
    let comment: string[] = [];
    for (const line of lines) {
      const entry = /^\s*"([^"]+)",?\s*$/.exec(line);
      if (entry) {
        found.push({ id: entry[1], comment: comment.join(' ') });
        comment = [];
      } else if (/^\s*#/.test(line)) {
        comment.push(line.replace(/^\s*#\s?/, ''));
      } else {
        expect(line.trim(), `unexpected line in the ignore list: ${line}`).toBe('');
        comment = [];
      }
    }
    return found;
  }

  it('runs cargo audit in the shell directory on its changes and weekly, and its failure fails the job', () => {
    expect(workflow).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'/);
    const audit = step(workflow, 'RustSec advisory audit');
    expect(audit).toContain('cargo install cargo-audit --locked');
    expect(audit).toMatch(/\n {10}cargo audit\n?$/);
    expect(audit).not.toContain('continue-on-error');
    // The config file is the one place an advisory is ignored
    expect(audit).not.toContain('--ignore');
    const job = workflow.slice(workflow.indexOf('\n  audit:\n'));
    expect(job).toContain('working-directory: apps/desktop/src-tauri');
    expect(job).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });

  it('fails on an unsound advisory, not only on a vulnerability', () => {
    expect(config).toMatch(/^\[output\]\ndeny = \["unsound"\]$/m);
  });

  it('documents every ignored advisory right above its entry', () => {
    const list = ignores();
    expect(list.length).toBeGreaterThan(0);
    for (const { id, comment } of list) {
      expect(id, 'a RustSec id').toMatch(/^RUSTSEC-\d{4}-\d{4}$/);
      // The id itself, and a reason long enough to say why and what lifts it
      expect(comment, id).toContain(id);
      expect(comment.length, `${id}: the reason`).toBeGreaterThan(120);
    }
  });

  it('ignores glib 0.18 as upstream-blocked by the GTK3 bindings', () => {
    const glib = ignores().find((i) => i.id === 'RUSTSEC-2024-0429');
    expect(glib).toBeDefined();
    expect(glib!.comment).toContain('GHSA-wrw7-89jp-8q8g');
    expect(glib!.comment).toContain('glib 0.18.5');
    expect(glib!.comment).toMatch(/Upstream-blocked until Tauri's Linux backend leaves the GTK3 bindings/);
  });
});
