import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { logMessage } from '../utils/apiError';

interface AdminConfirmModalProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  variant?: 'danger' | 'primary';
  /**
   * Whether Escape and a click on the backdrop cancel (default true). A dialog that holds something
   * the user typed or ticked passes false: only the Cancel button and the close X cancel it then.
   */
  dismissible?: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function AdminConfirmModal({ title, message, confirmLabel = 'Confirm', danger = true, variant, dismissible = true, onConfirm, onCancel }: AdminConfirmModalProps) {
  const [loading, setLoading] = useState(false);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Where the last press went down and came up: a backdrop click counts only when both were the backdrop
  const pressOnBackdrop = useRef({ down: false, up: false });

  // Focus starts on Cancel (the safe answer to a destructive question) and
  // goes back to whatever had it when the dialog closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Escape cancels, except while the confirm action is in flight or when the dialog is not
  // dismissible. The event it handles goes no further, so nothing above it acts on the same key.
  useEffect(() => {
    if (loading || !dismissible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [loading, dismissible, onCancel]);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } catch (err) {
      // The dialog stays open and usable; the message only, never the error object (it can carry a response body).
      console.error('Confirm action failed:', logMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        pressOnBackdrop.current = { down: e.target === e.currentTarget, up: false };
      }}
      onMouseUp={(e) => { pressOnBackdrop.current.up = e.target === e.currentTarget; }}
      onClick={(e) => {
        // A press that starts in the card and ends on the backdrop (a text selection), or the other
        // way round, is not a click on the backdrop
        const { down, up } = pressOnBackdrop.current;
        pressOnBackdrop.current = { down: false, up: false };
        if (dismissible && down && up && e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="text-lg font-semibold text-vox-text-primary">{title}</h3>
          <button onClick={onCancel} aria-label="Close" className="text-vox-text-muted hover:text-vox-text-primary">
            <X size={20} />
          </button>
        </div>
        <div className="text-sm text-vox-text-secondary mb-6">{message}</div>
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className={`px-4 py-2 text-sm rounded-md text-white transition-colors disabled:opacity-50 ${
              (variant === 'danger' || (variant === undefined && danger)) ? 'bg-vox-accent-danger hover:bg-red-600' : 'bg-vox-accent-primary hover:bg-vox-accent-hover'
            }`}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
