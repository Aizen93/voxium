import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * scripts/lib/pg-overlap-guard.cjs, the e2e runtime guard: loaded through
 * NODE_OPTIONS=--require, it records every pg client.query() issued while the
 * same client already has a query active or queued (CI fails on any line).
 * The clients here are never connected: a query on one just waits in its
 * queue, which is exactly the "busy client" state the guard looks for.
 */

const require = createRequire(import.meta.url);
const GUARD = resolve(__dirname, '../../../../../scripts/lib/pg-overlap-guard.cjs');
const SERVER = resolve(__dirname, '../../..');
// The pg @prisma/adapter-pg loads, resolved the way the guard resolves it
const adapterEntry = require.resolve('@prisma/adapter-pg', { paths: [SERVER] });
const pg = require(require.resolve('pg', { paths: [dirname(dirname(adapterEntry))] })) as {
  Client: new (config: object) => { query: (text: string) => Promise<unknown>; _activeQuery?: unknown; _queryQueue: unknown[] };
};

const dir = mkdtempSync(join(tmpdir(), 'pg-overlap-guard-'));
const REPORT = join(dir, 'overlaps.jsonl');
const lines = () => (existsSync(REPORT) ? readFileSync(REPORT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const client = () => new pg.Client({ connectionString: 'postgresql://guard-test.invalid/none' });
// A query on a client that never connects stays queued: never awaited here
const fire = (c: ReturnType<typeof client>, text: string) => { c.query(text).catch(() => {}); };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pg overlap guard', () => {
  it('does nothing without PG_OVERLAP_REPORT', () => {
    delete process.env.PG_OVERLAP_REPORT;
    const before = pg.Client.prototype.query;
    require(GUARD);
    expect(pg.Client.prototype.query).toBe(before);
    delete require.cache[GUARD];
  });

  it('records a query issued on a client that already has one active, with both statements', () => {
    process.env.PG_OVERLAP_REPORT = REPORT;
    require(GUARD);
    const c = client();
    c._activeQuery = { text: 'SELECT "users"."id" FROM "users" WHERE "users"."id" IN ($1)' };
    fire(c, 'SELECT "message_attachments"."id" FROM "message_attachments"');
    const [line] = lines();
    expect(lines()).toHaveLength(1);
    expect(line).toMatchObject({
      pid: process.pid,
      queued: 0,
      query: 'SELECT "message_attachments"."id" FROM "message_attachments"',
      active: 'SELECT "users"."id" FROM "users" WHERE "users"."id" IN ($1)',
    });
    expect(Array.isArray(line.stack)).toBe(true);
  });

  it('records a query issued behind a queued one, and nothing for an idle client', () => {
    rmSync(REPORT, { force: true });
    const idle = client();
    fire(idle, 'SELECT 1'); // idle: nothing active, nothing queued
    expect(lines()).toHaveLength(0);
    fire(idle, 'SELECT 2'); // the first is still queued (never connected)
    expect(lines()).toEqual([expect.objectContaining({ queued: 1, query: 'SELECT 2' })]);
  });

  it('wraps pg once, however many times it is required', () => {
    const wrapped = pg.Client.prototype.query;
    delete require.cache[GUARD];
    require(GUARD);
    expect(pg.Client.prototype.query).toBe(wrapped);
  });

  it('is armed for the blocking e2e steps in CI, and a later step fails on any record', () => {
    const ci = readFileSync(resolve(__dirname, '../../../../../.github/workflows/ci.yml'), 'utf8');
    const step = (name: string) => {
      const start = ci.indexOf(`- name: ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const next = ci.indexOf('\n      - name:', start + 1);
      return ci.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ['E2E tests (Chromium)', 'E2E secure voice (Firefox']) {
      const s = step(name);
      expect(s).toContain('NODE_OPTIONS: --require ${{ github.workspace }}/scripts/lib/pg-overlap-guard.cjs');
      expect(s).toContain('PG_OVERLAP_REPORT: ${{ runner.temp }}/pg-overlaps.jsonl');
    }
    const check = step('No concurrent queries on one pg connection');
    expect(check).toContain('if: ${{ !cancelled() }}');
    expect(check).toContain('REPORT: ${{ runner.temp }}/pg-overlaps.jsonl');
    expect(check).toMatch(/if \[ -s "\$REPORT" \]; then[\s\S]*exit 1/);
  });

  it('never throws into the query it watches when the report cannot be written', () => {
    // The guard took the report path when it loaded: remove its directory
    rmSync(dir, { recursive: true, force: true });
    const c = client();
    c._activeQuery = { text: 'SELECT 1' };
    const write = process.stderr.write;
    const errors: string[] = [];
    process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(() => fire(c, 'SELECT 2')).not.toThrow();
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join('')).toMatch(/\[pg-overlap-guard\] could not record an overlap/);
  });
});
