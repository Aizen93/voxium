import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';
import type { Channel, Role, ServerMember } from '@voxium/shared';

/**
 * The viewer's effective permissions in ONE channel. One request per
 * (account, space, channel, role fingerprint, generation) however many
 * components ask; a failure drops the answer, retries once after the delay and
 * again on a reconnect; an override write, a role change, leaving the space and
 * logout each end an answer; a secure channel is never asked.
 */

const S = vi.hoisted(() => ({ fetchEffectivePermissions: vi.fn() }));
let members: ServerMember[] = [];
let roles: Role[] = [];
let servers: { id: string; ownerId: string }[] = [];
let channels: Pick<Channel, 'id' | 'secure' | 'serverId'>[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, roles, servers, channels, ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});

const sock = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock('../../services/socket', () => ({
  onSocketReconnect: (cb: () => void) => {
    sock.callbacks.add(cb);
    return () => { sock.callbacks.delete(cb); };
  },
}));

import { useChannelPermissions } from '../../hooks/useChannelPermissions';
import { PERMISSIONS_RETRY_DELAY_MS } from '../../hooks/useServerPermissions';
import {
  forgetSpaceChannelPermissions,
  invalidateChannelPermissions,
  resetChannelPermissionsCache,
} from '../../services/channelPermissionsCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEND = Permissions.SEND_MESSAGES;
const role = (permissions: bigint): Role =>
  ({ id: 'r1', serverId: 'srv', name: 'r1', color: null, position: 1, permissions: permissions.toString(), isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' });
const me = (assigned: Role[]): ServerMember =>
  ({ userId: 'me', serverId: 'srv', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: assigned,
    user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } } as unknown as ServerMember);

let container: HTMLDivElement;
let root: Root;
/**
 * What each probe shows ON SCREEN, read from the DOM. Never the value the hook
 * returned during a render: React can run a render and discard it, and what
 * the person sees is only what was committed.
 */
const seen = new Proxy({} as Record<string, bigint | null | undefined>, {
  get: (_target, name) => {
    const text = container.querySelector(`[data-probe="${String(name)}"]`)?.textContent;
    if (text === undefined || text === null) return undefined;
    return text === 'null' ? null : BigInt(text);
  },
});

function Probe({ name, serverId = 'srv', channelId = 'ch-1', userId = 'me' }: { name: string; serverId?: string; channelId?: string; userId?: string }) {
  const bits = useChannelPermissions(serverId, channelId, userId);
  return <span data-probe={name}>{String(bits)}</span>;
}
async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }
async function render(ui: React.ReactElement) {
  await act(async () => { root.render(ui); });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  S.fetchEffectivePermissions.mockReset();
  resetChannelPermissionsCache();
  sock.callbacks.clear();
  servers = [{ id: 'srv', ownerId: 'someone-else' }];
  channels = [{ id: 'ch-1', serverId: 'srv' }, { id: 'ch-2', serverId: 'srv' }, { id: 'ch-sec', serverId: 'srv', secure: true }];
  const r = role(SEND);
  roles = [r];
  members = [me([r])];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useChannelPermissions', () => {
  it('asks for the channel and returns its bits', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledWith('srv', 'ch-1');
    expect(seen.a).toBe(SEND);
  });

  it('is null until the answer lands', async () => {
    S.fetchEffectivePermissions.mockReturnValue(new Promise(() => {}));
    await render(<Probe name="a" />);
    expect(seen.a).toBeNull();
  });

  it('the owner of the space holds every bit at once and asks nothing', async () => {
    servers = [{ id: 'srv', ownerId: 'me' }];
    await render(<Probe name="a" />);
    expect(seen.a).toBe(ALL_PERMISSIONS);
    expect(S.fetchEffectivePermissions).not.toHaveBeenCalled();
  });

  it('two components asking at once make ONE request and both read the answer', async () => {
    let answer!: (bits: string) => void;
    S.fetchEffectivePermissions.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
    await render(<><Probe name="a" /><Probe name="b" /></>);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    await act(async () => { answer(SEND.toString()); });
    await settle();
    expect(seen.a).toBe(SEND);
    expect(seen.b).toBe(SEND);
  });

  it('a second mount is a cache hit, a second channel a request of its own', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    await render(<></>);
    await render(<Probe name="a" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(seen.a).toBe(SEND);
    await render(<Probe name="a" channelId="ch-2" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(S.fetchEffectivePermissions).toHaveBeenLastCalledWith('srv', 'ch-2');
  });

  it('an override write (invalidation) asks again, and a request in flight before it is not kept', async () => {
    const answers: ((bits: string) => void)[] = [];
    S.fetchEffectivePermissions.mockImplementation(() => new Promise<string>((r) => { answers.push(r); }));
    await render(<Probe name="a" />);
    expect(answers).toHaveLength(1);
    await act(async () => { invalidateChannelPermissions('srv'); });
    await settle();
    expect(answers).toHaveLength(2);
    // the pre-invalidation request lands late: it must not stand for the new key
    await act(async () => { answers[0](SEND.toString()); });
    await settle();
    expect(seen.a).toBeNull();
    await act(async () => { answers[1]('0'); });
    await settle();
    expect(seen.a).toBe(0n);
  });

  it('the invalidation of another space leaves the answer alone', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    await act(async () => { invalidateChannelPermissions('other'); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
  });

  it('a role change (new fingerprint) asks again', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    const r = role(0n);
    roles = [r];
    members = [me([r])];
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await render(<Probe name="a" userId="me" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen.a).toBe(0n);
  });

  it('logout empties the answers: the next mount asks again', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    await render(<></>);
    resetChannelPermissionsCache();
    await render(<Probe name="a" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
  });

  it('leaving, being removed from or losing the space forgets its answers', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    await render(<></>);
    forgetSpaceChannelPermissions('srv');
    await render(<Probe name="a" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch is null (never a guess), logged, tried once more after the delay', async () => {
    S.fetchEffectivePermissions.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    expect(seen.a).toBeNull();
    expect(console.warn).toHaveBeenCalledWith('[Permissions] Failed to fetch channel permissions:', 'offline');
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen.a).toBe(SEND);
  });

  it('a failure drops the answer kept from the previous key, and only one retry follows', async () => {
    S.fetchEffectivePermissions.mockResolvedValueOnce(SEND.toString());
    await render(<Probe name="a" />);
    expect(seen.a).toBe(SEND);
    S.fetchEffectivePermissions.mockRejectedValue(new Error('down'));
    await act(async () => { invalidateChannelPermissions('srv'); });
    await settle();
    expect(seen.a).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 5); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(3);
    expect(seen.a).toBeNull();
  });

  it('a reconnect asks again for the key on screen', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" />);
    expect(sock.callbacks.size).toBe(1);
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await act(async () => { for (const cb of [...sock.callbacks]) cb(); });
    await settle();
    expect(S.fetchEffectivePermissions).toHaveBeenCalledTimes(2);
    expect(seen.a).toBe(0n);
  });

  it('an answer for a channel no longer on screen never applies to the new one', async () => {
    let answerFirst!: (bits: string) => void;
    S.fetchEffectivePermissions.mockImplementationOnce(() => new Promise<string>((r) => { answerFirst = r; }));
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await render(<Probe name="a" channelId="ch-1" />);
    await render(<Probe name="a" channelId="ch-2" />);
    expect(seen.a).toBe(0n);
    await act(async () => { answerFirst(SEND.toString()); });
    await settle();
    expect(seen.a).toBe(0n);
  });

  it('a secure channel is never asked: null, so its controls follow membership', async () => {
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await render(<Probe name="a" channelId="ch-sec" />);
    expect(seen.a).toBeNull();
    expect(S.fetchEffectivePermissions).not.toHaveBeenCalled();
  });

  it('a space switch in flight: the new space with the channels of the OLD space asks nothing and answers null', async () => {
    S.fetchEffectivePermissions.mockResolvedValue('0');
    await render(<Probe name="a" serverId="srv-b" channelId="ch-1" />);
    expect(seen.a).toBeNull();
    expect(S.fetchEffectivePermissions).not.toHaveBeenCalled();
  });

  it('a channel whose record is not in the store yet: null, asked once the record is there', async () => {
    S.fetchEffectivePermissions.mockResolvedValue(SEND.toString());
    await render(<Probe name="a" channelId="ch-new" />);
    expect(seen.a).toBeNull();
    expect(S.fetchEffectivePermissions).not.toHaveBeenCalled();
    channels = [...channels, { id: 'ch-new', serverId: 'srv' }];
    await render(<Probe name="a" channelId="ch-new" userId="me" key="again" />);
    expect(S.fetchEffectivePermissions).toHaveBeenCalledWith('srv', 'ch-new');
    expect(seen.a).toBe(SEND);
  });

  it('a swapped channel never shows the previous channel bits while its own fetch is in flight', async () => {
    S.fetchEffectivePermissions.mockResolvedValueOnce(SEND.toString());
    await render(<Probe name="a" channelId="ch-1" />);
    expect(seen.a).toBe(SEND);
    S.fetchEffectivePermissions.mockReturnValue(new Promise(() => {}));
    await render(<Probe name="a" channelId="ch-2" />);
    expect(seen.a).toBeNull();
  });

  it('a failed refetch clears, on screen, what an instance that only read the cache showed', async () => {
    S.fetchEffectivePermissions.mockResolvedValueOnce('0');
    await render(<Probe name="a" />);
    // b mounts later and reads the cache: no request of its own has settled yet
    await render(<><Probe name="a" /><Probe name="b" /></>);
    expect([seen.a, seen.b]).toEqual([0n, 0n]);
    // an override write asks again and the request fails: never a kept refusal
    S.fetchEffectivePermissions.mockRejectedValue(new Error('down'));
    await act(async () => { invalidateChannelPermissions('srv'); });
    await settle();
    expect([seen.a, seen.b]).toEqual([null, null]);
    await act(async () => { await vi.advanceTimersByTimeAsync(PERMISSIONS_RETRY_DELAY_MS * 5); });
    await settle();
    expect([seen.a, seen.b]).toEqual([null, null]);
  });

  it('a reconnect keeps showing the answer on an instance that did not make the fetch', async () => {
    let answer!: (bits: string) => void;
    S.fetchEffectivePermissions.mockResolvedValueOnce(SEND.toString());
    await render(<Probe name="a" />);
    // b mounts later and reads the cache: it never made a fetch of its own
    await render(<><Probe name="a" /><Probe name="b" /></>);
    expect([seen.a, seen.b]).toEqual([SEND, SEND]);
    S.fetchEffectivePermissions.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
    await act(async () => { for (const cb of [...sock.callbacks]) cb(); });
    await settle();
    expect([seen.a, seen.b]).toEqual([SEND, SEND]);
    await act(async () => { answer('0'); });
    await settle();
    expect([seen.a, seen.b]).toEqual([0n, 0n]);
  });

  it('no space, channel or account: null and no request', async () => {
    await render(<><Probe name="a" serverId="" /><Probe name="b" channelId="" /><Probe name="c" userId="" /></>);
    expect([seen.a, seen.b, seen.c]).toEqual([null, null, null]);
    expect(S.fetchEffectivePermissions).not.toHaveBeenCalled();
  });
});
