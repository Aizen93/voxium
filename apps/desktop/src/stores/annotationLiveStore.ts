import { create } from 'zustand';
import {
  ANNOTATION_LIVE_POINTER_INTERVAL_MS,
  ANNOTATION_LIVE_POINTER_FADE_MS,
  ANNOTATION_REACTIONS,
  type AnnotationLiveEvent,
} from '@voxium/shared';
import { getSocket } from '../services/socket';
import { useVoiceStore } from './voiceStore';

/**
 * Transient screen-share overlay state — everything that is SEEN but never
 * part of the scene: the sharer's laser pointer, floating reactions, the
 * "someone took a snapshot" notice. Fed by voice:annotation:live (viewers)
 * and by the sharer's own local echo; nothing here ever enters the op queue,
 * the history, or a hydration snapshot.
 *
 * Time-dependent rendering (trails, fades) is the canvas scheduler's job —
 * this store only records WHAT happened and WHEN, on the local clock.
 */

export interface LivePointer {
  x: number;
  y: number;
  /** Local receive time (Date.now()) — never a remote timestamp. */
  at: number;
  /** Most recent positions first-in, oldest dropped; drawn as a fading tail. */
  trail: { x: number; y: number; at: number }[];
}

export interface LiveReaction {
  id: string;
  userId: string;
  /** Index into ANNOTATION_REACTIONS. */
  e: number;
  at: number;
}

export const LIVE_POINTER_TRAIL_MAX = 8;
export const LIVE_REACTIONS_MAX_IN_FLIGHT = 30;
/** A reaction is done rising (and dropped) after this. */
export const LIVE_REACTION_TTL_MS = 2_500;

interface AnnotationLiveState {
  pointer: LivePointer | null;
  reactions: LiveReaction[];
  snapshotNotice: { userId: string; at: number } | null;

  /** A remote event, already filtered by channel/sharer in the socket handler. */
  receive: (userId: string, ev: AnnotationLiveEvent) => void;
  /** Sharer local echo + throttled send of the pointer position. */
  pointTo: (x: number, y: number) => void;
  /** Sharer: pointer left the stage / tool switched. Immediate, never throttled. */
  pointerOff: () => void;
  /** Local echo + send of a reaction (any voice member). */
  react: (e: number) => void;
  /** Tell the sharer we took a snapshot (courtesy notice). */
  notifySnapshot: () => void;
  /** Drop expired reactions / a faded pointer. Called by the canvas scheduler. */
  prune: (now: number) => void;
  clear: () => void;
}

// ─── Pointer send throttle (module-level: not renderable state) ──────────────
// Leading + trailing: the first move goes out at once, bursts are coalesced to
// one send per interval, and the LAST position of a burst is always sent (a
// dropped final position would leave viewers' dot short of where the sharer
// stopped). pointer-off cancels any pending trailing send.

let lastPointerSentAt = 0;
let pendingPointer: { x: number; y: number } | null = null;
let pointerTimer: ReturnType<typeof setTimeout> | null = null;

function sendLive(ev: AnnotationLiveEvent): void {
  const channelId = useVoiceStore.getState().activeChannelId;
  const socket = getSocket();
  if (!channelId || !socket) return;
  socket.emit('voice:annotation:live', { channelId, ev });
}

function flushPendingPointer(): void {
  pointerTimer = null;
  if (!pendingPointer) return;
  const { x, y } = pendingPointer;
  pendingPointer = null;
  lastPointerSentAt = Date.now();
  sendLive({ k: 'pointer', x, y });
}

function cancelPendingPointer(): void {
  pendingPointer = null;
  if (pointerTimer) {
    clearTimeout(pointerTimer);
    pointerTimer = null;
  }
}

/** Forget the throttle's clock too — a new share's first move must go out at
 *  once, not be scheduled behind the previous share's last send. */
export function resetAnnotationLiveModuleState(): void {
  cancelPendingPointer();
  lastPointerSentAt = 0;
}

const clampNorm = (v: number) => Math.min(1, Math.max(0, v));

