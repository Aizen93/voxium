import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ToggleLeft, ToggleRight, RotateCcw, HelpCircle, Zap } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { toast } from '../stores/toastStore';

function Tip({ text }: { text: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleEnter = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    setShow(true);
  }, []);

  return (
    <span ref={iconRef} className="inline-flex ml-1 cursor-help" onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      <HelpCircle size={12} className="text-vox-text-muted" />
      {show && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
          className="w-52 px-2 py-1.5 text-[10px] leading-tight text-vox-text-primary bg-vox-bg-primary border border-vox-border rounded shadow-lg z-[9999] normal-case font-normal tracking-normal whitespace-normal"
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

export function AdminFeatureFlags() {
  const { featureFlags, fetchFeatureFlags, updateFeatureFlag, resetFeatureFlag } = useAdminStore();
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    fetchFeatureFlags();
  }, [fetchFeatureFlags]);

  const handleToggle = async (name: string, currentlyEnabled: boolean) => {
    setToggling(name);
    try {
      await updateFeatureFlag(name, !currentlyEnabled);
      toast.success(`Feature "${name}" ${!currentlyEnabled ? 'enabled' : 'disabled'}`);
    } catch {
      toast.error('Failed to update feature flag');
    } finally {
      setToggling(null);
    }
  };

  const handleReset = async (name: string) => {
    try {
      await resetFeatureFlag(name);
      toast.success(`Feature "${name}" reset to default`);
    } catch {
      toast.error('Failed to reset feature flag');
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-vox-text-primary flex items-center gap-2">
        <Zap size={20} /> Feature Flags
      </h2>

      <p className="text-xs text-vox-text-muted">
        Toggle features on or off without redeploying. Changes take effect immediately for all users.
      </p>

      <div className="grid gap-3">
        {featureFlags.map((flag) => (
          <div
            key={flag.name}
            className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4 flex items-center justify-between gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-vox-text-primary">{flag.label}</span>
                {flag.isCustom && (
                  <span className="rounded bg-vox-accent-warning/20 px-1 py-0.5 text-[9px] font-bold text-vox-accent-warning uppercase">Custom</span>
                )}
                <Tip text={flag.description} />
              </div>
              <span className="text-[10px] text-vox-text-muted">{flag.name}</span>
            </div>

            <div className="flex items-center gap-2">
              {flag.isCustom && (
                <button
                  onClick={() => handleReset(flag.name)}
                  className="p-1 rounded text-vox-text-muted hover:text-vox-accent-warning hover:bg-vox-accent-warning/10 transition-colors"
                  title="Reset to default"
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                onClick={() => handleToggle(flag.name, flag.enabled)}
                disabled={toggling === flag.name}
                className="transition-colors disabled:opacity-50"
                title={flag.enabled ? 'Click to disable' : 'Click to enable'}
              >
                {flag.enabled ? (
                  <ToggleRight size={32} className="text-green-400" />
                ) : (
                  <ToggleLeft size={32} className="text-vox-text-muted" />
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {featureFlags.length === 0 && (
        <div className="text-center py-8 text-sm text-vox-text-muted">Loading feature flags...</div>
      )}
    </div>
  );
}
