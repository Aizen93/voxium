import { useState, useEffect, useRef } from 'react';
import { isSpeechDetected } from '../services/audioAnalyser';

/**
 * Whether the local user is speaking, for the DM call panels' own ring: the
 * speaking detector's own decision, the one the other person is told
 * (dm:voice:speaking), whichever decider runs (the audio-thread gate or the
 * page timer), so the ring lights when the detector hears speech, at the
 * user's threshold: under the audio-thread gate that is what the gate lets
 * through; while the page timer decides a direct call sends everything, and
 * the ring still lights only over the threshold. False while muted (the
 * detector is paused then), with the push-to-talk key held too. This
 * reads it once an animation frame but sets state only when the answer
 * FLIPS, so its component re-renders when the user starts or stops speaking,
 * not on every frame. While `enabled` is false (no DM call, or a ring that
 * cannot light) no frame loop runs at all.
 */
export function useLocalSpeaking(enabled: boolean): boolean {
  const [speaking, setSpeaking] = useState(false);
  const last = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let frame = requestAnimationFrame(function tick() {
      const next = isSpeechDetected();
      if (next !== last.current) {
        last.current = next;
        setSpeaking(next);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      // The next enable starts from silence, not from this answer
      if (last.current) {
        last.current = false;
        setSpeaking(false);
      }
    };
  }, [enabled]);

  return enabled && speaking;
}
