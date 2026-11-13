// @vitest-environment node
// Pure filesystem check: the Tauri shell (apps/desktop/src-tauri) is compiled,
// formatted, linted and unit-tested by .github/workflows/desktop-shell.yml on
// every change to it, on Windows (share_bar.rs and dev_console.rs exist only
// there). ci.yml compiles no Rust, so without these steps a shell change is
// green until the release build.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/desktop-shell.yml');

/** The YAML block of one job, from its `  <id>:` line to the next job. */
function job(id: string): string {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const start = jobs.indexOf(`\n  ${id}:\n`);
  expect(start, `job "${id}"`).toBeGreaterThan(-1);
  const next = jobs.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return jobs.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** The YAML block of one step of `block`, from its `- name:` line to the next step. */
function step(block: string, name: string): string {
  const start = block.indexOf(`      - name: ${name}\n`);
  expect(start, `step "${name}"`).toBeGreaterThan(-1);
  const next = block.indexOf('\n      - name: ', start + 1);
  return block.slice(start, next === -1 ? undefined : next);
}

describe('desktop shell workflow', () => {
  it('runs on every pull request and develop push that touches the shell', () => {
    const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\nconcurrency:'));
    for (const trigger of ['push', 'pull_request']) {
      const block = on.slice(on.indexOf(`\n  ${trigger}:\n`));
      expect(block, trigger).toMatch(/paths:\n(?: {6}- .+\n)*? {6}- 'apps\/desktop\/src-tauri\/\*\*'/);
    }
  });

  it('checks the shell on Windows with formatting, clippy and the unit tests', () => {
    const check = job('check');
    expect(check).toContain('runs-on: windows-latest');
    expect(check).toContain('working-directory: apps/desktop/src-tauri');
    // dtolnay/rust-toolchain installs the minimal profile: no rustfmt, no clippy
    expect(step(check, 'Install Rust stable')).toMatch(/components: .*rustfmt/);
    expect(step(check, 'Install Rust stable')).toMatch(/components: .*clippy/);
    expect(step(check, 'cargo fmt --check')).toContain('run: cargo fmt --check');
    expect(step(check, 'cargo check')).toContain('run: cargo check --locked');
    // Every target (the test modules too), and a warning is a failure
    expect(step(check, 'cargo clippy')).toContain('run: cargo clippy --locked --all-targets -- -D warnings');
    expect(step(check, 'cargo test')).toContain('run: cargo test --locked --lib');
  });

  it('never lets a check pass by failing quietly or hang until the runner limit', () => {
    const check = job('check');
    expect(check).not.toContain('continue-on-error');
    const limit = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(check)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(60);
  });
});
