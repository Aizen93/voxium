import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HEARTBEAT_EXPIRY_WAIT_MS, HEARTBEAT_PATTERN, foreignNodeProblem } from '../../../../../scripts/lib/nodeHeartbeats.mjs';

// The pre-flight heartbeat check of scripts/test-multi-node.ts (beside
// portProbe.test.ts: the root scripts' helpers are tested in this suite).
// No Redis: the keys come from a list the test controls, on a clock it moves.

/** A clock that only `sleep` advances, and the sleeps asked for. */
function fakeTime() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

describe('foreignNodeProblem', () => {
  it('answers at once, without waiting or logging, when no heartbeat is left', async () => {
    const time = fakeTime();
    const log = vi.fn();
    const list = vi.fn(async () => [] as string[]);

    await expect(foreignNodeProblem({ list, log, ...time })).resolves.toBeNull();

    expect(list).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('waits for a leftover heartbeat to expire, says so once, and then lets the run start', async () => {
    const time = fakeTime();
    const log = vi.fn();
    // gone at the fourth look, as a key whose TTL ran out
    const answers = [['node:alive:dev'], ['node:alive:dev'], ['node:alive:dev'], []];
    const list = vi.fn(async () => answers.shift() ?? []);

    await expect(foreignNodeProblem({ list, log, pollMs: 1000, ...time })).resolves.toBeNull();

    expect(list).toHaveBeenCalledTimes(4);
    expect(time.sleeps).toEqual([1000, 1000, 1000]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('dev');
    expect(log.mock.calls[0][0]).toContain('expire');
  });

  it('refuses, naming the nodes, when a heartbeat is still there after the wait: a server is running', async () => {
    const time = fakeTime();
    const list = vi.fn(async () => ['node:alive:node-b', 'node:alive:node-a']);

    const problem = await foreignNodeProblem({ list, timeoutMs: 5000, pollMs: 1000, ...time });

    expect(problem).toContain('node-a, node-b');
    expect(problem).toContain('keeps it alive');
    // looked for the whole wait, not past it
    expect(time.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(list).toHaveBeenCalledTimes(6);
  });

  it('waits longer than a heartbeat lives by default', () => {
    // NODE_HEARTBEAT_TTL_S in apps/server/src/utils/redis.ts
    const redis = readFileSync(path.resolve(__dirname, '../../utils/redis.ts'), 'utf8');
    const ttl = /NODE_HEARTBEAT_TTL_S\s*=\s*(\d+)/.exec(redis);
    expect(ttl).not.toBeNull();
    expect(HEARTBEAT_EXPIRY_WAIT_MS).toBeGreaterThan(Number(ttl![1]) * 1000);
  });

  it('scans the pattern the server writes its heartbeat under', () => {
    const redis = readFileSync(path.resolve(__dirname, '../../utils/redis.ts'), 'utf8');
    expect(redis).toContain('`node:alive:${nodeId}`');
    expect(HEARTBEAT_PATTERN).toBe('node:alive:*');
  });

  it('a failing list is the caller\'s error, never read as "no node"', async () => {
    const time = fakeTime();
    const list = vi.fn(async () => { throw new Error('redis down'); });

    await expect(foreignNodeProblem({ list, ...time })).rejects.toThrow('redis down');
  });
});

describe('scripts/test-multi-node.ts', () => {
  const script = readFileSync(path.resolve(__dirname, '../../../../../scripts/test-multi-node.ts'), 'utf8');

  it('checks the heartbeats before it starts a node', () => {
    const check = script.indexOf('foreignNodeProblem(');
    const firstStart = script.indexOf("startServer(NODE1_PORT, 'node-1'");
    expect(check).toBeGreaterThan(-1);
    expect(firstStart).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstStart);
  });

  it('the stale-heartbeat scenario waits past the server\'s count cache and follow-up delay', () => {
    const redis = readFileSync(path.resolve(__dirname, '../../utils/redis.ts'), 'utf8');
    const visibility = readFileSync(path.resolve(__dirname, '../../utils/channelVisibilityRooms.ts'), 'utf8');
    const value = (source: string, name: string): number => {
      const match = new RegExp(`\\b${name}\\s*=\\s*([\\d_]+)`).exec(source);
      expect(match, name).not.toBeNull();
      return Number(match![1].replace(/_/g, ''));
    };
    expect(value(script, 'GHOST_HEARTBEAT_TTL_S')).toBe(value(redis, 'NODE_HEARTBEAT_TTL_S'));
    expect(value(script, 'LIVE_NODES_MEMO_WAIT_MS')).toBeGreaterThan(value(visibility, 'LIVE_NODES_MEMO_MS'));
    expect(value(script, 'FOLLOW_UP_WAIT_MS')).toBeGreaterThan(value(visibility, 'NODE_HEARTBEAT_TTL_MS') + value(visibility, 'RESYNC_FOLLOW_UP_MARGIN_MS'));
    expect(script).toContain(`'${HEARTBEAT_PATTERN.replace('*', 'mn-ghost')}'`);
  });
});
