import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every call the helpers make, in order, with the scope it ran on
const calls = vi.hoisted(() => [] as Array<[string, ...unknown[]]>);

const io = vi.hoisted(() => {
  const scoped = (scope: string) => ({
    in: vi.fn((room: string | string[]) => ({
      disconnectSockets: vi.fn((close: boolean) => { calls.push([`${scope}.disconnectSockets`, room, close]); }),
    })),
  });
  const cluster = scoped('cluster');
  return {
    in: cluster.in,
    local: scoped('local'),
    to: vi.fn((room: string | string[]) => ({ emit: vi.fn((ev: string, data: unknown) => { calls.push(['emit', room, ev, data]); }) })),
    fetchSockets: vi.fn(),
  };
});
const getIO = vi.hoisted(() => vi.fn(() => io));
vi.mock('../../websocket/socketServer', () => ({ getIO: () => getIO() }));

import { revokeUserSessions, revokeSessionSockets, disconnectSessionRooms, SESSION_ROOMS_PER_CALL } from '../../utils/sessionRevocation';
import { sessionRoom, legacySocketsRoom } from '../../utils/sessionRooms';

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

describe('revokeSessionSockets: one sign-in session, never the other sessions of the account', () => {
  it('disconnects the session room AND the account\'s sockets that name no session, on this node first, then cluster-wide', () => {
    revokeSessionSockets('u-1', 'Qm9vdHN0cmFwU2Vzc2lvbg');

    expect(calls).toEqual([
      ['local.disconnectSockets', ['session:Qm9vdHN0cmFwU2Vzc2lvbg', 'nosid:u-1'], true],
      ['cluster.disconnectSockets', ['session:Qm9vdHN0cmFwU2Vzc2lvbg', 'nosid:u-1'], true],
    ]);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('sends force:logout with the reason to that session alone (never to the sockets that name no session), BEFORE any disconnect', () => {
    revokeSessionSockets('u-1', 'sid-1', 'Your session has ended');

    expect(calls).toEqual([
      ['emit', ['session:sid-1'], 'force:logout', { reason: 'Your session has ended' }],
      ['local.disconnectSockets', ['session:sid-1', 'nosid:u-1'], true],
      ['cluster.disconnectSockets', ['session:sid-1', 'nosid:u-1'], true],
    ]);
    // Never the account's room: its other sessions stay connected
    expect(calls.some((c) => JSON.stringify(c[1]).includes('user:'))).toBe(false);
  });

  it('several sessions of one account in one call (the cap): each room told, every one disconnected with the legacy room once', () => {
    revokeSessionSockets('u-1', ['a', 'b'], 'Your session has ended');
    expect(calls).toEqual([
      ['emit', ['session:a', 'session:b'], 'force:logout', { reason: 'Your session has ended' }],
      ['local.disconnectSockets', ['session:a', 'session:b', 'nosid:u-1'], true],
      ['cluster.disconnectSockets', ['session:a', 'session:b', 'nosid:u-1'], true],
    ]);
  });

  it('no session: nothing at all (not even the legacy room)', () => {
    revokeSessionSockets('u-1', []);
    expect(calls).toEqual([]);
    expect(getIO).not.toHaveBeenCalled();
  });

  it('the room names come from one place', () => {
    expect(sessionRoom('x')).toBe('session:x');
    expect(legacySocketsRoom('u')).toBe('nosid:u');
  });

  it('never walks the sockets with fetchSockets', () => {
    revokeSessionSockets('u-1', 'sid-1', 'x');
    expect(io.fetchSockets).not.toHaveBeenCalled();
  });

  it('logs (the first characters of the id only) and does not throw when the socket server is unavailable or a call fails', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getIO.mockImplementationOnce(() => { throw new Error('Socket.IO not initialized'); });
    expect(() => revokeSessionSockets('u-1', 'Qm9vdHN0cmFwU2Vzc2lvbg', 'x')).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Qm9vdH'), 'Socket.IO not initialized');
    expect(err.mock.calls[0][0]).not.toContain('Qm9vdHN0cmFwU2Vzc2lvbg');
    expect(err.mock.calls[0][0]).not.toContain('u-1');

    io.local.in.mockImplementationOnce(() => { throw new Error('adapter gone'); });
    expect(() => revokeSessionSockets('u-1', 'sid-2')).not.toThrow();
    err.mockRestore();
  });
});

describe('disconnectSessionRooms: the sockets of sessions the sweep deleted', () => {
  it('by their session rooms, local then cluster-wide, at most SESSION_ROOMS_PER_CALL rooms a call, no force:logout', () => {
    const sids = Array.from({ length: SESSION_ROOMS_PER_CALL * 2 + 3 }, (_, i) => `s${i}`);
    disconnectSessionRooms(sids);

    expect(io.to).not.toHaveBeenCalled();
    expect(calls).toHaveLength(6);
    const sizes = calls.map((c) => (c[1] as string[]).length);
    expect(sizes).toEqual([SESSION_ROOMS_PER_CALL, SESSION_ROOMS_PER_CALL, SESSION_ROOMS_PER_CALL, SESSION_ROOMS_PER_CALL, 3, 3]);
    expect(calls.map((c) => c[0])).toEqual([
      'local.disconnectSockets', 'cluster.disconnectSockets',
      'local.disconnectSockets', 'cluster.disconnectSockets',
      'local.disconnectSockets', 'cluster.disconnectSockets',
    ]);
    // Every room once, each a session room
    const rooms = calls.filter((c) => c[0] === 'cluster.disconnectSockets').flatMap((c) => c[1] as string[]);
    expect(rooms).toEqual(sids.map((s) => `session:${s}`));
    expect(SESSION_ROOMS_PER_CALL).toBe(500);
  });

  it('nothing deleted: no call', () => {
    disconnectSessionRooms([]);
    expect(calls).toEqual([]);
  });

  it('a failing call is logged without any id, and the next chunk is still sent', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    io.local.in.mockImplementationOnce(() => { throw new Error('adapter gone'); });
    const sids = Array.from({ length: SESSION_ROOMS_PER_CALL + 1 }, (_, i) => `secret-sid-${i}`);
    expect(() => disconnectSessionRooms(sids)).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe(`[Sessions] Could not disconnect the sockets of ${SESSION_ROOMS_PER_CALL} swept session(s):`);
    expect(JSON.stringify(err.mock.calls)).not.toContain('secret-sid');
    // The second chunk still went out
    expect(calls.map((c) => (c[1] as string[]).length)).toEqual([1, 1]);
    err.mockRestore();
  });
});
