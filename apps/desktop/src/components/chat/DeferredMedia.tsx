import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Music, Loader2, Play, AlertCircle } from 'lucide-react';
import { getCachedMedia, rememberMedia } from '../../services/mediaBlobCache';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A log line never carries the error object, an address or the key (an
 *  attachment key embeds the file name the person chose). */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

interface Props {
  /** Produces the file; runs only when the person asks to play it. */
  load: () => Promise<Blob>;
  kind: 'video' | 'audio';
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** Plaintext files are kept for a remount under this key; omit to keep nothing. */
  cacheKey?: string;
  /** Shown instead of the player when the browser cannot decode the file. */
  fallback: ReactNode;
}

/**
 * A video or audio attachment that downloads nothing until the person asks to
 * play it. One button stays mounted through idle, loading and failed (focus
 * stays on it); the player takes focus when it appears after that request. The
 * placeholder has a fixed size (a 16:9 box up to 400 px wide for video, the
 * audio card's own compact shape for audio) and is shown until the object URL
 * exists, so the row never collapses.
 */
export function DeferredMedia({ load, kind, fileName, fileSize, mimeType, cacheKey, fallback }: Props) {
  const { t } = useTranslation();
  const isVideo = kind === 'video';
  const [blob, setBlob] = useState<Blob | null>(() => (cacheKey ? getCachedMedia(cacheKey) : null));
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [autoPlay, setAutoPlay] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const startedByPerson = useRef(false);
  const playerRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One blob URL per mounted player, revoked when the blob changes or it unmounts.
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setMediaUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setMediaUrl(null);
    };
  }, [blob]);

  // The player takes focus only for a load the person started
  useEffect(() => {
    if (mediaUrl && startedByPerson.current) {
      startedByPerson.current = false;
      playerRef.current?.focus();
    }
  }, [mediaUrl]);

  const start = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    startedByPerson.current = true;
    setStatus('loading');
    load()
      .then((loaded) => {
        if (cacheKey) rememberMedia(cacheKey, loaded);
        if (!alive.current) return;
        setAutoPlay(true);
        setBlob(loaded);
        setStatus('idle');
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        startedByPerson.current = false;
        console.warn('[Attachment] Failed to load media:', describeError(err));
        setStatus('failed');
      })
      .finally(() => {
        inFlight.current = false;
      });
  };

  if (decodeFailed) return <>{fallback}</>;

  if (blob && mediaUrl) {
    if (isVideo) {
      return (
        <div className="mt-1">
          <video
            ref={playerRef}
            tabIndex={0}
            src={mediaUrl}
            controls
            autoPlay={autoPlay}
            className="max-h-[300px] max-w-[400px] rounded-lg"
            preload="metadata"
            onError={() => setDecodeFailed(true)}
          />
          <p className="mt-0.5 text-[10px] text-vox-text-muted">{fileName} - {formatFileSize(fileSize)}</p>
        </div>
      );
    }
    return (
      <div className="mt-1">
        <div className="flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2">
          <Music size={16} className="shrink-0 text-vox-text-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-vox-text-primary">{fileName}</p>
            <audio
              ref={playerRef}
              tabIndex={0}
              src={mediaUrl}
              controls
              autoPlay={autoPlay}
              className="mt-1 h-8 w-full"
              preload="metadata"
              onError={() => setDecodeFailed(true)}
            />
          </div>
          <span className="shrink-0 text-[10px] text-vox-text-muted">{formatFileSize(fileSize)}</span>
        </div>
      </div>
    );
  }

  // Loading, failed, idle, or the blob is held and its URL is not made yet
  const loading = status === 'loading' || (blob !== null && !mediaUrl);
  const failed = status === 'failed';
  const Icon = isVideo ? Film : Music;
  const boxClass = isVideo
    ? 'aspect-video w-[400px] max-w-full justify-center'
    : 'w-full max-w-[400px]';
  const shell = `flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-xs ${boxClass}`;
  const details = [formatFileSize(fileSize), mimeType].filter(Boolean).join(' - ');
  const loadingText = isVideo ? t('attachment.loadingVideo') : t('attachment.loadingAudio');

  let label = t('attachment.play', { name: fileName });
  if (loading) label = loadingText;
  else if (failed) label = t('attachment.loadFailedRetry', { name: fileName });

  return (
    <div className="mt-1">
      {/* The same button in every state, so focus stays on it. aria-disabled
          (not disabled) keeps it focusable while a load runs. */}
      <button
        type="button"
        onClick={loading ? undefined : start}
        aria-label={label}
        aria-disabled={loading}
        aria-busy={loading}
        className={`${shell} transition-colors ${loading ? 'cursor-progress text-vox-text-muted' : 'hover:bg-vox-bg-hover'}`}
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin shrink-0" />
        ) : failed ? (
          <AlertCircle size={20} className="shrink-0 text-vox-text-muted" />
        ) : (
          <Icon size={20} className="shrink-0 text-vox-accent-primary" />
        )}
        <div className="min-w-0 text-left">
          <p className="truncate text-xs font-medium text-vox-accent-primary">{fileName}</p>
          <p className="text-[10px] text-vox-text-muted">
            {loading ? loadingText : failed ? t('attachment.loadFailed') : details}
          </p>
        </div>
        {!loading && (failed ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-vox-accent-primary">{t('attachment.retry')}</span>
        ) : (
          <Play size={14} className="ml-auto shrink-0 text-vox-text-muted" />
        ))}
      </button>
      {/* A polite live region mounted before its text arrives, so the failure
          is announced once (an element inserted with role="alert" already
          filled is announced less reliably across screen readers). */}
      <span role="status" className="sr-only">{failed ? t('attachment.loadFailed') : ''}</span>
    </div>
  );
}
