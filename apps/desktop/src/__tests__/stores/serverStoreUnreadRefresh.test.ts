import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

/**
 * serverStore.refreshChannelUnread: after a purge the unread counts of the
 * channels it touched are asked of the server (one request per space) and the
 * counts follow the answer: the channel's own and its space's total.
 */

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
vi.mock('../../utils/imageProcessing', () => ({ processImage: vi.fn(), ASSET_UPLOAD_CONTENT_TYPE: 'image/webp' }));

import { useServerStore, resetUnreadRefresh } from '../../stores/serverStore';
import { api } from '../../services/api';
import type { Channel } from '@voxium/shared';

const mockGet = api.get as unknown as Mock;
const state = () => useServerStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const answer = (rows: Array<{ channelId: string; serverId: string; count: number }>) => ({ data: { success: true, data: rows } });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  resetUnreadRefresh();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  useServerStore.setState({
    channels: [],
    activeServerId: null,
    unreadCounts: {},
    serverUnreadCounts: {},
    unreadChannelServers: {},
  });
  state().initUnreadCounts([
    { channelId: 'ch-1', serverId: 'srv-1', count: 40 },
    { channelId: 'ch-2', serverId: 'srv-1', count: 5 },
    { channelId: 'ch-3', serverId: 'srv-2', count: 9 },
  ]);
});
afterEach(() => { warn.mockRestore(); });

describe('serverStore.refreshChannelUnread', () => {
  it('corrects the channel and its space total from the answer, leaving the others as they are', async () => {
    mockGet.mockResolvedValue(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 3 }, { channelId: 'ch-2', serverId: 'srv-1', count: 5 }]));

    await state().refreshChannelUnread(['ch-1']);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-1/channels/unread');
    expect(state().unreadCounts).toEqual({ 'ch-1': 3, 'ch-2': 5, 'ch-3': 9 });
    expect(state().serverUnreadCounts).toEqual({ 'srv-1': 8, 'srv-2': 9 });
  });

  it('a channel the answer omits is read (0): its count, its mapping and the space total go, an emptied space total is dropped', async () => {
    mockGet.mockResolvedValue(answer([]));

    await state().refreshChannelUnread(['ch-3']);

    expect(state().unreadCounts).toEqual({ 'ch-1': 40, 'ch-2': 5 });
    expect(state().serverUnreadCounts).toEqual({ 'srv-1': 45 });
    expect(state().unreadChannelServers['ch-3']).toBeUndefined();
  });

  it('works for a channel of a space that is not on screen (the channel list holds the active space only)', async () => {
    useServerStore.setState({ activeServerId: 'srv-1', channels: [{ id: 'ch-1', serverId: 'srv-1' } as Channel] });
    mockGet.mockResolvedValue(answer([{ channelId: 'ch-3', serverId: 'srv-2', count: 2 }]));

    await state().refreshChannelUnread(['ch-3']);

    expect(mockGet).toHaveBeenCalledWith('/servers/srv-2/channels/unread');
    expect(state().unreadCounts['ch-3']).toBe(2);
    expect(state().serverUnreadCounts['srv-2']).toBe(2);
  });

  it('several channels of one space are ONE request; two spaces are two', async () => {
    mockGet.mockImplementation(async (url: string) => (url.includes('srv-1')
      ? answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 1 }, { channelId: 'ch-2', serverId: 'srv-1', count: 2 }])
      : answer([{ channelId: 'ch-3', serverId: 'srv-2', count: 3 }])));

    await state().refreshChannelUnread(['ch-1', 'ch-2', 'ch-3']);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(state().serverUnreadCounts).toEqual({ 'srv-1': 3, 'srv-2': 3 });
  });

  it('a channel with no count is not asked about, and nothing is requested for none', async () => {
    await state().refreshChannelUnread(['ch-none', 'ch-9']);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a channel whose space is unknown (no mapping, not in the list) is skipped', async () => {
    useServerStore.setState({ unreadCounts: { 'ch-x': 4 }, unreadChannelServers: {} });
    await state().refreshChannelUnread(['ch-x']);
    expect(mockGet).not.toHaveBeenCalled();
    expect(state().unreadCounts['ch-x']).toBe(4);
  });

  it('a channel read meanwhile (cleared before the answer lands) is not put back', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-1']);
    state().clearUnread('ch-1');
    pending.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 30 }]));
    await run;

    expect(state().unreadCounts['ch-1']).toBeUndefined();
    expect(state().serverUnreadCounts['srv-1']).toBe(5);
  });

  it('an answer that lands after the logout reset applies nothing', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-1']);
    resetUnreadRefresh();
    pending.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 1 }]));
    await run;

    expect(state().unreadCounts['ch-1']).toBe(40);
    expect(state().serverUnreadCounts['srv-1']).toBe(45);
  });

  it('a failed request is logged by message and changes nothing; the other space still applies', async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('srv-1')) throw new Error('boom');
      return answer([{ channelId: 'ch-3', serverId: 'srv-2', count: 1 }]);
    });

    await state().refreshChannelUnread(['ch-1', 'ch-3']);

    expect(warn).toHaveBeenCalledWith('[Server] Unread refresh failed:', 'boom');
    expect(state().unreadCounts).toEqual({ 'ch-1': 40, 'ch-2': 5, 'ch-3': 1 });
  });

  it('a malformed answer reads as nothing unread for the asked channels, and malformed rows are ignored', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [null, { channelId: 7, count: 'x' }, { channelId: 'ch-1', serverId: 'srv-1', count: 2.5 }] } });

    await state().refreshChannelUnread(['ch-1']);

    expect(state().unreadCounts['ch-1']).toBeUndefined();
  });

  it('a count that did not change writes nothing', async () => {
    mockGet.mockResolvedValue(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 40 }]));
    const before = state().serverUnreadCounts;
    await state().refreshChannelUnread(['ch-1']);
    expect(state().serverUnreadCounts).toEqual(before);
    expect(state().unreadCounts['ch-1']).toBe(40);
  });

  it('incrementUnread records the space of a channel, so a later refresh finds it; clearUnread forgets it', async () => {
    state().incrementUnread('ch-new', 'srv-3');
    expect(state().unreadChannelServers['ch-new']).toBe('srv-3');
    mockGet.mockResolvedValue(answer([]));
    await state().refreshChannelUnread(['ch-new']);
    expect(mockGet).toHaveBeenCalledWith('/servers/srv-3/channels/unread');

    state().incrementUnread('ch-new2', 'srv-3');
    state().clearUnread('ch-new2');
    expect(state().unreadChannelServers['ch-new2']).toBeUndefined();
  });
});

