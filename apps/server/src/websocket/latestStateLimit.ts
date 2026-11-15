// ─── Latest-wins rate limiting for STATE events ─────────────────────────────
// Used by voice:speaking (voiceHandler) and dm:voice:speaking (dmVoiceHandler).
// A module of its own: voiceHandler imports dmVoiceHandler, so neither can own
// it for the other.

/**
 * The client's speaking detector sends "speaking" when the level crosses the
 * noise gate and "not speaking" after 300 ms below it, sampled every 20 ms:
 * one on/off cycle takes at least ~340 ms, so an honest client stays under
 * ~360 events a minute however choppy the speech. Per socket and minute, for
 * the mic producer's pause/resume (each a message to the mediasoup worker)
 * and for relayed speaking events on a home node: well above what an honest
 * client can send, so the producer never trails the voice.
 */
export const SPEAKING_EVENTS_PER_MINUTE = 600;

/**
 * Per socket and minute, for the speaking-INDICATOR broadcasts: just what an
 * honest client can send, no more. A voice channel's indicator goes to every
 * online viewer of `channel:{id}`, not only to the people in the call, so this
 * is the budget that multiplies.
 */
export const SPEAKING_INDICATOR_EVENTS_PER_MINUTE = 360;

interface LatestStateWindow {
  count: number;
  resetAt: number;
  held: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}
const latestStateWindows = new WeakMap<object, Map<string, LatestStateWindow>>();

/**
 * A fixed one-minute window per socket and name, like socketRateLimit, for an
 * event that carries a STATE (speaking on or off), where the LATEST value must
 * win. Within the budget `apply` runs now and drops any value held earlier.
 * Over it, `apply` is held instead of dropped (replacing an older held one)
 * and runs once when the window ends, charged to the next window: the budget
 * still bounds the work, and the last state is never lost. A dropped "speaking"
 * left the mic producer paused on the SFU while the person talked (#90).
 *
 * `apply` may run up to a minute later, so it re-checks everything it relies on.
 * Keyed by the socket OBJECT: on an owner node that is the participant's shim,
 * which voiceRelay keeps for the session.
 */
export function applyLatestState(socket: object, name: string, maxPerMinute: number, apply: () => void): void {
  let windows = latestStateWindows.get(socket);
  if (!windows) {
    windows = new Map();
    latestStateWindows.set(socket, windows);
  }
  const now = Date.now();
  let window = windows.get(name);
  if (!window || now >= window.resetAt) {
    // A window that ended before its timer ran: whatever it held is older
    // than this event, which supersedes it
    if (window?.timer) clearTimeout(window.timer);
    window = { count: 0, resetAt: now + 60_000, held: null, timer: null };
    windows.set(name, window);
  }
  window.count++;
  if (window.count <= maxPerMinute) {
    window.held = null;
    apply();
    return;
  }
  window.held = apply;
  if (window.timer) return;
  const ended = window;
  const all = windows;
  ended.timer = setTimeout(() => {
    ended.timer = null;
    const held = ended.held;
    ended.held = null;
    if (!held) return;
    all.set(name, { count: 1, resetAt: Date.now() + 60_000, held: null, timer: null });
    try {
      held();
    } catch (err) {
      console.error(`[Voice] Applying the held ${name} state failed:`, err);
    }
  }, Math.max(0, ended.resetAt - now));
  ended.timer.unref?.();
}
