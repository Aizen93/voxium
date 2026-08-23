import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Monitor, MousePointer2, ShieldOff } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useMaskLayoutStore } from '../../stores/maskLayoutStore';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationEditorLayer, type ToolCapabilities } from './AnnotationEditorLayer';
import { loadAnnotationPrefs, saveAnnotationPrefs } from '../../utils/annotationPrefs';
import type { MaskStyle } from '../../utils/maskStyles';

/**
 * "Prepare your share": the capture is LOCAL — nothing has been claimed and
 * nothing produced, viewers do not even know a share is coming — and the
 * sharer places privacy masks on a live preview before the first frame can
 * leave the machine. Going live hands the stream to the share flow, which
 * produces the COMPOSITED track from frame one when masks exist.
 *
 * The editor layer runs mask-only here (ToolCapabilities), the remembered
 * layout for this source is already applied (maskLayoutStore keys off
 * pendingShare), and a whole-monitor capture always carries the nudge —
 * notifications and every other window are in frame.
 */

const PREFLIGHT_CAPABILITIES: ToolCapabilities = {
  tools: new Set(['select', 'mask']),
  masks: true,
  images: false,
  // Another user may be LIVE-sharing while this pre-flight is open: their
  // scene must not paint over the private preview, and select must not be
  // able to drag their objects (a drag enqueues real ops toward the wire).
  sceneObjects: false,
};

const MASK_STYLES: readonly { style: MaskStyle; labelKey: string }[] = [
  { style: 'cover', labelKey: 'voice.annotations.maskStyleCover' },
  { style: 'pixelate', labelKey: 'voice.annotations.maskStylePixelate' },
  { style: 'blur', labelKey: 'voice.annotations.maskStyleBlur' },
];

export function SharePreflightModal() {
  const { t } = useTranslation();
  const pendingShare = useVoiceStore((s) => s.pendingShare);
  const confirmPendingShare = useVoiceStore((s) => s.confirmPendingShare);
  const cancelPendingShare = useVoiceStore((s) => s.cancelPendingShare);
  const activeChannelId = useVoiceStore((s) => s.activeChannelId);
  const activeTool = useAnnotationStore((s) => s.activeTool);
  const setActiveTool = useAnnotationStore((s) => s.setActiveTool);
  const maskStyle = useAnnotationStore((s) => s.maskStyle);
  const setMaskStyle = useAnnotationStore((s) => s.setMaskStyle);
  const maskCount = useAnnotationStore((s) => s.masks.length);
  const appliedLayout = useMaskLayoutStore((s) => s.appliedLayout);
  const startFresh = useMaskLayoutStore((s) => s.startFresh);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [skip, setSkip] = useState(() => loadAnnotationPrefs().skipPreflight);
  const [going, setGoing] = useState(false);

  const stream = pendingShare?.stream ?? null;

  // The mask tool is the reason this modal exists — start on it
  useEffect(() => {
    if (pendingShare) useAnnotationStore.getState().setActiveTool('mask');
  }, [pendingShare]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) video.srcObject = stream;
    return () => {
      if (video) video.srcObject = null;
    };
  }, [stream]);

  // Leaving voice mid-pre-flight abandons it; Escape cancels
  useEffect(() => {
    if (!pendingShare) return;
    if (!activeChannelId) {
      cancelPendingShare();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPendingShare();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingShare, activeChannelId, cancelPendingShare]);

  if (!pendingShare || !stream) return null;

  const persistSkip = (value: boolean) => {
    setSkip(value);
    saveAnnotationPrefs({ ...loadAnnotationPrefs(), skipPreflight: value });
  };

  const goLive = async () => {
    if (going) return;
    setGoing(true);
    try {
      await confirmPendingShare();
    } finally {
      setGoing(false);
    }
  };

  const toolButton = (tool: 'select' | 'mask', label: string, Icon: typeof MousePointer2) => (
    <button
      onClick={() => setActiveTool(tool)}
      className={`rounded p-1.5 transition-colors ${
        activeTool === tool ? 'bg-vox-accent-primary/20 text-vox-accent-primary' : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
      }`}
      title={label}
      aria-label={label}
      aria-pressed={activeTool === tool}
      data-preflight-tool={tool}
    >
      <Icon size={15} />
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" data-testid="share-preflight">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-vox-border bg-vox-bg-primary shadow-2xl">
        <div className="border-b border-vox-border px-4 py-3">
          <h2 className="text-sm font-semibold text-vox-text-primary">{t('voice.preflight.title')}</h2>
          <p className="mt-0.5 text-xs text-vox-text-muted">{t('voice.preflight.subtitle')}</p>
        </div>

        {pendingShare.displaySurface === 'monitor' && (
          <div className="flex items-center gap-2 bg-vox-accent-warning/90 px-4 py-1.5 text-xs font-medium text-black" data-testid="preflight-monitor-nudge">
            <Monitor size={13} />
            {t('voice.preflight.monitorNudge')}
          </div>
        )}

        {appliedLayout && (
          <div className="flex items-center justify-between gap-3 bg-vox-accent-info/20 px-4 py-1.5 text-xs text-vox-text-primary" data-testid="preflight-layout-banner">
            <span>{t('voice.annotations.layoutApplied', { count: appliedLayout.count })}</span>
            <button onClick={startFresh} className="rounded bg-vox-bg-hover px-2 py-0.5 font-semibold hover:bg-vox-bg-active">
              {t('voice.annotations.layoutFresh')}
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-vox-border bg-vox-bg-secondary px-3 py-1.5">
          {toolButton('select', t('voice.annotations.select'), MousePointer2)}
          {toolButton('mask', t('voice.annotations.mask'), ShieldOff)}
          <div className="ml-2 flex items-center gap-0.5">
            {MASK_STYLES.map(({ style, labelKey }) => (
              <button
                key={style}
                onClick={() => setMaskStyle(style)}
                className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                  maskStyle === style ? 'bg-vox-accent-primary/20 text-vox-accent-primary' : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
                }`}
                title={style === 'cover' ? t(labelKey) : `${t(labelKey)} — ${t('voice.annotations.maskStyleCosmetic')}`}
                aria-pressed={maskStyle === style}
                data-preflight-style={style}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] text-vox-text-muted">{t('voice.preflight.maskCount', { count: maskCount })}</span>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black" style={{ minHeight: 260 }}>
          <video ref={videoRef} autoPlay playsInline muted className="max-h-full max-w-full object-contain" />
          <AnnotationCanvas videoRef={videoRef} masksOnly />
          <AnnotationEditorLayer videoRef={videoRef} capabilities={PREFLIGHT_CAPABILITIES} />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-vox-border px-4 py-3">
          <label className="flex items-center gap-2 text-xs text-vox-text-muted">
            <input
              type="checkbox"
              checked={skip}
              onChange={(e) => persistSkip(e.target.checked)}
              data-testid="preflight-skip"
            />
            {t('voice.preflight.skipNextTime')}
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={cancelPendingShare}
              className="rounded border border-vox-border px-3 py-1.5 text-xs font-semibold text-vox-text-secondary hover:bg-vox-bg-hover"
              data-testid="preflight-cancel"
            >
              {t('voice.preflight.cancel')}
            </button>
            <button
              onClick={goLive}
              disabled={going}
              className="rounded bg-vox-accent-primary px-3 py-1.5 text-xs font-semibold text-vox-on-accent hover:brightness-110 disabled:opacity-60"
              data-testid="preflight-go-live"
            >
              {t('voice.preflight.goLive')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
