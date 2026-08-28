import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ANNOTATION_LIVE_POINTER_RATE_PER_MIN,
  ANNOTATION_LIVE_REACTION_RATE_PER_MIN,
  ANNOTATION_LIVE_SNAPSHOT_RATE_PER_MIN,
  ANNOTATION_REACTIONS,
} from '@voxium/shared';

// voice:annotation:live — the ephemeral sibling of :ops. No Redis write, no
// rev, no ack; per-kind authorization and per-kind rate buckets.

const mockRedis = vi.hoisted(() => ({
  mGet: vi.fn().mockResolvedValue([null, null]),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

import { handleAnnotationEvents } from '../../websocket/annotationHandler';
import { socketRateLimit } from '../../middleware/rateLimiter';

const CHANNEL = 'chan-1';
const SHARER = 'user-1';
const VIEWER = 'user-2';

function setup(userId: string, rooms: string[] = [`voice:${CHANNEL}`]) {
  const handlers = new Map<string, Function>();
  const toEmit = vi.fn();
  const socket = {
    id: `socket-${userId}`,
    data: { userId },
    rooms: new Set(rooms),
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
    to: vi.fn().mockReturnValue({ emit: toEmit }),
    emit: vi.fn(),
  };
  handleAnnotationEvents({} as never, socket as never);
  const live = handlers.get('voice:annotation:live')!;
  return { socket, toEmit, send: (data: unknown) => live(data) as Promise<void> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(socketRateLimit).mockReturnValue(true);
  mockRedis.get.mockResolvedValue(SHARER);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('voice:annotation:live — authorization', () => {
  it('the active sharer may point; the event is broadcast to voice:{id} with the sender excluded', async () => {
    const { socket, toEmit, send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.5, y: 0.25 } });
    expect(mockRedis.get).toHaveBeenCalledWith(`voice:screen:${CHANNEL}`);
    expect(socket.to).toHaveBeenCalledWith(`voice:${CHANNEL}`);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:live', { channelId: CHANNEL, userId: SHARER, ev: { k: 'pointer', x: 0.5, y: 0.25 } });
    // Nothing persisted
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('a viewer may NOT point (pointer and pointer-off are sharer-only)', async () => {
    const { toEmit, send } = setup(VIEWER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.5, y: 0.5 } });
    await send({ channelId: CHANNEL, ev: { k: 'pointer-off' } });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('nobody may point when no share is active', async () => {
    mockRedis.get.mockResolvedValue(null);
    const { toEmit, send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.5, y: 0.5 } });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('caches a POSITIVE sharer check for ~2 s and never caches a miss (fail closed)', async () => {
    vi.useFakeTimers();
    const { toEmit, send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.1, y: 0.1 } });
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.2, y: 0.2 } });
    await send({ channelId: CHANNEL, ev: { k: 'pointer-off' } });
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    expect(toEmit).toHaveBeenCalledTimes(3);

    // Handoff: the slot now belongs to someone else. Until the cache expires
    // the previous sharer's dot still goes through (harmless: it fades)…
    mockRedis.get.mockResolvedValue('someone-else');
    vi.advanceTimersByTime(2_100);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.3, y: 0.3 } });
    expect(mockRedis.get).toHaveBeenCalledTimes(2);
    expect(toEmit).toHaveBeenCalledTimes(3);
    // …and a miss is re-checked every time, never remembered
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.4, y: 0.4 } });
    expect(mockRedis.get).toHaveBeenCalledTimes(3);
  });

  it('the cache is per channel: a cached sharer of chan-1 is re-checked for chan-2', async () => {
    const { send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.1, y: 0.1 } });
    await send({ channelId: 'chan-2', ev: { k: 'pointer', x: 0.1, y: 0.1 } });
    expect(mockRedis.get).toHaveBeenCalledTimes(2);
    expect(mockRedis.get).toHaveBeenLastCalledWith('voice:screen:chan-2');
  });

  it('reactions and snapshot notices are open to any member of the voice room, without a Redis round trip', async () => {
    const { toEmit, send } = setup(VIEWER);
    await send({ channelId: CHANNEL, ev: { k: 'reaction', e: 0 } });
    await send({ channelId: CHANNEL, ev: { k: 'snapshot' } });
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(toEmit).toHaveBeenCalledTimes(2);
    expect(toEmit).toHaveBeenCalledWith('voice:annotation:live', { channelId: CHANNEL, userId: VIEWER, ev: { k: 'reaction', e: 0 } });
  });

  it('a socket outside the voice room may not react or notify', async () => {
    const { toEmit, send } = setup(VIEWER, ['voice:other-channel']);
    await send({ channelId: CHANNEL, ev: { k: 'reaction', e: 1 } });
    await send({ channelId: CHANNEL, ev: { k: 'snapshot' } });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it('a Redis failure during the sharer check drops the event and warns, never throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('ECONNRESET'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { toEmit, send } = setup(SHARER);
    await expect(send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.1, y: 0.1 } })).resolves.toBeUndefined();
    expect(toEmit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('voice:annotation:live — validation', () => {
  it('drops malformed envelopes and unknown kinds silently', async () => {
    const { toEmit, send } = setup(SHARER);
    for (const bad of [
      null, 'x', {}, { channelId: 7, ev: { k: 'pointer', x: 0, y: 0 } },
      { channelId: CHANNEL }, { channelId: CHANNEL, ev: null }, { channelId: CHANNEL, ev: { k: 'cursor' } },
      { channelId: 'c'.repeat(65), ev: { k: 'pointer-off' } },
    ]) {
      await send(bad);
    }
    expect(toEmit).not.toHaveBeenCalled();
    expect(socketRateLimit).not.toHaveBeenCalled(); // shape is checked before anything is charged
  });

  it('rejects out-of-bounds / non-finite pointer coordinates and extra fields', async () => {
    const { toEmit, send } = setup(SHARER);
    for (const ev of [
      { k: 'pointer', x: 1.2, y: 0 }, { k: 'pointer', x: 0, y: -0.2 }, { k: 'pointer', x: NaN, y: 0 },
      { k: 'pointer', x: '0.5', y: 0 }, { k: 'pointer', x: 0.5 }, { k: 'pointer', x: 0.5, y: 0.5, z: 1 },
      { k: 'pointer-off', x: 1 }, { k: 'snapshot', text: 'hi' },
    ]) {
      await send({ channelId: CHANNEL, ev });
    }
    expect(toEmit).not.toHaveBeenCalled();
    // Edge of the slack is fine
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: -0.1, y: 1.1 } });
    expect(toEmit).toHaveBeenCalledTimes(1);
  });

  it('reactions are an INDEX into the allowlist, never a string', async () => {
    const { toEmit, send } = setup(VIEWER);
    for (const e of [-1, ANNOTATION_REACTIONS.length, 1.5, '👍', '0']) {
      await send({ channelId: CHANNEL, ev: { k: 'reaction', e } });
    }
    expect(toEmit).not.toHaveBeenCalled();
    await send({ channelId: CHANNEL, ev: { k: 'reaction', e: ANNOTATION_REACTIONS.length - 1 } });
    expect(toEmit).toHaveBeenCalledTimes(1);
  });
});

