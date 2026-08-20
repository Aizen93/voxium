import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Eye } from 'lucide-react';

/**
 * The bar that stays on screen while a theme is being previewed on the WHOLE
 * app — the only chrome left after the settings modal (and, in the editor's
 * case, the editor itself) get out of the way.
 *
 * Shared by the marketplace and the theme editor so "try it on the real app"
 * looks and behaves the same in both, Escape included.
 */
export function ThemePreviewBar({ name, onStop }: { name: string; onStop: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onStop]);

  return createPortal(
    <div
      data-testid="theme-preview-bar"
      className="fixed bottom-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-xl px-5 py-3 shadow-2xl"
      style={{
        backgroundColor: 'var(--vox-bg-floating)',
        border: '1px solid var(--vox-border)',
      }}
    >
      <Eye size={14} style={{ color: 'var(--vox-accent-primary)' }} />
      <span className="text-xs font-medium" style={{ color: 'var(--vox-text-primary)' }}>
        Previewing: <span className="font-bold">{name}</span>
      </span>
      <button
        onClick={onStop}
        className="rounded-lg px-3 py-1 text-xs font-medium text-white"
        style={{ backgroundColor: 'var(--vox-accent-primary)' }}
      >
        Stop Preview
      </button>
      <span className="text-[10px]" style={{ color: 'var(--vox-text-muted)' }}>
        Esc
      </span>
    </div>,
    document.body,
  );
}
