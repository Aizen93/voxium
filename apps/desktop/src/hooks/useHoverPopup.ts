import { useState, useRef, useCallback, useEffect } from 'react';

const SHOW_DELAY = 300;
const HIDE_DELAY = 200;

export function useHoverPopup() {
  const [isVisible, setIsVisible] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const startShowTimer = useCallback(() => {
    clearTimers();
    showTimer.current = setTimeout(() => {
      setIsVisible(true);
    }, SHOW_DELAY);
  }, [clearTimers]);

  const startHideTimer = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setIsVisible(false);
    }, HIDE_DELAY);
  }, []);

  const cancelHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setIsVisible(false);
  }, [clearTimers]);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  const triggerProps = {
    ref: triggerRef,
    onMouseEnter: startShowTimer,
    onMouseLeave: startHideTimer,
  };

  const popupProps = {
    onMouseEnter: cancelHideTimer,
    onMouseLeave: startHideTimer,
  };

  return { isVisible, triggerRef, triggerProps, popupProps, close };
}
