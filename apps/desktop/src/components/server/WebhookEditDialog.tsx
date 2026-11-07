import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { validateWebhookName } from '@voxium/shared';
import type { Webhook, WebhookTarget } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { translateServerError } from '../../utils/serverErrors';
import type { UpdateWebhookInput } from '../../services/webhooks';
import { WebhookDialog } from './WebhookDialog';
import { WebhookNameField } from './WebhookNameField';

/** What the dialog may change. Never `enabled`: that is the row's own toggle, with its admin lock. */
export type WebhookEditPatch = Pick<UpdateWebhookInput, 'name' | 'channelId'>;

interface Props {
  /** The webhook as the tab's list has it NOW: it follows the list while the dialog is open. */
  webhook: Webhook;
  /**
   * The channels this caller may move it to (GET …/webhooks/targets; the
   * visible plaintext text channels when that fails); `null` while it loads.
   */
  channels: ReadonlyArray<Pick<WebhookTarget, 'id' | 'name'>> | null;
  busy: boolean;
  /** The server's refusal of the last save, translated. Shown inline: the dialog stays open on it. */
  error: string | null;
  /** A field changed: a refusal of the previous values must not linger next to new ones. */
  onDismissError: () => void;
  /** Only the fields that changed. The caller sends the PATCH and closes the dialog on success. */
  onSave: (patch: WebhookEditPatch) => void;
  onClose: () => void;
}

/** What the user typed, and the live name at that keystroke. */
interface NameDraft {
  value: string;
  base: string;
}

/**
 * "Edit webhook": rename it, or move it to another channel. The URL is not
 * touched (no rotation), and a move takes nothing with it: what it already
 * posted stays where it was posted. Only what changed is sent, so a rename
 * never re-asks the channel check and a move never rewrites the name. The
 * name runs through the shared validator before the request, as on create.
 */
