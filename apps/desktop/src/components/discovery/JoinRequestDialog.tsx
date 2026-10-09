import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, UserPlus } from 'lucide-react';
import { LIMITS, validateJoinRequestMessage } from '@voxium/shared';
import type { DiscoveryServer } from '@voxium/shared';
import { translateServerError } from '../../utils/serverErrors';
import { ServerIcon } from '../server/ServerIcon';

interface Props {
  server: DiscoveryServer;
  busy?: boolean;
  /** Resolves when the request was sent; rejects with the server's error (the caller toasts). */
  onSend: (message: string | undefined) => Promise<void>;
  onClose: () => void;
}

/**
 * "Request to join": an optional message to the moderators (≤ 300 chars),
 * validated locally with the shared validator before the request. The
 * moderators see the requester's public profile and this text — the dialog
 * says so.
 */
export function JoinRequestDialog({ server, busy = false, onSend, onClose }: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const trimmed = message.trim();
    const invalid = trimmed ? validateJoinRequestMessage(trimmed) : null;
    if (invalid) { setError(translateServerError(invalid, t)); return; }
    setError(null);
    try {
      await onSend(trimmed || undefined);
    } catch {
      // toasted by the caller; the dialog stays open with the draft
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="join-request-title"
      data-testid="join-request-dialog"
    >
      <div className="w-full max-w-md rounded-2xl border border-vox-border bg-vox-bg-secondary p-5 shadow-2xl animate-slide-up">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ServerIcon id={server.id} name={server.name} iconUrl={server.iconUrl} size={36} rounded="rounded-lg" className="shrink-0" />
            <div className="min-w-0">
              <h2 id="join-request-title" className="truncate text-base font-bold text-vox-text-primary">
                {t('discovery.request.title', { name: server.name })}
              </h2>
              <p className="text-xs text-vox-text-muted">{t('discovery.request.description')}</p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <label htmlFor="join-request-message" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
          {t('discovery.request.messageLabel')}
        </label>
        <textarea
          id="join-request-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); if (error) setError(null); }}
          maxLength={LIMITS.JOIN_REQUEST_MESSAGE_MAX}
          rows={4}
          placeholder={t('discovery.request.placeholder')}
          disabled={busy}
          autoFocus
          className="w-full resize-none rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none disabled:opacity-60"
          data-testid="join-request-message"
        />
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-vox-accent-danger" data-testid="join-request-error">{error ?? ''}</span>
          <span className="text-vox-text-muted">{message.length}/{LIMITS.JOIN_REQUEST_MESSAGE_MAX}</span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm text-vox-text-secondary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="btn-primary inline-flex items-center gap-1.5 px-4 py-1.5 text-sm disabled:opacity-50"
            data-testid="join-request-send"
          >
            <UserPlus size={14} />
            {busy ? t('common.sending') : t('discovery.request.send')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
