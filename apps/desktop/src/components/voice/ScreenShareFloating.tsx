import { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useAuthStore } from '../../stores/authStore';
import { Maximize, Minimize2, MonitorOff } from 'lucide-react';
import { AnnotationCanvas } from './AnnotationCanvas';
import { useStageZoom, ZoomPill, MagnifierLens } from './StageZoom';
import { ReactionOverlay } from './Reactions';

const MIN_WIDTH = 240;
const MIN_HEIGHT = 180;
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 300;

export function ScreenShareFloating() {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { screenSharingUserId, remoteScreenStream, screenStream, isScreenSharing, screenShareFrozen } = useVoiceStore();
  const localUserId = useAuthStore((s) => s.user?.id);
  const setViewMode = useVoiceStore((s) => s.setScreenShareViewMode);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);
  const sourceChangeHold = useAnnotationStore((s) => s.sourceChangeHold);
  const confirmSourceChange = useAnnotationStore((s) => s.confirmSourceChange);

  const isLocalSharing = screenSharingUserId === localUserId;
  const stream = isLocalSharing ? screenStream : remoteScreenStream;
  const { zoom, style: zoomStyle, handlers: zoomHandlers, reset: resetZoom } = useStageZoom(stageRef, !!stream);

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

  // Fullscreen the stage wrapper, NOT the bare <video> — the annotation
  // canvas is a DOM sibling and would be invisible in element fullscreen.
  const handleFullscreen = () => {
    if (stageRef.current) {
      stageRef.current.requestFullscreen?.();
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
        <span className="text-xs text-vox-text-muted truncate">{t('voice.screenShare')}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleFullscreen}
            className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title={t('voice.fullscreen')}
            aria-label={t('voice.fullscreen')}
          >
            <Maximize size={12} />
          </button>
          <button
            onClick={() => setViewMode('inline')}
            className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title={t('voice.dockToInline')}
            aria-label={t('voice.dockToInline')}
          >
            <Minimize2 size={12} />
          </button>
          {isScreenSharing && (
            <button
              onClick={stopScreenShare}
              className="rounded p-1 text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors"
              title={t('voice.stopSharing')}
              aria-label={t('voice.stopSharing')}
            >
              <MonitorOff size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Video + annotation overlay stage */}
      <div ref={stageRef} className="relative flex flex-1 items-center justify-center bg-black" style={{ height: size.h - 28 }}>
        {isLocalSharing && sourceChangeHold && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-vox-accent-warning/90 px-2 py-0.5 text-[10px] font-medium text-black" data-testid="floating-source-change-banner">
            <span className="truncate">
              {t('voice.annotations.sourceChanged', {
                from: `${sourceChangeHold.fromW}×${sourceChangeHold.fromH}`,
                to: `${sourceChangeHold.toW}×${sourceChangeHold.toH}`,
              })}
            </span>
            <button
              onClick={confirmSourceChange}
              className="shrink-0 rounded bg-black/20 px-1.5 font-semibold hover:bg-black/30"
              data-testid="floating-source-change-resume"
            >
              {t('voice.annotations.sourceChangedResume')}
            </button>
          </div>
        )}
        {isLocalSharing && screenShareFrozen && !sourceChangeHold && (
          <div className="absolute inset-x-0 top-0 z-10 bg-vox-accent-danger/90 px-2 py-0.5 text-center text-[10px] text-white">
            {t('voice.annotations.sharePaused')}
          </div>
        )}
        {stream ? (
          <>
            <div
              className="relative flex h-full w-full items-center justify-center"
              style={zoomStyle}
              data-testid="floating-zoom-surface"
              {...zoomHandlers}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="max-h-full max-w-full object-contain"
              />
              <AnnotationCanvas videoRef={videoRef} />
            </div>
            <ZoomPill zoom={zoom} onReset={resetZoom} />
            <MagnifierLens videoRef={videoRef} stageRef={stageRef} disabled={zoom.scale > 1} />
            <ReactionOverlay />
          </>
        ) : (
          <p className="text-vox-text-muted text-xs">{t('voice.waitingForStream')}</p>
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