export function WebhookEditDialog({ webhook, channels, busy, error, onDismissError, onSave, onClose }: Props) {
  const { t } = useTranslation();
  // The raw store value (a default inside the selector would allocate per read)
  const allChannels = useServerStore((s) => s.channels);
  // `null` = untouched: the field shows the webhook as the list has it now, so
  // a fellow moderator's rename or move while this is open is never sent back
  // as this user's change. A draft typed back to the live value is dropped
  // (untouched again), or it would pin that value once the row moves on.
  const [nameDraft, setNameDraft] = useState<NameDraft | null>(null);
  const [channelDraft, setChannelDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // Focused by the dialog shell AFTER it records the opener (an `autoFocus`
  // would beat it to it, and Cancel/Escape would then drop focus to <body>)
  const nameRef = useRef<HTMLInputElement>(null);

  // Spaces around the name it was typed over change nothing: such a draft is
  // judged against its base, and once the row's name moves on, the field
  // shows the row again instead of the old name with a space
  const draftChanges = nameDraft !== null && nameDraft.value.trim() !== nameDraft.base;
  const draftShown = nameDraft !== null && (draftChanges || nameDraft.base === webhook.name);
  const name = draftShown && nameDraft !== null ? nameDraft.value : webhook.name;
  const trimmed = name.trim();
  const nameChanged = draftChanges && trimmed !== webhook.name;

  const list = channels ?? [];
  const currentId = webhook.channelId;
  // The current channel is always on offer: keeping it is not a move, and a
  // rename asks nothing of the channel. It may be missing from the list (this
  // caller may no longer bind it, or the list is still loading); it is then
  // offered on its own, dimmed, under its name from the store.
  const currentListed = list.some((c) => c.id === currentId);
  const currentName = list.find((c) => c.id === currentId)?.name
    ?? allChannels.find((c) => c.id === currentId && c.serverId === webhook.serverId)?.name
    ?? null;
  const currentLabel = t('webhooks.edit.current', { channel: currentName !== null ? `#${currentName}` : t('webhooks.channelMissing') });
  // A picked channel that left the list (deleted, then refetched) falls back
  // to staying put, never to some other channel, and the dialog says so: a
  // rename alone would otherwise save as if the move were still part of it
  const selected = channelDraft !== null && list.some((c) => c.id === channelDraft) ? channelDraft : currentId;
  const pickGone = channels !== null && channelDraft !== null && selected !== channelDraft;
  const channelChanged = selected !== currentId;
  const changed = nameChanged || channelChanged;

  // A refusal lands with focus wherever the request left it; when that is
  // outside the form (Save was disabled under it), back to the name field
  useEffect(() => {
    const input = nameRef.current;
    if (busy || !error || !input) return;
    if (!input.form?.contains(document.activeElement)) input.focus();
  }, [busy, error]);

  const edited = () => { if (error) onDismissError(); };

  const onNameChange = (value: string) => {
    // The RAW value: a typed space is kept as typed, never swallowed. The base
    // is the live name at THIS keystroke: whatever the user types after a
    // fellow moderator's rename is judged against that rename
    setNameDraft(value === webhook.name ? null : { value, base: webhook.name });
    if (nameError) setNameError(null);
    edited();
  };

  const onChannelChange = (value: string) => {
    // The select stays focusable while a save is in flight (a disabled one
    // would drop focus to <body>); a change then is ignored, and the
    // controlled value snaps back
    if (busy) return;
    setChannelDraft(value === currentId ? null : value);
    edited();
  };

  const submit = () => {
    if (busy || !changed) return;
    // An unchanged name is not sent, so it is not judged either: a move must
    // not be blocked by a name an older rule accepted
    if (nameChanged) {
      const invalid = validateWebhookName(name);
      if (invalid) { setNameError(translateServerError(invalid, t)); return; }
    }
    setNameError(null);
    onSave({
      ...(nameChanged ? { name: trimmed } : {}),
      ...(channelChanged ? { channelId: selected } : {}),
    });
  };

  return (
    <WebhookDialog labelledBy="webhook-edit-title" onClose={onClose} busy={busy} initialFocusRef={nameRef} testId="webhook-edit-dialog">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="webhook-edit-title" className="text-base font-bold text-vox-text-primary">{t('webhooks.edit.title')}</h2>
            <p className="text-xs text-vox-text-muted">{t('webhooks.edit.description')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <WebhookNameField
          id="webhook-edit-name"
          label={t('webhooks.edit.name')}
          value={name}
          onChange={onNameChange}
          error={nameError}
          inputRef={nameRef}
          readOnly={busy}
        />

        <label htmlFor="webhook-edit-channel" className="mb-1.5 mt-3 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
          {t('webhooks.edit.channel')}
        </label>
        <select
          id="webhook-edit-channel"
          value={selected}
          onChange={(e) => onChannelChange(e.target.value)}
          aria-disabled={busy ? true : undefined}
          aria-describedby="webhook-edit-move-note"
          className="w-full rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary focus:border-vox-accent-primary focus:outline-none aria-disabled:opacity-60"
          data-testid="webhook-edit-channel"
        >
          {!currentListed && (
            <option value={currentId} className="text-vox-text-muted" data-current="true">{currentLabel}</option>
          )}
          {list.map((c) => (
            <option key={c.id} value={c.id} data-current={c.id === currentId ? 'true' : undefined}>
              {c.id === currentId ? currentLabel : `#${c.name}`}
            </option>
          ))}
        </select>
        {channels === null && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-vox-text-muted" role="status" data-testid="webhook-edit-channels-loading">
            <Loader2 size={12} className="animate-spin" />
            {t('webhooks.edit.loadingChannels')}
          </p>
        )}
        {pickGone && (
          <p className="mt-1 text-[11px] text-vox-accent-warning" role="status" data-testid="webhook-edit-pick-gone">
            {t('webhooks.edit.pickGone')}
          </p>
        )}
        <p id="webhook-edit-move-note" className="mt-1 text-[11px] text-vox-text-muted" data-testid="webhook-edit-move-note">
          {t('webhooks.edit.moveNote')}
        </p>

        {error && (
          <p
            className="mt-4 rounded-md border border-vox-accent-danger/30 bg-vox-accent-danger/10 px-3 py-2 text-xs text-vox-accent-danger"
            role="alert"
            data-testid="webhook-edit-error"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={busy || !changed} className="btn-primary disabled:opacity-50" data-testid="webhook-edit-save">
            {busy ? t('webhooks.edit.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </WebhookDialog>
  );
}