describe('serverStore.refreshChannelUnread: an answer older than what the store holds applies nothing', () => {
  const sumOfSpace = (serverId: string) =>
    Object.entries(state().unreadCounts).reduce((n, [id, c]) => n + (state().unreadChannelServers[id] === serverId ? c : 0), 0);

  it('read, then a new message, then the answer computed before the read: the new message\'s count stays', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-2']);
    state().clearUnread('ch-2');
    state().incrementUnread('ch-2', 'srv-1');
    pending.resolve(answer([{ channelId: 'ch-2', serverId: 'srv-1', count: 5 }]));
    await run;

    expect(state().unreadCounts['ch-2']).toBe(1);
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });

  it('a message:new between the request and the answer is not overwritten', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-1']);
    state().incrementUnread('ch-1', 'srv-1');
    pending.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 3 }]));
    await run;

    expect(state().unreadCounts['ch-1']).toBe(41);
    expect(state().serverUnreadCounts['srv-1']).toBe(46);
  });

  it('the connect-time list landing before an older answer wins', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-1', 'ch-2']);
    state().initUnreadCounts([{ channelId: 'ch-1', serverId: 'srv-1', count: 7 }, { channelId: 'ch-2', serverId: 'srv-1', count: 6 }]);
    pending.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 1 }]));
    await run;

    expect(state().unreadCounts).toEqual({ 'ch-1': 7, 'ch-2': 6 });
    expect(state().serverUnreadCounts).toEqual({ 'srv-1': 13 });
  });

  it('two overlapping requests answered out of order: the later request\'s answer stands, the older one applies nothing', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = state().refreshChannelUnread(['ch-1']);
    const b = state().refreshChannelUnread(['ch-1']);
    second.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 2 }]));
    await b;
    first.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 30 }]));
    await a;

    expect(state().unreadCounts['ch-1']).toBe(2);
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });

  it('two overlapping requests answered in the order they were sent: the second (newest) answer applies over the first', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = state().refreshChannelUnread(['ch-1']);
    const b = state().refreshChannelUnread(['ch-1']);
    first.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 30 }]));
    await a;
    expect(state().unreadCounts['ch-1']).toBe(30);
    second.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 2 }]));
    await b;

    expect(state().unreadCounts['ch-1']).toBe(2);
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });

  it('a message:new after the first request and before the second: the first answer is skipped, the second applies', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = state().refreshChannelUnread(['ch-1']);
    state().incrementUnread('ch-1', 'srv-1');
    const b = state().refreshChannelUnread(['ch-1']);
    first.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 30 }]));
    await a;
    expect(state().unreadCounts['ch-1']).toBe(41);
    second.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 4 }]));
    await b;

    expect(state().unreadCounts['ch-1']).toBe(4);
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });

  it('a write, then a request sent with no write in between: its answer applies (the equal case)', async () => {
    state().incrementUnread('ch-1', 'srv-1');
    state().clearUnread('ch-2');
    mockGet.mockResolvedValue(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 9 }]));
    await state().refreshChannelUnread(['ch-1']);
    expect(state().unreadCounts['ch-1']).toBe(9);
  });

  it('a channel written meanwhile is skipped while another channel of the same answer applies', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);

    const run = state().refreshChannelUnread(['ch-1', 'ch-2']);
    state().incrementUnread('ch-1', 'srv-1');
    pending.resolve(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 3 }, { channelId: 'ch-2', serverId: 'srv-1', count: 2 }]));
    await run;

    expect(state().unreadCounts).toMatchObject({ 'ch-1': 41, 'ch-2': 2 });
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });

  it('no further request is scheduled for a skipped channel', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);
    const run = state().refreshChannelUnread(['ch-1']);
    state().incrementUnread('ch-1', 'srv-1');
    pending.resolve(answer([]));
    await run;
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('a request sent after the last write applies as usual', async () => {
    state().incrementUnread('ch-1', 'srv-1');
    mockGet.mockResolvedValue(answer([{ channelId: 'ch-1', serverId: 'srv-1', count: 4 }]));
    await state().refreshChannelUnread(['ch-1']);
    expect(state().unreadCounts['ch-1']).toBe(4);
    expect(state().serverUnreadCounts['srv-1']).toBe(sumOfSpace('srv-1'));
  });
});