function pushPointer(prev: LivePointer | null, x: number, y: number, at: number): LivePointer {
  const trail = prev ? [...prev.trail, { x: prev.x, y: prev.y, at: prev.at }] : [];
  if (trail.length > LIVE_POINTER_TRAIL_MAX) trail.splice(0, trail.length - LIVE_POINTER_TRAIL_MAX);
  return { x, y, at, trail };
}

let reactionSeq = 0;

export const useAnnotationLiveStore = create<AnnotationLiveState>((set, get) => ({
  pointer: null,
  reactions: [],
  snapshotNotice: null,

  receive: (userId, ev) => {
    const now = Date.now();
    switch (ev.k) {
      case 'pointer':
        set((s) => ({ pointer: pushPointer(s.pointer, ev.x, ev.y, now) }));
        break;
      case 'pointer-off':
        set({ pointer: null });
        break;
      case 'reaction': {
        if (!Number.isInteger(ev.e) || ev.e < 0 || ev.e >= ANNOTATION_REACTIONS.length) return;
        set((s) => {
          const next = [...s.reactions, { id: `r${++reactionSeq}`, userId, e: ev.e, at: now }];
          // Oldest dropped first — a burst never grows the DOM without bound
          return { reactions: next.length > LIVE_REACTIONS_MAX_IN_FLIGHT ? next.slice(next.length - LIVE_REACTIONS_MAX_IN_FLIGHT) : next };
        });
        break;
      }
      case 'snapshot':
        set({ snapshotNotice: { userId, at: now } });
        break;
    }
  },

  pointTo: (x, y) => {
    const nx = clampNorm(x), ny = clampNorm(y);
    const now = Date.now();
    set((s) => ({ pointer: pushPointer(s.pointer, nx, ny, now) }));
    // A wall clock can step BACKWARDS (NTP correction): treat that as an
    // elapsed window rather than scheduling the trailing send hours out.
    const sinceLast = now < lastPointerSentAt ? Infinity : now - lastPointerSentAt;
    if (sinceLast >= ANNOTATION_LIVE_POINTER_INTERVAL_MS && !pointerTimer) {
      lastPointerSentAt = now;
      sendLive({ k: 'pointer', x: nx, y: ny });
      return;
    }
    // Inside the window (sinceLast is finite here: the Infinity case returned above)
    pendingPointer = { x: nx, y: ny };
    if (!pointerTimer) {
      pointerTimer = setTimeout(flushPendingPointer, Math.max(0, ANNOTATION_LIVE_POINTER_INTERVAL_MS - sinceLast));
    }
  },

  pointerOff: () => {
    const had = get().pointer !== null || pendingPointer !== null;
    cancelPendingPointer();
    set({ pointer: null });
    if (had) sendLive({ k: 'pointer-off' });
  },

  react: (e) => {
    if (!Number.isInteger(e) || e < 0 || e >= ANNOTATION_REACTIONS.length) return;
    const userId = useVoiceStore.getState().localUserId;
    get().receive(userId ?? 'me', { k: 'reaction', e });
    sendLive({ k: 'reaction', e });
  },

  notifySnapshot: () => {
    sendLive({ k: 'snapshot' });
  },

  prune: (now) => {
    const s = get();
    const pointerExpired = s.pointer !== null && now - s.pointer.at > ANNOTATION_LIVE_POINTER_FADE_MS;
    const liveReactions = s.reactions.filter((r) => now - r.at < LIVE_REACTION_TTL_MS);
    const noticeExpired = s.snapshotNotice !== null && now - s.snapshotNotice.at > 4_000;
    if (!pointerExpired && liveReactions.length === s.reactions.length && !noticeExpired) return;
    set({
      ...(pointerExpired ? { pointer: null } : {}),
      ...(liveReactions.length !== s.reactions.length ? { reactions: liveReactions } : {}),
      ...(noticeExpired ? { snapshotNotice: null } : {}),
    });
  },

  clear: () => {
    resetAnnotationLiveModuleState();
    set({ pointer: null, reactions: [], snapshotNotice: null });
  },
}));

/** True while anything here still needs time-driven redraws. */
export function hasLiveActivity(state: Pick<AnnotationLiveState, 'pointer' | 'reactions' | 'snapshotNotice'>): boolean {
  return state.pointer !== null || state.reactions.length > 0 || state.snapshotNotice !== null;
}
