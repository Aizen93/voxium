import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The chat view's channel effect is the only starter of a channel's fetch:
 * one clear and one fetch per switch, nothing on a re-render of the open
 * channel, and a fetch again when the socket reconnects.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const H = vi.hoisted(() => ({
  clearMessages: vi.fn(),
  fetchMessages: vi.fn(),
  clearUnread: vi.fn(),
  markChannelRead: vi.fn(),
  server: { channels: [] as { id: string }[], activeChannelId: null as string | null, activeServerId: 'srv1' as string | null },
  socket: null as null | { connected: boolean; id: string; emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> },
}));

vi.mock('../../stores/chatStore', () => {
  const state = () => ({ clearMessages: H.clearMessages, fetchMessages: H.fetchMessages });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useChatStore.getState = state;
  return { useChatStore };
});
vi.mock('../../stores/serverStore', () => {
  const getState = () => ({ clearUnread: H.clearUnread, markChannelRead: H.markChannelRead });
  const useServerStore = Object.assign(() => H.server, { getState });
  return { useServerStore };
});
vi.mock('../../services/socket', () => ({
  getSocket: () => H.socket,
  onConnectionStatusChange: () => () => {},
}));
vi.mock('../../components/chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../../components/chat/MessageInput', () => ({ MessageInput: () => null }));
vi.mock('../../components/search/SearchModal', () => ({ SearchModal: () => null }));
vi.mock('../../components/search/SearchField', () => ({ SearchField: () => null }));

import { ChatArea } from '../../components/chat/ChatArea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => { root.render(<ChatArea />); }); };

beforeEach(() => {
  vi.clearAllMocks();
  H.server = { channels: [{ id: 'a' }, { id: 'b' }], activeChannelId: 'a', activeServerId: 'srv1' };
  H.socket = { connected: true, id: 's1', emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChatArea channel effect', () => {
  it('fetches the opened channel once, clearing once', async () => {
    await render();
    expect(H.fetchMessages.mock.calls.filter((c) => c[0] === 'a')).toHaveLength(1);
    expect(H.clearMessages).toHaveBeenCalledTimes(1);
  });

  it('the effect running again for the open channel neither clears nor fetches', async () => {
    await render();
    // new identities for the store's actions: the effect's dependencies
    // change, so it runs again with the same channel
    H.clearMessages = vi.fn();
    H.fetchMessages = vi.fn();
    await render();
    expect(H.clearMessages).not.toHaveBeenCalled();
    expect(H.fetchMessages).not.toHaveBeenCalled();
  });

  it('a channel opened again after no channel was open is loaded again', async () => {
    await render();
    H.server = { ...H.server, activeChannelId: null };
    await render();
    H.clearMessages.mockClear();
    H.fetchMessages.mockClear();
    H.server = { ...H.server, activeChannelId: 'a' };
    await render();
    expect(H.clearMessages).toHaveBeenCalledTimes(1);
    expect(H.fetchMessages).toHaveBeenCalledTimes(1);
    expect(H.fetchMessages).toHaveBeenCalledWith('a');
  });

  it('a reconnect loads the open channel once per connection', async () => {
    await render();
    const onConnect = H.socket!.on.mock.calls.find((c) => c[0] === 'connect')?.[1] as (() => void) | undefined;
    expect(onConnect).toBeTypeOf('function');
    H.clearMessages.mockClear();
    H.fetchMessages.mockClear();
    H.socket!.emit.mockClear();

    // a new connection of the same socket object
    H.socket!.id = 's2';
    act(() => onConnect!());
    expect(H.socket!.emit).toHaveBeenCalledWith('channel:join', 'a');
    expect(H.clearMessages).toHaveBeenCalledTimes(1);
    expect(H.fetchMessages).toHaveBeenCalledTimes(1);
    expect(H.fetchMessages).toHaveBeenCalledWith('a');

    // the same connection reported a second time
    act(() => onConnect!());
    expect(H.fetchMessages).toHaveBeenCalledTimes(1);
  });

  it('a reconnect while no channel is open loads nothing', async () => {
    await render();
    const onConnect = H.socket!.on.mock.calls.find((c) => c[0] === 'connect')?.[1] as (() => void) | undefined;
    H.server = { ...H.server, activeChannelId: null };
    await render();
    H.clearMessages.mockClear();
    H.fetchMessages.mockClear();
    H.socket!.id = 's2';
    act(() => onConnect!());
    expect(H.clearMessages).not.toHaveBeenCalled();
    expect(H.fetchMessages).not.toHaveBeenCalled();
  });

  it('a switch fetches the new channel exactly once', async () => {
    await render();
    H.fetchMessages.mockClear();
    H.server = { ...H.server, activeChannelId: 'b' };
    await render();
    expect(H.fetchMessages).toHaveBeenCalledTimes(1);
    expect(H.fetchMessages).toHaveBeenCalledWith('b');
  });
});
