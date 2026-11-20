import { getIO } from '../websocket/socketServer';
import { sessionRoom, legacySocketsRoom } from './sessionRooms';

export interface RevokeSessionOptions {
  /**
   * Sent as `force:logout { reason }` before the disconnect: the client signs
   * out and shows the reason. Omit it when the account keeps a valid session
   * elsewhere (a password change: the caller holds fresh tokens and reopens
   * its socket with them).
   */
  forceLogoutReason?: string;
}

/**
 * End every live socket of `userId`, on every node.
 *
 * A socket is authorized once, at the handshake. Every mutation that
 * invalidates a session (a password reset or change bumps `tokenVersion`, a
 * ban, an account deletion) calls this; the next handshake re-runs the
 * checks.
 *
 * Room-filtered `disconnectSockets` is adapter-wide and needs no
 * `fetchSockets()` round trip (which waits for every node and throws after
 * 5 s when one peer does not answer). Twice on purpose, as in
 * memberBroadcast.ts: `io.local` disconnects THIS node's sockets now, the
 * cluster-wide call reaches the other nodes (the Redis adapter only publishes
 * it and applies it here when its own message comes back). Never the
 * empty-filter form: that hangs up every node's entire namespace.
 *
 * Best effort: callers run it after their write committed, so a failure is
 * logged, never thrown.
 */
export function revokeUserSessions(userId: string, opts: RevokeSessionOptions = {}): void {
  const room = `user:${userId}`;
  try {
    const io = getIO();
    if (opts.forceLogoutReason !== undefined) {
      io.to(room).emit('force:logout', { reason: opts.forceLogoutReason });
    }
    io.local.in(room).disconnectSockets(true);
    io.in(room).disconnectSockets(true);
  } catch (err) {
    console.error(`[Sessions] Could not disconnect the sockets of user ${userId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * End every live socket of one sign-in session of `userId` (or of each of
 * `sids`), on every node: the sockets whose access token names a session
 * joined `session:{sid}` at connect (socketServer.ts). For a session that
 * ended while the account keeps its others (a sign-out, a reused refresh
 * token, the cap, a sign-out from another of its sessions): the other
 * sessions' sockets are untouched. Same pattern and same rules as revokeUserSessions: the local
 * form then the cluster-wide form, never the empty filter, never
 * fetchSockets(), best effort after the commit, never throws.
 *
 * Part of the acceptance of access tokens issued before sessions, which a
 * later release removes: a socket admitted with such a token names no
 * session and sits in `nosid:{userId}` instead (a device that has renewed
 * since keeps the socket it opened before). Those sockets are disconnected
 * too, WITHOUT force:logout: an honest device reconnects by itself, with
 * the token it holds now, and a device whose session ended is then refused
 * by the handshake or by its first request.
 */
export function revokeSessionSockets(userId: string, sids: string | readonly string[], forceLogoutReason?: string): void {
  const sessionRooms = (typeof sids === 'string' ? [sids] : [...sids]).map(sessionRoom);
  if (sessionRooms.length === 0) return;
  try {
    const io = getIO();
    if (forceLogoutReason !== undefined) {
      io.to(sessionRooms).emit('force:logout', { reason: forceLogoutReason });
    }
    const rooms = [...sessionRooms, legacySocketsRoom(userId)];
    io.local.in(rooms).disconnectSockets(true);
    io.in(rooms).disconnectSockets(true);
  } catch (err) {
    const first = sessionRooms[0].slice('session:'.length, 'session:'.length + 6);
    console.error(
      `[Sessions] Could not disconnect the sockets of ${sessionRooms.length} session(s) (${first}…):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Signing out of every other session (POST /auth/sessions/revoke-others),
 * after the commit that bumped the account's version: every socket of
 * `userId` is disconnected on every node, by its `user:{id}` room, never
 * fetchSockets(). Before that, `force:logout` with `reason` goes to every
 * one of them except the caller's own session's (`session:{callerSid}`) and
 * the sockets that name no session (opened with an access token issued
 * before sessions, `nosid:{userId}`, where the caller's own device may sit:
 * its client would sign out on the word). The caller's sockets are
 * disconnected too, as after a password change: a socket is checked only
 * when it connects, and one opened with the session's tokens of the old
 * version must not stay open on them; its client reopens with the fresh
 * pair it was answered. Any other socket reconnects with the token its
 * client holds, which is refused when it is of the old version. Best effort
 * after the commit, never throws.
 */
export function revokeOtherSessionSockets(userId: string, callerSid: string | undefined, reason: string): void {
  const room = `user:${userId}`;
  const untold = [...(callerSid !== undefined ? [sessionRoom(callerSid)] : []), legacySocketsRoom(userId)];
  try {
    const io = getIO();
    io.to(room).except(untold).emit('force:logout', { reason });
    io.local.in(room).disconnectSockets(true);
    io.in(room).disconnectSockets(true);
  } catch (err) {
    console.error(`[Sessions] Could not disconnect the other sessions' sockets of user ${userId}:`, err instanceof Error ? err.message : err);
  }
}

/** Rooms per disconnect call: the cluster-wide form carries the list in one adapter message. */
export const SESSION_ROOMS_PER_CALL = 500;

/**
 * Disconnect the sockets of sessions deleted in bulk (the sweep: sessions
 * that had expired or were below their account's version), on every node,
 * by their `session:{sid}` rooms, at most SESSION_ROOMS_PER_CALL rooms per
 * call. No force:logout: an honest client reconnects and the handshake
 * tells it its session is gone. Best effort: logged without any id, never
 * throws.
 */
export function disconnectSessionRooms(sids: readonly string[]): void {
  for (let i = 0; i < sids.length; i += SESSION_ROOMS_PER_CALL) {
    const rooms = sids.slice(i, i + SESSION_ROOMS_PER_CALL).map(sessionRoom);
    try {
      const io = getIO();
      io.local.in(rooms).disconnectSockets(true);
      io.in(rooms).disconnectSockets(true);
    } catch (err) {
      console.error(`[Sessions] Could not disconnect the sockets of ${rooms.length} swept session(s):`, err instanceof Error ? err.message : err);
    }
  }
}
