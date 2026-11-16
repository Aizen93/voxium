import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// docker-compose.production.yml is what a self-hoster starts. These read it
// as text (no YAML library in the tree, as the workflow tests do) and hold
// the settings the server depends on.

const ROOT = path.resolve(__dirname, '../../../../..');
const compose = readFileSync(path.join(ROOT, 'docker-compose.production.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The YAML block of one service: its header line up to the next service or top-level key ('' when absent). */
function serviceBlock(yml: string, name: string): string {
  const at = yml.indexOf('\nservices:\n');
  if (at === -1) return '';
  const body = yml.slice(at + '\nservices:\n'.length);
  const start = body.search(new RegExp(`^ {2}${name}:\\s*$`, 'm'));
  if (start === -1) return '';
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

/** The `command:` list of a service, one argument per `- ` item. */
function commandList(block: string): string[] {
  const at = block.indexOf('\n    command:\n');
  if (at === -1) return [];
  const items: string[] = [];
  for (const line of block.slice(at + '\n    command:\n'.length).split('\n')) {
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

// DM calls are peer to peer: without a STUN server a client behind NAT only
// offers its private addresses, and calls across networks do not connect.
// The client asks stun:<host of VITE_WS_URL>:3478 (utils/stunUrl.ts), so
// both compose files run a STUN-only coturn there.
describe('docker-compose.production.yml: a STUN server for direct calls', () => {
  const dev = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');
  const stun = settings(serviceBlock(compose, 'stun'));
  const args = commandList(stun);
  const clientPort = Number(/^export const DEFAULT_STUN_PORT = (\d+);$/m.exec(
    readFileSync(path.join(ROOT, 'apps/desktop/src/utils/stunUrl.ts'), 'utf8'),
  )?.[1]);

  it('has a stun service', () => {
    expect(stun).toMatch(/^ {2}stun:$/m);
  });

  it('runs coturn pinned to a minor version (its options change between them)', () => {
    expect(stun).toMatch(/^ {4}image: coturn\/coturn:\d+\.\d+-alpine$/m);
  });

  it('answers STUN only: no TURN relay, no credentials', () => {
    expect(args).toContain('--stun-only');
    expect(args).toContain('--no-auth');
    expect(args).toContain('--no-tls');
    // Nothing that would turn a relay on or hand out credentials
    expect(args.filter((a) => /^--(?:lt-cred-mech|use-auth-secret|static-auth-secret|user|realm|relay-ip|min-port|max-port|dtls)\b/.test(a))).toEqual([]);
  });

  it('listens on the port the client derives, on the host network (coturn then sees the client\'s own address)', () => {
    expect(clientPort).toBe(3478);
    expect(args).toContain(`--listening-port=${clientPort}`);
    expect(stun).toMatch(/^ {4}network_mode: host$/m);
    // Host networking publishes nothing: no ports list to drift from the flag
    expect(stun).not.toMatch(/^ {4}ports:/m);
  });

  it('passes no option the pinned coturn refuses, in either file (4.19 exits on --no-dtls and --no-cli)', () => {
    const devArgs = commandList(settings(serviceBlock(dev, 'stun')));
    expect(devArgs.length).toBeGreaterThan(0);
    for (const list of [args, devArgs]) {
      expect(list.filter((a) => a === '--no-dtls' || a === '--no-cli')).toEqual([]);
    }
  });

  it('runs the same image and the same options as the development compose file', () => {
    const devStun = settings(serviceBlock(dev, 'stun'));
    expect(/^ {4}image: (.+)$/m.exec(devStun)?.[1]).toBe(/^ {4}image: (.+)$/m.exec(stun)?.[1]);
    expect(commandList(devStun)).toEqual(args);
    expect(devStun).toMatch(/^ {4}network_mode: host$/m);
  });

  it('restarts with the stack and keeps its log bounded, like the other services', () => {
    expect(stun).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(stun).toMatch(/^ {8}max-size: "\d+m"$/m);
  });
});
