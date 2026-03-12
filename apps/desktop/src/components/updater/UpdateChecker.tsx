import { useState, useEffect } from 'react';
import { Download, RotateCw, CheckCircle, AlertCircle } from 'lucide-react';

const TAURI_AVAILABLE = '__TAURI_INTERNALS__' in window;

type UpdatePhase =
  | { step: 'available'; version: string; doUpdate: () => void }
  | { step: 'downloading'; progress: number; total: number }
  | { step: 'ready' }
  | { step: 'error'; message: string; retry: () => void };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateChecker() {
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
            setPhase({
              step: 'error',
              message: e instanceof Error ? e.message : String(e),
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
        console.warn('[Updater] Check failed:', e);
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
            {phase.step === 'available' && 'Update Required'}
            {phase.step === 'downloading' && 'Downloading Update'}
            {phase.step === 'ready' && 'Update Ready'}
            {phase.step === 'error' && 'Update Failed'}
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
                    A new version of Voxium is required to continue.
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-vox-text-primary">
                    Version {phase.version}
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={phase.doUpdate}
                  className="rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  Update Now
                </button>
              </div>
            </>
          )}

          {phase.step === 'downloading' && (
            <>
              <p className="mb-3 text-sm text-vox-text-secondary">
                Downloading update...
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
                  ? `${formatBytes(phase.progress)} / ${formatBytes(phase.total)} — ${Math.round((phase.progress / phase.total) * 100)}%`
                  : `${formatBytes(phase.progress)} downloaded`}
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
                  Update installed. Restart Voxium to apply.
                </p>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleRestart}
                  className="flex items-center gap-2 rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  <RotateCw size={14} />
                  Restart Now
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
                  {phase.message || 'Something went wrong during the update.'}
                </p>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={phase.retry}
                  className="rounded bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-primary-hover"
                >
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