describe('serverStore.refreshChannelUnread: what sends no request', () => {
  it('a burst naming only channels that show no count sends none at all', async () => {
    await state().refreshChannelUnread(['ch-zero', 'ch-9']);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a channel with no count is left out of a request that is sent for another', async () => {
    mockGet.mockResolvedValue(answer([]));
    await state().refreshChannelUnread(['ch-1', 'ch-zero']);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('a space id that is not an opaque id sends no request', async () => {
    useServerStore.setState({ unreadCounts: { 'ch-bad': 3 }, unreadChannelServers: { 'ch-bad': '../admin' } });
    await state().refreshChannelUnread(['ch-bad']);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('a space that leaves the strip takes its unread counts with it', () => {
  const channelOf = (id: string, serverId: string) => ({ id, serverId, name: id, type: 'text' }) as unknown as Channel;

  it.each(['handleMemberKicked', 'handleServerDeleted'] as const)('%s: an active space drops its channels\' counts, map entries and total, others stay', (fn) => {
    useServerStore.setState({ activeServerId: 'srv-1', channels: [channelOf('ch-1', 'srv-1'), channelOf('ch-2', 'srv-1')] });
    state()[fn]('srv-1');
    expect(state().unreadCounts).toEqual({ 'ch-3': 9 });
    expect(state().unreadChannelServers).toEqual({ 'ch-3': 'srv-2' });
    expect(state().serverUnreadCounts).toEqual({ 'srv-2': 9 });
  });

  it.each(['handleMemberKicked', 'handleServerDeleted'] as const)('%s: a space that is not active does too (its channels are not in the list)', (fn) => {
    useServerStore.setState({ activeServerId: 'srv-2', channels: [channelOf('ch-3', 'srv-2')] });
    state()[fn]('srv-1');
    expect(state().unreadCounts).toEqual({ 'ch-3': 9 });
    expect(state().unreadChannelServers).toEqual({ 'ch-3': 'srv-2' });
    expect(state().serverUnreadCounts).toEqual({ 'srv-2': 9 });
  });

  it('leaving a space does too', async () => {
    (api.post as unknown as Mock).mockResolvedValue({ data: {} });
    await state().leaveServer('srv-2');
    expect(state().unreadCounts).toEqual({ 'ch-1': 40, 'ch-2': 5 });
    expect(state().serverUnreadCounts).toEqual({ 'srv-1': 45 });
    expect(state().unreadChannelServers['ch-3']).toBeUndefined();
  });

  it('an answer for a channel of a space that left applies nothing', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    mockGet.mockReturnValue(pending.promise);
    const run = state().refreshChannelUnread(['ch-3']);
    state().handleServerDeleted('srv-2');
    pending.resolve(answer([{ channelId: 'ch-3', serverId: 'srv-2', count: 4 }]));
    await run;
    expect(state().unreadCounts['ch-3']).toBeUndefined();
    expect(state().serverUnreadCounts['srv-2']).toBeUndefined();
  });
});
