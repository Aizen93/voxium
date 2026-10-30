import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every call the helpers make, in order, with the scope it ran on
const calls = vi.hoisted(() => [] as Array<[string, ...unknown[]]>);

const io = vi.hoisted(() => {
  const scoped = (scope: string) => ({
    in: vi.fn((room: string) => ({
      disconnectSockets: vi.fn((close: boolean) => { calls.push([`${scope}.disconnectSockets`, room, close]); }),
    })),
  });
  const cluster = scoped('cluster');
  return {
    in: cluster.in,
    local: scoped('local'),
    to: vi.fn((room: string) => ({ emit: vi.fn((ev: string, data: unknown) => { calls.push(['emit', room, ev, data]); }) })),
    fetchSockets: vi.fn(),
  };
});
const getIO = vi.hoisted(() => vi.fn(() => io));
vi.mock('../../websocket/socketServer', () => ({ getIO: () => getIO() }));

import { revokeUserSessions } from '../../utils/sessionRevocation';

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  getIO.mockImplementation(() => io);
});

describe('revokeUserSessions', () => {
  it('disconnects the user\'s sockets on this node first, then cluster-wide, by the user room', () => {
    revokeUserSessions('u-1');

    expect(calls).toEqual([
      ['local.disconnectSockets', 'user:u-1', true],
      ['cluster.disconnectSockets', 'user:u-1', true],
    ]);
  });

  it('sends no force:logout without a reason (the account keeps a valid session elsewhere)', () => {
    revokeUserSessions('u-1');

    expect(io.to).not.toHaveBeenCalled();
  });

  it('sends force:logout with the reason BEFORE any disconnect', () => {
    revokeUserSessions('u-2', { forceLogoutReason: 'Your account has been banned' });

    expect(calls).toEqual([
      ['emit', 'user:u-2', 'force:logout', { reason: 'Your account has been banned' }],
      ['local.disconnectSockets', 'user:u-2', true],
      ['cluster.disconnectSockets', 'user:u-2', true],
    ]);
  });

  it('never walks the sockets with fetchSockets', () => {
    revokeUserSessions('u-1', { forceLogoutReason: 'x' });

    expect(io.fetchSockets).not.toHaveBeenCalled();
  });

  it('logs and does not throw when the socket server is unavailable', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getIO.mockImplementation(() => { throw new Error('Socket.IO not initialized'); });

    expect(() => revokeUserSessions('u-3')).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('u-3'), 'Socket.IO not initialized');
    err.mockRestore();
  });

  it('logs and does not throw when a disconnect call fails', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    io.local.in.mockImplementationOnce(() => { throw new Error('adapter gone'); });

    expect(() => revokeUserSessions('u-4')).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('u-4'), 'adapter gone');
    err.mockRestore();
  });
});
