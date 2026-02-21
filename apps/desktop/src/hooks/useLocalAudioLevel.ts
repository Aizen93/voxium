import { useState, useEffect, useRef } from 'react';
import { getAudioLevel } from '../services/audioAnalyser';

export function useLocalAudioLevel(): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    function tick() {
      setLevel(getAudioLevel());
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return level;
}
