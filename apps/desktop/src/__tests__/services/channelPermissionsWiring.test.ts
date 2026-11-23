import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/**
 * What ends a channel-permission answer: leaving, being removed from or losing
 * the space (the store's three ways out), and logout (the override write's
 * socket event is pinned in channelPermissionsSources.test.ts). A request still in flight when its space is
 * forgotten is not kept when it lands.
 */

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
vi.mock('../../utils/imageProcessing', () => ({ processImage: vi.fn(), ASSET_UPLOAD_CONTENT_TYPE: 'image/webp' }));

import { useServerStore } from '../../stores/serverStore';
import { api } from '../../services/api';
import {
  cachedChannelPermissions,
  loadChannelPermissions,
  forgetSpaceChannelPermissions,
  resetChannelPermissionsCache,
} from '../../services/channelPermissionsCache';

const state = () => useServerStore.getState();

async function held(key: string, serverId: string) {
  await loadChannelPermissions(key, serverId, () => Promise.resolve('4'));
  expect(cachedChannelPermissions(key)).toBe('4');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChannelPermissionsCache();
  useServerStore.setState({ servers: [], activeServerId: null, channels: [], unreadCounts: {}, serverUnreadCounts: {}, unreadChannelServers: {} });
});

describe('the store forgets the answers of a space it no longer holds', () => {
  it.each(['handleMemberKicked', 'handleServerDeleted'] as const)('%s', async (fn) => {
    await held('me|srv-1|ch-1|0|x', 'srv-1');
    await held('me|srv-2|ch-9|0|x', 'srv-2');
    state()[fn]('srv-1');
    expect(cachedChannelPermissions('me|srv-1|ch-1|0|x')).toBeUndefined();
    expect(cachedChannelPermissions('me|srv-2|ch-9|0|x')).toBe('4');
  });

  it('leaveServer', async () => {
    (api.post as unknown as Mock).mockResolvedValue({ data: {} });
    await held('me|srv-1|ch-1|0|x', 'srv-1');
    await state().leaveServer('srv-1');
    expect(cachedChannelPermissions('me|srv-1|ch-1|0|x')).toBeUndefined();
  });
});

describe('the cache', () => {
  it('logout empties every answer', async () => {
    await held('me|srv-1|ch-1|0|x', 'srv-1');
    resetChannelPermissionsCache();
    expect(cachedChannelPermissions('me|srv-1|ch-1|0|x')).toBeUndefined();
  });

  it('a request in flight when its space is forgotten is not kept when it lands (the key may repeat)', async () => {
    let answer!: (bits: string) => void;
    const p = loadChannelPermissions('me|srv-1|ch-1|0|x', 'srv-1', () => new Promise<string>((r) => { answer = r; }));
    forgetSpaceChannelPermissions('srv-1');
    answer('4');
    await p;
    expect(cachedChannelPermissions('me|srv-1|ch-1|0|x')).toBeUndefined();
  });

  it('the same key asked twice at once is loaded once', async () => {
    const load = vi.fn(() => Promise.resolve('4'));
    await Promise.all([
      loadChannelPermissions('k', 'srv-1', load),
      loadChannelPermissions('k', 'srv-1', load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failure is shared by everyone waiting and kept by nobody', async () => {
    const load = vi.fn(() => Promise.reject(new Error('down')));
    const results = await Promise.allSettled([
      loadChannelPermissions('k', 'srv-1', load),
      loadChannelPermissions('k', 'srv-1', load),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(load).toHaveBeenCalledTimes(1);
    const again = vi.fn(() => Promise.resolve('4'));
    await loadChannelPermissions('k', 'srv-1', again);
    expect(again).toHaveBeenCalledTimes(1);
  });
});