describe('voice:annotation:live — rate buckets', () => {
  it('each kind charges its OWN bucket, none of them the :ops bucket', async () => {
    const { socket, send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.1, y: 0.1 } });
    await send({ channelId: CHANNEL, ev: { k: 'pointer-off' } });
    await send({ channelId: CHANNEL, ev: { k: 'reaction', e: 2 } });
    await send({ channelId: CHANNEL, ev: { k: 'snapshot' } });
    const buckets = vi.mocked(socketRateLimit).mock.calls.map((c) => [c[1], c[2]]);
    expect(buckets).toEqual([
      ['voice:annotation:live:pointer', ANNOTATION_LIVE_POINTER_RATE_PER_MIN],
      ['voice:annotation:live:pointer', ANNOTATION_LIVE_POINTER_RATE_PER_MIN],
      ['voice:annotation:live:reaction', ANNOTATION_LIVE_REACTION_RATE_PER_MIN],
      ['voice:annotation:live:snapshot', ANNOTATION_LIVE_SNAPSHOT_RATE_PER_MIN],
    ]);
    expect(vi.mocked(socketRateLimit).mock.calls.every((c) => c[0] === socket)).toBe(true);
    expect(buckets.some(([b]) => b === 'voice:annotation:ops')).toBe(false);
  });

  it('a rate-limited event is dropped before any authorization work', async () => {
    vi.mocked(socketRateLimit).mockReturnValue(false);
    const { toEmit, send } = setup(SHARER);
    await send({ channelId: CHANNEL, ev: { k: 'pointer', x: 0.1, y: 0.1 } });
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(toEmit).not.toHaveBeenCalled();
  });
});
