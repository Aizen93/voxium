import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const serverState = vi.hoisted(() => ({
  activeServerId: null as string | null,
  activeChannelId: null as string | null,
  clearUnread: vi.fn(),
  markChannelRead: vi.fn(),
  fetchPeople: vi.fn(async () => {}),
}));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => serverState } }));

const dmState = vi.hoisted(() => ({
  activeConversationId: null as string | null,
  clearDMUnread: vi.fn(),
  markConversationRead: vi.fn(),
  fetchConversations: vi.fn(async () => {}),
}));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => dmState } }));

const sock = vi.hoisted(() => ({
  current: null as { connected: boolean } | null,
  getSocket: vi.fn(() => sock.current),
  ensureSocketConnected: vi.fn(async () => {}),
}));
vi.mock('../../services/socket', () => ({ getSocket: sock.getSocket, ensureSocketConnected: sock.ensureSocketConnected }));

import { handleAppResume } from '../../services/resume';

let onLine: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  serverState.activeServerId = null;
  serverState.activeChannelId = null;
  dmState.activeConversationId = null;
  sock.current = { connected: true };
  onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  onLine.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resume — the socket dropped while the window was away', () => {
  it('reconnects it (with a live token) and fetches nothing itself: the connect handlers do the whole refresh', async () => {
    sock.current = { connected: false };
    serverState.activeServerId = 'srv-1';

    await handleAppResume();

    expect(sock.ensureSocketConnected).toHaveBeenCalledTimes(1);
    expect(dmState.fetchConversations).not.toHaveBeenCalled();
    expect(serverState.fetchPeople).not.toHaveBeenCalled();
  });
});

describe('resume — the socket stayed connected', () => {
  it('refetches the DM list and the People slice of the viewed server', async () => {
    serverState.activeServerId = 'srv-1';

    await handleAppResume();

    expect(sock.ensureSocketConnected).not.toHaveBeenCalled();
    expect(dmState.fetchConversations).toHaveBeenCalledTimes(1);
    expect(serverState.fetchPeople).toHaveBeenCalledWith('srv-1');
  });

  it('refetches no People slice in the DM view', async () => {
    await handleAppResume();

    expect(dmState.fetchConversations).toHaveBeenCalledTimes(1);
    expect(serverState.fetchPeople).not.toHaveBeenCalled();
  });

  it('with no socket at all (no session) it refetches the same way', async () => {
    sock.current = null;

    await handleAppResume();

    expect(sock.ensureSocketConnected).not.toHaveBeenCalled();
    expect(dmState.fetchConversations).toHaveBeenCalledTimes(1);
  });
});

describe('resume — offline', () => {
  it('fetches and reconnects nothing while the browser says it is offline (the online event comes back here)', async () => {
    onLine.mockReturnValue(false);
    sock.current = { connected: false };
    serverState.activeServerId = 'srv-1';

    await handleAppResume();

    expect(sock.ensureSocketConnected).not.toHaveBeenCalled();
    expect(dmState.fetchConversations).not.toHaveBeenCalled();
    expect(serverState.fetchPeople).not.toHaveBeenCalled();
  });
});

describe('resume — the unread bookkeeping of the view on screen', () => {
  it('server view: clears and marks the active channel read (unread:init may have restored a stale count)', async () => {
    serverState.activeServerId = 'srv-1';
    serverState.activeChannelId = 'ch-1';
    dmState.activeConversationId = 'conv-1';

    await handleAppResume();

    expect(serverState.clearUnread).toHaveBeenCalledWith('ch-1');
    expect(serverState.markChannelRead).toHaveBeenCalledWith('ch-1');
    // activeConversationId survives behind the server view: not touched
    expect(dmState.clearDMUnread).not.toHaveBeenCalled();
  });

  it('DM view: clears and marks the active conversation read, never the lingering channel', async () => {
    serverState.activeChannelId = 'ch-stale';
    dmState.activeConversationId = 'conv-1';

    await handleAppResume();

    expect(dmState.clearDMUnread).toHaveBeenCalledWith('conv-1');
    expect(dmState.markConversationRead).toHaveBeenCalledWith('conv-1');
    expect(serverState.clearUnread).not.toHaveBeenCalled();
  });

  it('runs even while offline (it is local state and a retried write)', async () => {
    onLine.mockReturnValue(false);
    serverState.activeServerId = 'srv-1';
    serverState.activeChannelId = 'ch-1';

    await handleAppResume();

    expect(serverState.clearUnread).toHaveBeenCalledWith('ch-1');
  });
});
