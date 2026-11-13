import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// scripts/check-keyshare-inbox.ts runs the key-share inbox statements
// (utils/keyShareInbox.ts, docs/e2e-dm-spec.md §12.3) on a real PostgreSQL:
// the route tests mock Prisma and cannot show what the database does with
// them. It is a gate only because the e2e job of CI runs it, on the database
// that job has just migrated: this pins that step where it is.

const REPO = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(REPO, path), 'utf8').replace(/\r\n/g, '\n');

/** One job of a workflow: from its key to the next job's. */
function jobOf(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  expect(start, job).toBeGreaterThan(-1);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** The steps of a job, in order: each one's name and text up to the next step. */
function stepsOf(job: string): Array<{ name: string; text: string }> {
  return job
    .split('\n      - name: ')
    .slice(1)
    .map((text) => ({ name: text.slice(0, text.indexOf('\n')), text }));
}

const CHECK_STEP = 'Key-share inbox statements on PostgreSQL';

describe('the key-share inbox check in CI', () => {
  const e2e = jobOf(read('.github/workflows/ci.yml'), 'e2e');
  const steps = stepsOf(e2e);
  const at = steps.findIndex((s) => s.name === CHECK_STEP);
  const step = steps[at];

  it('runs in the e2e job right after the migrations are applied, before anything else uses the database', () => {
    expect(at, CHECK_STEP).toBeGreaterThan(0);
    expect(steps[at - 1].name).toBe('Apply migrations');
    expect(steps[at - 1].text).toContain('run: npx prisma migrate deploy');
    const firstPlaywright = steps.findIndex((s) => s.name.startsWith('E2E tests'));
    expect(firstPlaywright).toBeGreaterThan(at);
  });

  it('runs the script from the repository root, after building the shared package its inbox module imports', () => {
    expect(step.text).toContain("KEYSHARE_INBOX_CHECK: '1'");
    const build = step.text.indexOf('pnpm build:shared');
    const check = step.text.indexOf('npx tsx scripts/check-keyshare-inbox.ts');
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    // scripts/ is at the root; the script resolves the server's modules from there
    expect(step.text).not.toContain('working-directory');
  });

  it('checks the database the job migrated: the job’s DATABASE_URL, never one of its own', () => {
    // the script loads no .env: DATABASE_URL must be in the environment
    expect(e2e).toMatch(/\n {6}DATABASE_URL: postgresql:\/\/\S+@127\.0\.0\.1:5432\/voxium_e2e\b/);
    expect(step.text).not.toContain('DATABASE_URL');
  });

  it('is blocking: no condition, and a failed check fails the job', () => {
    expect(step.text).not.toMatch(/\n {8}if:/);
    expect(step.text).not.toContain('continue-on-error');
  });
});
