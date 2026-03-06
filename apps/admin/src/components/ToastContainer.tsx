import { useToastStore } from '../stores/toastStore';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colorMap = {
  success: 'bg-vox-accent-success text-vox-accent-success',
  error: 'bg-vox-accent-danger text-vox-accent-danger',
  warning: 'bg-vox-accent-warning text-vox-accent-warning',
  info: 'bg-vox-accent-info text-vox-accent-info',
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 w-80" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = iconMap[t.type];
        const colors = colorMap[t.type];
        const [barColor, textColor] = colors.split(' ');

        return (
          <div
            key={t.id}
            className="flex overflow-hidden rounded-lg border border-vox-border bg-vox-bg-floating shadow-lg animate-slide-in-right"
          >
            {/* Color accent bar */}
            <div className={`w-1 shrink-0 ${barColor}`} />

            <div className="flex flex-1 items-start gap-2.5 px-3 py-2.5">
              <Icon size={16} className={`shrink-0 mt-0.5 ${textColor}`} />
              <p className="flex-1 text-sm text-vox-text-primary">{t.message}</p>
              <button
                onClick={() => removeToast(t.id)}
                className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
