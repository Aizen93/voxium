import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { WebhookDialog } from '../server/WebhookDialog';

export function ConfirmDialog({ id, title, body, confirmLabel, busy, danger = false, onConfirm, onClose, testId, children }: {
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <WebhookDialog labelledBy={id} onClose={onClose} busy={busy} testId={testId}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 id={id} className="text-base font-bold text-vox-text-primary">{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>
      <p className="text-sm text-vox-text-secondary">{body}</p>
      {children}
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className={danger ? 'btn-danger' : 'btn-primary'} data-testid={`${testId}-confirm`}>
          {confirmLabel}
        </button>
      </div>
    </WebhookDialog>
  );
}
