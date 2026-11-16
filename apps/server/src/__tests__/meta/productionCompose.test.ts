import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// docker-compose.production.yml is what a self-hoster starts. These read it
// as text (no YAML library in the tree, as the workflow tests do) and hold
// the settings the server depends on.

const ROOT = path.resolve(__dirname, '../../../../..');
const compose = readFileSync(path.join(ROOT, 'docker-compose.production.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The YAML block of one service: its header line up to the next service or top-level key. */
function serviceBlock(yml: string, name: string): string {
  const at = yml.indexOf('\nservices:\n');
  expect(at, 'services:').toBeGreaterThan(-1);
  const body = yml.slice(at + '\nservices:\n'.length);
  const start = body.search(new RegExp(`^ {2}${name}:\\s*$`, 'm'));
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = body.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$|^\S/m);
  return body.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** The block's lines without comments (a comment may quote a setting it explains). */
function settings(block: string): string {
  return block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** Bytes of a Redis (`256mb`, `1gb`) or Compose (`512M`, `1G`) memory size. */
function bytes(size: string): number {
  const m = /^(\d+)\s*([kmg])?b?$/i.exec(size.trim());
  expect(m, size).not.toBeNull();
  const unit = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m![2] ?? '').toLowerCase() as 'k' | 'm' | 'g'] ?? 1;
  return Number(m![1]) * unit;
}

describe('docker-compose.production.yml: Redis keeps what it holds', () => {
  const redis = settings(serviceBlock(compose, 'redis'));
  const command = /^ {4}command: (.+)$/m.exec(redis)?.[1] ?? '';

  it('starts redis-server with its settings on the command line', () => {
    expect(command).toMatch(/^redis-server /);
  });

  it('never evicts: noeviction, and no eviction policy anywhere in the file', () => {
    expect(command).toMatch(/(?:^| )--maxmemory-policy noeviction(?: |$)/);
    // allkeys-* drops any key, volatile-* any key with a TTL (the single-use
    // marks, the budgets, the locks): neither may come back, in a setting or
    // in a second command line
    expect(settings(compose)).not.toMatch(/allkeys-|volatile-/);
  });

  it('sets a memory limit, and gives the container about twice that (the AOF rewrite forks Redis)', () => {
    const maxmemory = /(?:^| )--maxmemory (\S+)/.exec(command)?.[1];
    expect(maxmemory).toBeDefined();
    const limit = /^ {8}limits:\n(?: {10}.+\n)*? {10}memory: (\S+)$/m.exec(redis)?.[1];
    expect(limit, 'deploy.resources.limits.memory').toBeDefined();
    expect(bytes(limit!)).toBeGreaterThanOrEqual(2 * bytes(maxmemory!));
  });

  it('persists to the append-only file, written to disk every second', () => {
    expect(command).toMatch(/(?:^| )--appendonly yes(?: |$)/);
    expect(command).toMatch(/(?:^| )--appendfsync everysec(?: |$)/);
    expect(serviceBlock(compose, 'redis')).toMatch(/^ {6}- redisdata:\/data$/m);
  });

  it('explains the choice next to the setting', () => {
    const block = serviceBlock(compose, 'redis');
    const comment = block.slice(0, block.indexOf('    command:'));
    expect(comment).toContain('noeviction');
    expect(comment).toMatch(/refuses new writes/);
    expect(comment).toMatch(/INFO memory/);
  });
});
