import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { LIMITS, WEBHOOK_TYPES, validateWebhookName } from '@voxium/shared';
import type { WebhookTarget, WebhookType } from '@voxium/shared';
import { translateServerError } from '../../utils/serverErrors';
import type { CreateWebhookInput } from '../../services/webhooks';
import { WebhookDialog } from './WebhookDialog';

interface Props {
  /**
   * The channels this caller may bind a webhook to (GET …/webhooks/targets;
   * the visible plaintext text channels when that fails); `null` while it loads.
   */
  channels: ReadonlyArray<Pick<WebhookTarget, 'id' | 'name'>> | null;
  busy: boolean;
  /** The caller sends the request, toasts a refusal and closes the dialog on success. */
  onCreate: (input: CreateWebhookInput) => void;
  onClose: () => void;
}

/**
 * "New webhook": a name (the author label its messages carry), the channel
 * it posts to and its type. The name runs through the shared validator before
 * the request. A GitHub webhook's answer also carries its signing secret,
 * which the copy-once panel shows once with the GitHub setup steps; a server
 * without the key GitHub secrets are encrypted with refuses one (503), and
 * that refusal comes back translated.
 */
export function WebhookCreateDialog({ channels, busy, onCreate, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [type, setType] = useState<WebhookType>('generic');
  const [error, setError] = useState<string | null>(null);
  // Focused by the dialog shell AFTER it records the opener (an `autoFocus`
  // would beat it to it, and Cancel/Escape would then drop focus to <body>)
  const nameRef = useRef<HTMLInputElement>(null);

  // The list arrives after the dialog opens, and the picked channel can leave
  // it while it is open (deleted, then refetched): fall back to the first one
  // left instead of posting a dead id. Nothing is selectable while it loads.
  const list = channels ?? [];
  const selected = list.some((c) => c.id === channelId) ? channelId : (list[0]?.id ?? '');

  const submit = () => {
    if (busy) return;
    const invalid = validateWebhookName(name);
    if (invalid) { setError(translateServerError(invalid, t)); return; }
    if (!selected) return;
    setError(null);
    onCreate({ channelId: selected, name: name.trim(), type });
  };

  const typeLabel = (kind: WebhookType) => (kind === 'github' ? t('webhooks.typeGithub') : t('webhooks.typeGeneric'));
  const typeHint = (kind: WebhookType) => (kind === 'github' ? t('webhooks.create.typeGithubHint') : t('webhooks.create.typeGenericHint'));

  return (
    <WebhookDialog labelledBy="webhook-create-title" onClose={onClose} busy={busy} initialFocusRef={nameRef} testId="webhook-create-dialog">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="webhook-create-title" className="text-base font-bold text-vox-text-primary">{t('webhooks.create.title')}</h2>
            <p className="text-xs text-vox-text-muted">{t('webhooks.create.description')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <label htmlFor="webhook-name" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
          {t('webhooks.create.name')}
        </label>
        <input
          ref={nameRef}
          id="webhook-name"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
          maxLength={LIMITS.WEBHOOK_NAME_MAX}
          placeholder={t('webhooks.create.namePlaceholder')}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'webhook-name-error' : undefined}
          className="w-full rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none"
          data-testid="webhook-create-name"
        />
        <div className="mt-1 flex items-start justify-between gap-2 text-[11px]">
          <span id="webhook-name-error" className="text-vox-accent-danger" role={error ? 'alert' : undefined} data-testid="webhook-name-error">{error}</span>
          <span className="shrink-0 text-vox-text-muted">{name.length}/{LIMITS.WEBHOOK_NAME_MAX}</span>
        </div>

        <label htmlFor="webhook-channel" className="mb-1.5 mt-3 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
          {t('webhooks.create.channel')}
        </label>
        {channels === null ? (
          <p className="flex items-center gap-1.5 text-xs text-vox-text-muted" role="status" data-testid="webhook-channels-loading">
            <Loader2 size={12} className="animate-spin" />
            {t('webhooks.create.loadingChannels')}
          </p>
        ) : channels.length > 0 ? (
          <select
            id="webhook-channel"
            value={selected}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
            data-testid="webhook-create-channel"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-vox-text-muted" data-testid="webhook-no-channels">{t('webhooks.create.noChannels')}</p>
        )}

        <fieldset className="mt-4">
          <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">{t('webhooks.create.type')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_TYPES.map((kind) => (
              <label
                key={kind}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                  type === kind ? 'border-vox-accent-primary bg-vox-accent-primary/5' : 'border-vox-border hover:bg-vox-bg-hover'
                }`}
              >
                <input
                  type="radio"
                  name="webhook-type"
                  value={kind}
                  checked={type === kind}
                  onChange={() => setType(kind)}
                  className="mt-0.5"
                  data-testid={`webhook-type-${kind}`}
                />
                <span>
                  <span className="block font-medium text-vox-text-primary">{typeLabel(kind)}</span>
                  <span className="block text-vox-text-muted">{typeHint(kind)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={busy || !selected} className="btn-primary disabled:opacity-50" data-testid="webhook-create-submit">
            {busy ? t('webhooks.create.creating') : t('webhooks.create.submit')}
          </button>
        </div>
      </form>
    </WebhookDialog>
  );
}
