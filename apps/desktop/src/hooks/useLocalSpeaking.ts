import { useState, useEffect, useRef } from 'react';
import { getAudioLevel } from '../services/audioAnalyser';

/** The mic level (0..1) above which the local user's ring lights in a DM call. */
export const LOCAL_SPEAKING_LEVEL = 0.05;

/**
 * Whether the local microphone is above the speaking level, for the DM call
 * panels' own ring. The speaking detector updates the level every 20 ms in any
 * voice session: this reads it once an animation frame but sets state only
 * when the answer FLIPS, so its component re-renders when the user starts or
 * stops speaking, not 50 times a second. While `enabled` is false (no DM call,
 * or a ring that cannot light) no frame loop runs at all.
 */
export function useLocalSpeaking(enabled: boolean): boolean {
  const [speaking, setSpeaking] = useState(false);
  const last = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let frame = requestAnimationFrame(function tick() {
      const next = getAudioLevel() > LOCAL_SPEAKING_LEVEL;
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
