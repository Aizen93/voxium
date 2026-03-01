import { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { Maximize, Minimize2, MonitorOff } from 'lucide-react';

const MIN_WIDTH = 240;
const MIN_HEIGHT = 180;
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 300;

export function ScreenShareFloating() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { screenSharingUserId, remoteScreenStream, screenStream, isScreenSharing } = useVoiceStore();
  const localUserId = useAuthStore((s) => s.user?.id);
  const setViewMode = useVoiceStore((s) => s.setScreenShareViewMode);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);

  const isLocalSharing = screenSharingUserId === localUserId;
  const stream = isLocalSharing ? screenStream : remoteScreenStream;

  const [pos, setPos] = useState({ x: window.innerWidth - DEFAULT_WIDTH - 16, y: window.innerHeight - DEFAULT_HEIGHT - 80 });
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
    }
    return () => {
      if (video) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - size.w, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - size.h, e.clientY - dragOffset.current.y)),
      });
    };
    const handleUp = () => setDragging(false);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, size]);

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
  }, [size]);

  useEffect(() => {
    if (!resizing) return;

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStart.current.x;
      const dy = e.clientY - resizeStart.current.y;
      setSize({
        w: Math.max(MIN_WIDTH, resizeStart.current.w + dx),
        h: Math.max(MIN_HEIGHT, resizeStart.current.h + dy),
      });
    };
    const handleUp = () => setResizing(false);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizing]);

  // Keep in viewport on window resize
  useEffect(() => {
    const handleResize = () => {
      setPos((p) => ({
        x: Math.max(0, Math.min(window.innerWidth - size.w, p.x)),
        y: Math.max(0, Math.min(window.innerHeight - size.h, p.y)),
      }));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [size]);

  const handleFullscreen = () => {
    if (videoRef.current) {
      videoRef.current.requestFullscreen?.();
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-40 overflow-hidden rounded-lg border border-vox-border bg-black shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Draggable title bar */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-2 py-1 bg-vox-bg-secondary cursor-move select-none"
      >
        <span className="text-xs text-vox-text-muted truncate">Screen Share</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleFullscreen}
            className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title="Fullscreen"
          >
            <Maximize size={12} />
          </button>
          <button
            onClick={() => setViewMode('inline')}
            className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title="Dock to inline"
          >
            <Minimize2 size={12} />
          </button>
          {isScreenSharing && (
            <button
              onClick={stopScreenShare}
              className="rounded p-1 text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors"
              title="Stop sharing"
            >
              <MonitorOff size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Video */}
      <div className="flex flex-1 items-center justify-center" style={{ height: size.h - 28 }}>
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="text-vox-text-muted text-xs">Waiting for stream...</p>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.2) 50%)' }}
      />
    </div>,
    document.body
  );
}
