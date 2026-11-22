import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRedis, mockPublish, mockSubscribe, mockIsNodeAlive, mockReapMirror } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  },
  mockPublish: vi.fn().mockResolvedValue(1),
  mockSubscribe: vi.fn().mockResolvedValue(undefined),
  mockIsNodeAlive: vi.fn().mockResolvedValue(false),
  mockReapMirror: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
  getRedisPubSub: vi.fn().mockReturnValue({ pub: { publish: mockPublish }, sub: {} }),
  getRedisConfigSub: vi.fn().mockReturnValue({ subscribe: mockSubscribe }),
  NODE_ID: vi.fn().mockReturnValue('node-A'),
  isNodeAlive: mockIsNodeAlive,
}));

// The reap is mocked; the departure announcement is the real one
vi.mock('../../utils/voiceMirror', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/voiceMirror')>()),
  reapVoiceChannelMirror: mockReapMirror,
}));

import {
  initVoiceRelay, handleRelayMessage, relayVoiceEvent,
  resolveOrClaimChannelOwner, getOrCreateShim, dropShim,
  _resetVoiceRelayForTests,
} from '../../websocket/voiceRelay';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockIO() {
  const emitFn = vi.fn();
  const socketsJoin = vi.fn();
  const socketsLeave = vi.fn();
  return {
    to: vi.fn().mockReturnValue({ emit: emitFn }),
    in: vi.fn().mockReturnValue({ socketsJoin, socketsLeave, fetchSockets: vi.fn().mockResolvedValue([]) }),
    _emit: emitFn,
    _socketsJoin: socketsJoin,
    _socketsLeave: socketsLeave,
  };
}

function reset() {
  vi.clearAllMocks();
  _resetVoiceRelayForTests();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.eval.mockResolvedValue(1);
  mockIsNodeAlive.mockResolvedValue(false);
  mockPublish.mockResolvedValue(1);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('voiceRelay — resolveOrClaimChannelOwner', () => {
  let io: ReturnType<typeof createMockIO>;
  const noSessionHere = () => false;
  beforeEach(() => {
    reset();
    io = createMockIO();
  });

  it('returns self immediately when this node already owns the channel', async () => {
    mockRedis.get.mockResolvedValueOnce('node-A');
    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-A');
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  it('returns a LIVE peer owner without claiming', async () => {
    mockRedis.get.mockResolvedValueOnce('node-B');
    mockIsNodeAlive.mockResolvedValueOnce(true);
    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-B');
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockReapMirror).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  it('takes over from a DEAD owner ATOMICALLY (Lua CAS) and reaps the stale mirror', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.get.mockResolvedValueOnce('node-B');
    mockIsNodeAlive.mockResolvedValueOnce(false);
    mockRedis.eval.mockResolvedValueOnce(1); // CAS won

    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-A');
    // Compare-and-swap: only claim if the key still records the dead node
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      { keys: ['voice:channel:node:ch-1'], arguments: ['node-B', 'node-A', '90'] },
    );
    // Reap preserves the node key we just claimed
    expect(mockReapMirror).toHaveBeenCalledWith('ch-1', { preserveNodeKey: true });
    // No plain (non-atomic) SET on the takeover path
    expect(mockRedis.set).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('yields to a concurrent takeover when the CAS loses (no split-brain double claim)', async () => {
    mockRedis.get.mockResolvedValueOnce('node-B');   // observed dead owner
    mockIsNodeAlive.mockResolvedValueOnce(false);
    mockRedis.eval.mockResolvedValueOnce(0);         // CAS lost — peer took over first
    mockRedis.get.mockResolvedValueOnce('node-C');   // re-read: the winner

    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-C');
    expect(mockReapMirror).not.toHaveBeenCalled();   // the winner's mirror is untouched
    expect(io.to).not.toHaveBeenCalled();            // and the winner announces, not us
  });

  it('claims an unowned channel atomically (SET NX)', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValueOnce('OK');
    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-A');
    expect(mockRedis.set).toHaveBeenCalledWith('voice:channel:node:ch-1', 'node-A', { NX: true, EX: 90 });
    expect(io.to).not.toHaveBeenCalled();
  });

  it('yields to the winner when the NX claim is lost', async () => {
    mockRedis.get.mockResolvedValueOnce(null);   // initial read: unowned
    mockRedis.set.mockResolvedValueOnce(null);   // NX lost
    mockRedis.get.mockResolvedValueOnce('node-C'); // re-read: the winner
    expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-C');
    expect(io.to).not.toHaveBeenCalled();
  });

  describe('a won takeover announces the departures it reaped', () => {
    function deadOwnerWithCasWon() {
      mockRedis.get.mockResolvedValueOnce('node-B');
      mockIsNodeAlive.mockResolvedValueOnce(false);
      mockRedis.eval.mockResolvedValueOnce(1);
    }

    it('one voice:user_left per reaped occupant, to the channel room, with the epoch its entry held', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deadOwnerWithCasWon();
      mockReapMirror.mockResolvedValueOnce([{ userId: 'u-1' }, { userId: 'u-2', epoch: 'epochAAAA0001' }]);

      expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-A');

      // Announced before the claim returns, so ahead of the join that follows
      expect(io._emit).toHaveBeenCalledTimes(2);
      expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-1', userId: 'u-1' });
      expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-1', userId: 'u-2', epoch: 'epochAAAA0001' });
      // The VIEW_CHANNEL boundary, never the space's room
      expect(io.to.mock.calls).toEqual([['channel:ch-1'], ['channel:ch-1']]);
      warnSpy.mockRestore();
    });

    it('nothing is announced for a user who already holds a session in the channel on this node', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deadOwnerWithCasWon();
      mockReapMirror.mockResolvedValueOnce([{ userId: 'u-live' }, { userId: 'u-gone' }]);
      const holdsSessionHere = vi.fn((userId: string) => userId === 'u-live');

      await resolveOrClaimChannelOwner(io as never, 'ch-1', holdsSessionHere);

      expect(holdsSessionHere).toHaveBeenCalledWith('u-live');
      expect(io._emit).toHaveBeenCalledTimes(1);
      expect(io._emit).toHaveBeenCalledWith('voice:user_left', { channelId: 'ch-1', userId: 'u-gone' });
      warnSpy.mockRestore();
    });

    it('a failing announcement is logged by its message and never undoes the won claim', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deadOwnerWithCasWon();
      mockReapMirror.mockResolvedValueOnce([{ userId: 'u-1' }]);
      io.to.mockImplementationOnce(() => { throw new Error('adapter closed'); });

      expect(await resolveOrClaimChannelOwner(io as never, 'ch-1', noSessionHere)).toBe('node-A');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[VoiceRelay] Announcing the departures from channel ch-1 failed'), 'adapter closed');
      warnSpy.mockRestore();
    });
  });
});

