import { useState, useCallback, useEffect } from 'react';
import { Minus, Square, X, Maximize2 } from 'lucide-react';

const TAURI_AVAILABLE = '__TAURI_INTERNALS__' in window;

async function getTauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  // Sync maximized state when window is resized externally (e.g. Win+Up, Snap Assist)
  useEffect(() => {
    if (!TAURI_AVAILABLE) return;
    let unlisten: (() => void) | undefined;
    getTauriWindow().then(async (win) => {
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    }).catch((err) => console.warn('[TitleBar] Failed to listen for resize:', err));
    return () => { unlisten?.(); };
  }, []);

  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    try {
      const win = await getTauriWindow();
      await win.startDragging();
    } catch (err) {
      console.warn('[TitleBar] startDragging failed:', err);
    }
  }, []);

  const handleDoubleClick = useCallback(async () => {
    try {
      const win = await getTauriWindow();
      await win.toggleMaximize();
      setMaximized(await win.isMaximized());
    } catch (err) {
      console.warn('[TitleBar] toggleMaximize failed:', err);
    }
  }, []);

  const handleMinimize = useCallback(async () => {
    try {
      const win = await getTauriWindow();
      await win.minimize();
    } catch (err) {
      console.warn('[TitleBar] minimize failed:', err);
    }
  }, []);

  const handleMaximize = useCallback(async () => {
    try {
      const win = await getTauriWindow();
      await win.toggleMaximize();
      setMaximized(await win.isMaximized());
    } catch (err) {
      console.warn('[TitleBar] toggleMaximize failed:', err);
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const win = await getTauriWindow();
      await win.close();
    } catch (err) {
      console.warn('[TitleBar] close failed:', err);
    }
  }, []);

  if (!TAURI_AVAILABLE) return null;

  return (
    <div
      className="flex h-8 shrink-0 items-center bg-vox-sidebar select-none"
      onMouseDown={handleDragStart}
      onDoubleClick={handleDoubleClick}
    >
      {/* App icon + name */}
      <div className="flex items-center gap-2 pl-3">
        <img src="/logo.svg" alt="Voxium" className="h-4 w-4" draggable={false} />
        <span className="text-xs font-semibold text-vox-text-primary tracking-wide">Voxium</span>
      </div>

      {/* Spacer — draggable area */}
      <div className="flex-1" />

      {/* Window controls */}
      <div className="flex h-full">
        <button
          onClick={handleMinimize}
          className="flex h-full w-11 items-center justify-center text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
          tabIndex={-1}
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={handleMaximize}
          className="flex h-full w-11 items-center justify-center text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
          tabIndex={-1}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Square size={12} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={handleClose}
          className="flex h-full w-11 items-center justify-center text-vox-text-muted hover:bg-red-600 hover:text-white transition-colors"
          tabIndex={-1}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
