import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RotateCw, CheckCircle, AlertCircle } from 'lucide-react';

const TAURI_AVAILABLE = '__TAURI_INTERNALS__' in window;

// What the updater plugin answers check() with when the build has no feed (a
// self-hosted build without TAURI_UPDATER_ENDPOINTS: scripts/tauriSelfHosted.mjs).
// It asks no server and there is nothing to update to: no dialog, an info line.
const NO_FEED_ERROR = 'does not have any endpoints set';

/** What a thrown value says: an Error's message, a string as it is (the plugin rejects with the text) */
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hasNoUpdateFeed(e: unknown): boolean {
  return describeError(e).includes(NO_FEED_ERROR);
}

type FailureKey = 'updater.failed' | 'updater.failedNetwork';

/**
 * The sentence a person reads for a failed download or install. The plugin's
 * text is Rust's own wording (English, with paths and addresses in it), so it
 * only picks between a connection sentence, for transport failures named by
 * narrow markers, and the generic one (a wrong specific claim is worse than a
 * general one), and goes to the log.
 */
const NETWORK_MARKERS = /error sending request|operation timed out|request timed out|dns error|connection refused|connection reset|connection closed/;

export function updateFailureKey(e: unknown): FailureKey {
  const text = describeError(e).toLowerCase();
  if (NETWORK_MARKERS.test(text)) return 'updater.failedNetwork';
  return 'updater.failed';
}

type UpdatePhase =
  | { step: 'available'; version: string; doUpdate: () => void }
  | { step: 'downloading'; progress: number; total: number }
  | { step: 'ready' }
  | { step: 'error'; messageKey: FailureKey; retry: () => void };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateChecker() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase | null>(null);

  useEffect(() => {
    if (!TAURI_AVAILABLE) return;

    let cancelled = false;

    (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (cancelled || !update) return;

        const startUpdate = async () => {
          try {
            let downloaded = 0;
            setPhase({ step: 'downloading', progress: 0, total: 0 });

            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case 'Started':
                  setPhase({
                    step: 'downloading',
                    progress: 0,
                    total: event.data.contentLength ?? 0,
                  });
                  break;
                case 'Progress':
                  downloaded += event.data.chunkLength;
                  setPhase((prev) =>
                    prev?.step === 'downloading'
                      ? { ...prev, progress: downloaded }
                      : prev
                  );
                  break;
                case 'Finished':
                  break;
              }
            });

            setPhase({ step: 'ready' });
          } catch (e) {
            console.warn('[Updater] Update failed:', describeError(e));
            setPhase({
              step: 'error',
              messageKey: updateFailureKey(e),
              retry: startUpdate,
            });
          }
        };

        setPhase({
          step: 'available',
          version: update.version,
          doUpdate: startUpdate,
        });
      } catch (e) {
        if (hasNoUpdateFeed(e)) {
          console.info('[Updater] This build has no update feed: no update check');
          return;
        }
        console.warn('[Updater] Check failed:', describeError(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleRestart = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      console.error('[Updater] Relaunch failed:', e);
    }
  };

  if (!phase) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
      <div className="w-[400px] rounded-lg bg-vox-bg-secondary shadow-2xl">
        {/* Header */}
        <div className="border-b border-vox-border px-5 py-4">
          <h2 className="text-lg font-semibold text-vox-text-primary">
            {phase.step === 'available' && t('updater.titleAvailable')}
            {phase.step === 'downloading' && t('updater.titleDownloading')}
            {phase.step === 'ready' && t('updater.titleReady')}
            {phase.step === 'error' && t('updater.titleFailed')}
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {phase.step === 'available' && (
            <>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-vox-accent-primary/20">
                  <Download size={20} className="text-vox-accent-primary" />
                </div>
                <div>
                  <p className="text-sm text-vox-text-secondary">
                    {t('updater.required')}
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-vox-text-primary">
                    {t('updater.version', { version: phase.version })}
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={phase.doUpdate}
                  className="rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  {t('updater.updateNow')}
                </button>
              </div>
            </>
          )}

          {phase.step === 'downloading' && (
            <>
              <p className="mb-3 text-sm text-vox-text-secondary">
                {t('updater.downloading')}
              </p>
              <div className="mb-2 h-2 overflow-hidden rounded-full bg-vox-bg-tertiary">
                {phase.total > 0 ? (
                  <div
                    className="h-full rounded-full bg-vox-accent-primary transition-all duration-200"
                    style={{
                      width: `${Math.min((phase.progress / phase.total) * 100, 100)}%`,
                    }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-vox-accent-primary" />
                )}
              </div>
              <p className="text-xs text-vox-text-muted">
                {phase.total > 0
                  ? t('updater.progress', { done: formatBytes(phase.progress), total: formatBytes(phase.total), percent: Math.round((phase.progress / phase.total) * 100) })
                  : t('updater.downloaded', { size: formatBytes(phase.progress) })}
              </p>
            </>
          )}

          {phase.step === 'ready' && (
            <>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/20">
                  <CheckCircle size={20} className="text-green-400" />
                </div>
                <p className="text-sm text-vox-text-secondary">
                  {t('updater.installed')}
                </p>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleRestart}
                  className="flex items-center gap-2 rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  <RotateCw size={14} />
                  {t('updater.restartNow')}
                </button>
              </div>
            </>
          )}

          {phase.step === 'error' && (
            <>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/20">
                  <AlertCircle size={20} className="text-red-400" />
                </div>
                <p className="text-sm text-vox-text-secondary">
                  {t(phase.messageKey)}
                </p>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={phase.retry}
                  className="rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  {t('updater.retry')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