describe('voiceRelay — relayVoiceEvent', () => {
  beforeEach(reset);
  afterEach(() => vi.useRealTimers());

  const socket = { id: 's-1', data: { userId: 'u-1' } };

  it('publishes the event envelope to the owner node\'s relay channel', async () => {
    await relayVoiceEvent('node-B', 'voice:mute', socket, [true]);
    expect(mockPublish).toHaveBeenCalledWith(
      'voice:relay:node-B',
      JSON.stringify({ kind: 'req', fromNode: 'node-A', socketId: 's-1', userId: 'u-1', event: 'voice:mute', args: [true] }),
    );
  });

  it('forwards the owner\'s ACK response back to the client callback', async () => {
    const ack = vi.fn();
    await relayVoiceEvent('node-B', 'voice:produce', socket, [{ kind: 'audio' }], ack);

    const envelope = JSON.parse(mockPublish.mock.calls[0][1] as string);
    expect(envelope.id).toBeDefined();

    await handleRelayMessage(JSON.stringify({ kind: 'rep', id: envelope.id, response: { producerId: 'p-1' } }));
    expect(ack).toHaveBeenCalledWith({ producerId: 'p-1' });
  });

  it('times out a dead owner with an error-shaped ACK (client never hangs)', async () => {
    vi.useFakeTimers();
    const ack = vi.fn();
    await relayVoiceEvent('node-B', 'voice:produce', socket, [{}], ack);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(ack).toHaveBeenCalledWith({ error: 'Voice node timeout' });

    // A late reply after the timeout must NOT double-invoke the callback
    const envelope = JSON.parse(mockPublish.mock.calls[0][1] as string);
    await handleRelayMessage(JSON.stringify({ kind: 'rep', id: envelope.id, response: { producerId: 'late' } }));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('shapes the screen_share:start timeout as { ok: false }', async () => {
    vi.useFakeTimers();
    const ack = vi.fn();
    await relayVoiceEvent('node-B', 'voice:screen_share:start', socket, [], ack);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Voice node timeout' });
  });

  it('settles the ACK with an error when the publish itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    const ack = vi.fn();
    await relayVoiceEvent('node-B', 'voice:produce', socket, [{}], ack);
    expect(ack).toHaveBeenCalledWith({ error: 'Voice relay unavailable' });
    errorSpy.mockRestore();
  });
});

describe('voiceRelay — handleRelayMessage (owner side)', () => {
  beforeEach(reset);

  async function initWithDispatcher() {
    const io = createMockIO();
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    await initVoiceRelay(io as never, dispatcher);
    expect(mockSubscribe).toHaveBeenCalledWith('voice:relay:node-A', expect.any(Function));
    return { io, dispatcher };
  }

  function req(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      kind: 'req', fromNode: 'node-B', socketId: 's-9', userId: 'u-9',
      event: 'voice:mute', args: [true], ...overrides,
    });
  }

  it('dispatches a relayed event against a shim carrying the participant identity', async () => {
    const { dispatcher } = await initWithDispatcher();
    await handleRelayMessage(req());

    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-9', data: expect.objectContaining({ userId: 'u-9' }) }),
      'voice:mute', [true], undefined,
    );
  });

  it('reuses the SAME shim across events so socket.data persists (join → later events)', async () => {
    const { dispatcher } = await initWithDispatcher();
    await handleRelayMessage(req({ event: 'voice:join', args: ['ch-1', null] }));
    await handleRelayMessage(req({ event: 'voice:mute', args: [true] }));

    const shim1 = dispatcher.mock.calls[0][0];
    const shim2 = dispatcher.mock.calls[1][0];
    expect(shim2).toBe(shim1);
  });

  it('the shim\'s emit/join/leave use adapter-wide primitives (reach the home node)', async () => {
    const { io } = await initWithDispatcher();
    const shim = getOrCreateShim(io as never, 's-9', 'u-9');

    shim.emit('voice:error', { message: 'nope' });
    expect(io.to).toHaveBeenCalledWith('s-9');
    expect(io._emit).toHaveBeenCalledWith('voice:error', { message: 'nope' });

    shim.join('voice:ch-1');
    expect(io.in).toHaveBeenCalledWith('s-9');
    expect(io._socketsJoin).toHaveBeenCalledWith('voice:ch-1');

    shim.leave('voice:ch-1');
    expect(io._socketsLeave).toHaveBeenCalledWith('voice:ch-1');
    dropShim('s-9');
  });

  it('publishes the ACK response back to the requesting node', async () => {
    const { dispatcher } = await initWithDispatcher();
    dispatcher.mockImplementationOnce(async (_shim, _event, _args, ack) => {
      (ack as (r: unknown) => void)({ producerId: 'p-7' });
    });
    mockPublish.mockClear();

    await handleRelayMessage(req({ id: 'node-B:42', event: 'voice:produce', args: [{}] }));

    expect(mockPublish).toHaveBeenCalledWith(
      'voice:relay:node-B',
      JSON.stringify({ kind: 'rep', id: 'node-B:42', response: { producerId: 'p-7' } }),
    );
  });

  it('drops the shim after a cross-node force_move by a session-less moderator (no leak)', async () => {
    const { dispatcher } = await initWithDispatcher();
    // Moderator relays force_move; their shim never gets a voiceChannelId
    await handleRelayMessage(req({ event: 'voice:force_move', args: [{ userId: 't-1', targetChannelId: 'ch-2' }] }));
    const shimBefore = dispatcher.mock.calls[0][0];

    // A later relayed event creates a FRESH shim — the old one was dropped
    await handleRelayMessage(req({ event: 'voice:force_move', args: [{ userId: 't-1', targetChannelId: 'ch-3' }] }));
    const shimAfter = dispatcher.mock.calls[1][0];
    expect(shimAfter).not.toBe(shimBefore);
  });

  it('keeps the shim after force_move when the moderator DOES have a session on this node', async () => {
    const { dispatcher } = await initWithDispatcher();
    // Simulate a join that established a session on this node (dispatcher sets data)
    dispatcher.mockImplementationOnce(async (shim) => {
      (shim as { data: { voiceChannelId?: string } }).data.voiceChannelId = 'ch-1';
    });
    await handleRelayMessage(req({ event: 'voice:join', args: ['ch-1', null] }));
    const shimBefore = dispatcher.mock.calls[0][0];

    await handleRelayMessage(req({ event: 'voice:force_move', args: [{ userId: 't-1', targetChannelId: 'ch-2' }] }));
    await handleRelayMessage(req({ event: 'voice:mute', args: [true] }));
    const shimAfter = dispatcher.mock.calls[2][0];
    expect(shimAfter).toBe(shimBefore);
  });

  it('drops the shim after a completed leave/disconnect (fresh shim on rejoin)', async () => {
    const { dispatcher } = await initWithDispatcher();
    await handleRelayMessage(req({ event: 'voice:join', args: ['ch-1', null] }));
    const shimBefore = dispatcher.mock.calls[0][0];

    await handleRelayMessage(req({ event: 'voice:leave', args: [] }));
    await handleRelayMessage(req({ event: 'voice:join', args: ['ch-1', null] }));

    const shimAfter = dispatcher.mock.calls[2][0];
    expect(shimAfter).not.toBe(shimBefore);
  });

  it('acks an error when the dispatcher throws (client never hangs)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dispatcher } = await initWithDispatcher();
    dispatcher.mockRejectedValueOnce(new Error('boom'));
    mockPublish.mockClear();

    await handleRelayMessage(req({ id: 'node-B:7', event: 'voice:produce', args: [{}] }));

    expect(mockPublish).toHaveBeenCalledWith(
      'voice:relay:node-B',
      JSON.stringify({ kind: 'rep', id: 'node-B:7', response: { error: 'Voice node error' } }),
    );
    errorSpy.mockRestore();
  });

  it('ignores malformed messages and envelopes without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dispatcher } = await initWithDispatcher();

    await expect(handleRelayMessage('not-json{{{')).resolves.toBeUndefined();
    await expect(handleRelayMessage(JSON.stringify({ kind: 'req', socketId: 42 }))).resolves.toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does nothing before initVoiceRelay wires io + dispatcher', async () => {
    _resetVoiceRelayForTests();
    await expect(handleRelayMessage(req())).resolves.toBeUndefined();
  });
});
