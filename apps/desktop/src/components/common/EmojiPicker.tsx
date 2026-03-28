import { useEffect, useRef, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import EmojiPickerReact, { Theme, EmojiStyle, type EmojiClickData } from 'emoji-picker-react';

const PICKER_WIDTH = 350;
const PICKER_HEIGHT = 400;
const GAP = 8;

interface Props {
  onEmojiSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function EmojiPicker({ onEmojiSelect, onClose, anchorRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Vertical: prefer below, flip to above if not enough space
    let top: number;
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;

    if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP;
    } else if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP;
    } else {
      // Neither side fits — pick the bigger side and clamp to viewport
      top = spaceBelow >= spaceAbove
        ? Math.max(GAP, vh - PICKER_HEIGHT - GAP)
        : GAP;
    }

    // Horizontal: align right edge with anchor right, clamp to viewport
    let left = rect.right - PICKER_WIDTH;
    if (left < GAP) left = GAP;
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP;

    setPosition({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();

    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleClick = (emojiData: EmojiClickData) => {
    onEmojiSelect(emojiData.emoji);
  };

  if (!position) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-50"
      style={{ top: position.top, left: position.left }}
    >
      <EmojiPickerReact
        theme={Theme.DARK}
        emojiStyle={EmojiStyle.TWITTER}
        width={PICKER_WIDTH}
        height={PICKER_HEIGHT}
        lazyLoadEmojis
        onEmojiClick={handleClick}
        searchPlaceholder="Search emoji..."
      />
    </div>,
    document.body
  );
}
