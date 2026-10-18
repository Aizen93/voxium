import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, TriangleAlert, X } from 'lucide-react';
import { toast } from '../../stores/toastStore';
import { copyToClipboard } from '../../utils/clipboard';
import { webhookCurlCommand } from '../../services/webhooks';
import { WebhookDialog } from './WebhookDialog';

interface Props {
  name: string;
  /** The execute URL WITH its token. Lives in the caller's state only while this panel is open. */
  url: string;
  /** A GitHub webhook's signing secret (step 3 of the plan), shown once with the URL. */
  secret?: string;
  /** Opened by a rotation (a new URL for an existing webhook) rather than a creation. */
  rotated?: boolean;
  onClose: () => void;
}

/**
 * The copy-once panel: the only time the URL (and a GitHub secret) is on
 * screen. Nothing here persists it; closing the panel drops it, and the way
 * back to a working URL is a rotation (and after a rotation the old URL is
 * already dead). So only a DELIBERATE act closes it: its X and Done buttons.
 * Neither a backdrop click nor Escape does, and focus opens on "Copy URL",
 * not on the X: the user arrives here by pressing Enter (create form, rotate
 * confirm), and the next reflex Enter/Space/Escape must not discard the only
 * copy of the token.
 */
export function WebhookCreatedPanel({ name, url, secret, rotated = false, onClose }: Props) {
  const { t } = useTranslation();
  const curl = webhookCurlCommand(url);
  const copyUrlRef = useRef<HTMLButtonElement>(null);

  const copy = async (text: string) => {
    try {
      await copyToClipboard(text);
      toast.success(t('webhooks.reveal.copied'));
    } catch (err) {
      console.warn('[Integrations] Clipboard write failed:', err instanceof Error ? err.message : err);
      toast.error(t('webhooks.reveal.copyFailed'));
    }
  };

  return (
    <WebhookDialog
      labelledBy="webhook-reveal-title"
      onClose={onClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      initialFocusRef={copyUrlRef}
      testId="webhook-reveal"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 id="webhook-reveal-title" className="min-w-0 truncate text-base font-bold text-vox-text-primary">
          {rotated ? t('webhooks.reveal.rotatedTitle', { name }) : t('webhooks.reveal.title', { name })}
        </h2>
        <button type="button" onClick={onClose} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>

      <p className="mb-4 flex items-start gap-2 rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/5 px-3 py-2 text-xs text-vox-accent-warning" data-testid="webhook-reveal-warning">
        <TriangleAlert size={14} className="mt-px shrink-0" />
        <span>{t('webhooks.reveal.copyNow')}</span>
      </p>

      <SecretBlock label={t('webhooks.reveal.url')} value={url} copyLabel={t('webhooks.reveal.copyUrl')} onCopy={copy} buttonRef={copyUrlRef} testId="webhook-reveal-url" />
      <p className="mt-1.5 text-xs text-vox-text-muted">{t('webhooks.reveal.worksWith')}</p>

      {secret && (
        <div className="mt-4">
          <SecretBlock label={t('webhooks.reveal.secret')} value={secret} copyLabel={t('webhooks.reveal.copySecret')} onCopy={copy} testId="webhook-reveal-secret" />
        </div>
      )}

      <div className="mt-4">
        <SecretBlock label={t('webhooks.reveal.curlHint')} value={curl} copyLabel={t('webhooks.reveal.copyCurl')} onCopy={copy} testId="webhook-reveal-curl" />
      </div>

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="btn-primary" data-testid="webhook-reveal-done">
          {t('webhooks.reveal.done')}
        </button>
      </div>
    </WebhookDialog>
  );
}

function SecretBlock({ label, value, copyLabel, onCopy, buttonRef, testId }: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: (text: string) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  testId: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">{label}</p>
      <div className="flex items-stretch gap-2">
        <code
          className="min-w-0 flex-1 select-all break-all rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 font-mono text-xs text-vox-text-primary"
          data-testid={testId}
        >
          {value}
        </code>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => onCopy(value)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-vox-border px-3 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
          aria-label={copyLabel}
          title={copyLabel}
          data-testid={`${testId}-copy`}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}
