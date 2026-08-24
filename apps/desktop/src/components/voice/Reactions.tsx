import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { ANNOTATION_REACTIONS } from '@voxium/shared';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';
import { useAnnotationStore } from '../../stores/annotationStore';

/**
 * Live emoji reactions over the share (item 12). Ephemeral by design: the
 * wire carries an INDEX into ANNOTATION_REACTIONS (never a string — no
 * arbitrary Unicode, no bidi checks needed), the server authorizes any voice
 * room member on its own rate bucket, nothing persists, and every client caps
 * what is in flight. Rendering is DOM + CSS animation, NOT canvas — emoji
 * text on canvas renders inconsistently across platforms.
 *
 * The sharer cannot disable reactions for others in v1 (accepted decision) —
 * the eye toggle is a per-viewer device pref (`showReactions`).
 */

/** Deterministic per-id jitter — no per-render randomness, stable in StrictMode. */
function jitterHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function ReactionOverlay() {
  const reactions = useAnnotationLiveStore((s) => s.reactions);
  const show = useAnnotationStore((s) => s.showReactions);
  const [rise, setRise] = useState(160);
  const measure = useCallback((el: HTMLDivElement | null) => {
    // 35% of the stage height; measured on mount (stage resizes are rare and
    // only affect how far NEW reactions rise)
    if (el && el.clientHeight > 0) setRise(Math.max(80, Math.round(el.clientHeight * 0.35)));
  }, []);
  if (!show || reactions.length === 0) return null;
  return (
    <div
      ref={measure}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      data-testid="reaction-overlay"
      aria-hidden="true"
    >
      {reactions.map((r) => {
        const h = jitterHash(r.id);
        const left = 62 + (h % 28); // bottom-right band: 62–89% across
        const drift = ((h >> 5) % 61) - 30; // −30..+30 px of horizontal wander
        return (
          <span
            key={r.id}
            className="vox-reaction absolute bottom-[6%] text-2xl"
            style={{
              left: `${left}%`,
              ['--vox-reaction-drift' as string]: `${drift}px`,
              ['--vox-reaction-rise' as string]: `${rise}px`,
            }}
          >
            {ANNOTATION_REACTIONS[r.e] ?? ''}
          </span>
        );
      })}
    </div>
  );
}

/** Local pacing under the server's 10/min bucket — a rejected live event is
 *  dropped silently server-side while the local echo already showed it, so
 *  not hammering is kinder than pretending it went through. */
const REACTION_SEND_MIN_INTERVAL_MS = 1_000;

export function ReactionStrip() {
  const { t } = useTranslation();
  const show = useAnnotationStore((s) => s.showReactions);
  const setShowReactions = useAnnotationStore((s) => s.setShowReactions);
  const lastSentRef = useRef(0);

  const send = (index: number) => {
    const now = Date.now();
    if (now - lastSentRef.current < REACTION_SEND_MIN_INTERVAL_MS) return;
    lastSentRef.current = now;
    useAnnotationLiveStore.getState().react(index);
  };

  return (
    <div
      className="absolute bottom-2 right-2 z-20 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5"
      data-testid="reaction-strip"
      // The stage pans on pointer drag while zoomed — a press on the strip is
      // a reaction, not a pan
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {ANNOTATION_REACTIONS.map((emoji, i) => (
        <button
          key={emoji}
          onClick={() => send(i)}
          className="rounded-full px-1 text-base leading-6 transition-transform hover:scale-125"
          title={emoji}
          aria-label={t('voice.reactions.send', { emoji })}
          data-reaction-index={i}
        >
          {emoji}
        </button>
      ))}
      <button
        onClick={() => setShowReactions(!show)}
        className="ml-0.5 rounded-full p-1 text-white/70 hover:bg-white/20 hover:text-white"
        title={show ? t('voice.reactions.hide') : t('voice.reactions.show')}
        aria-label={show ? t('voice.reactions.hide') : t('voice.reactions.show')}
        aria-pressed={!show}
        data-testid="reaction-visibility-toggle"
      >
        {show ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </div>
  );
}
