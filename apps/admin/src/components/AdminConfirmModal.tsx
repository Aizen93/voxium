import { useState } from 'react';
import { X } from 'lucide-react';

interface AdminConfirmModalProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  variant?: 'danger' | 'primary';
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function AdminConfirmModal({ title, message, confirmLabel = 'Confirm', danger = true, variant, onConfirm, onCancel }: AdminConfirmModalProps) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-vox-text-primary">{title}</h3>
          <button onClick={onCancel} className="text-vox-text-muted hover:text-vox-text-primary">
            <X size={20} />
          </button>
        </div>
        <div className="text-sm text-vox-text-secondary mb-6">{message}</div>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className={`px-4 py-2 text-sm rounded-md text-white transition-colors disabled:opacity-50 ${
              (variant === 'danger' || (variant === undefined && danger)) ? 'bg-vox-accent-danger hover:bg-red-600' : 'bg-vox-accent-primary hover:bg-vox-accent-hover'
            }`}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
