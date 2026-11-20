import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

/** A help icon that shows `text` in a portaled tooltip while hovered. */
export function Tip({ text }: { text: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleEnter = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    setShow(true);
  }, []);

  return (
    <span ref={iconRef} className="inline-flex ml-1 cursor-help" onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      <HelpCircle size={12} className="text-vox-text-muted" />
      {show && createPortal(
        <div
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
          className="w-52 px-2 py-1.5 text-[10px] leading-tight text-vox-text-primary bg-vox-bg-primary border border-vox-border rounded shadow-lg z-[9999] normal-case font-normal tracking-normal whitespace-normal"
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}
