import { getIO } from '../websocket/socketServer';

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
