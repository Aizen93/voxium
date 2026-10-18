import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** id of the element that names the dialog (its heading). */
  labelledBy: string;
  onClose: () => void;
  /** While true (a request in flight) neither Escape nor the backdrop closes it. */
  busy?: boolean;
  /** The backdrop click closes it; off for the copy-once panel, where a stray click would lose the URL. */
  closeOnBackdrop?: boolean;
  /** Escape closes it; off for the copy-once panel, where a reflex keystroke would lose the URL. */
  closeOnEscape?: boolean;
  /**
   * Where focus lands on open (default: the first focusable element). Children
   * must NOT `autoFocus`: it runs during the commit, before the effect below
   * records the opener, which would then be the field itself and focus could
   * not go back to the button that opened the dialog.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  testId?: string;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * The shell of the Integrations tab's dialogs (create, copy-once, rotate and
 * delete confirms): portaled above Server settings, Escape closes (unless
 * turned off), Tab cycles inside the panel, focus moves in on open (to
 * `initialFocusRef`, else the first focusable element) and returns to the
 * opener on close.
 */
export function WebhookDialog({
  labelledBy, onClose, busy = false, closeOnBackdrop = true, closeOnEscape = true, initialFocusRef, testId, children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Once per dialog, on open (the ref object is stable; its target is set by now)
  useEffect(() => {
    // Nothing inside has focus yet (no child autofocuses), so this is the opener
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) (initialFocusRef?.current ?? focusables(panel)[0] ?? panel).focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeOnEscape && !busy) onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const panel = panelRef.current;
      const items = focusables(panel);
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, closeOnEscape, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 animate-fade-in"
      onMouseDown={(e) => { if (closeOnBackdrop && !busy && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="w-full max-w-lg rounded-2xl border border-vox-border bg-vox-bg-secondary p-5 shadow-2xl outline-none animate-slide-up"
        data-testid={testId}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
