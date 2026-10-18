import { useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, TriangleAlert, X } from 'lucide-react';
import { toast } from '../../stores/toastStore';
import { copyToClipboard } from '../../utils/clipboard';
import { webhookCurlCommand } from '../../services/webhooks';
import { WebhookDialog } from './WebhookDialog';

interface Props {
  name: string;
  /** The execute URL WITH its token. Lives in the caller's state only while this panel is open. */
  url: string;
  /**
   * A GitHub webhook's signing secret, shown once with the URL. Only a GitHub
   * webhook's create/rotate answer carries one, so its presence is what turns
   * the panel into the GitHub variant (setup steps instead of a curl line).
   */
  secret?: string;
  /** Opened by a rotation (a new URL, and for GitHub a new secret, for an existing webhook) rather than a creation. */
  rotated?: boolean;
  onClose: () => void;
}

/**
 * The value GitHub's "Content type" select must be set to. Its default is
 * form-encoded, which is not what the GitHub formatter reads.
 */
const GITHUB_CONTENT_TYPE = 'application/json';

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

  let title: string;
  if (!rotated) title = t('webhooks.reveal.title', { name });
  else if (secret) title = t('webhooks.reveal.github.rotatedTitle', { name });
  else title = t('webhooks.reveal.rotatedTitle', { name });

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
          {title}
        </h2>
        <button type="button" onClick={onClose} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>

      <p className="mb-4 flex items-start gap-2 rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/5 px-3 py-2 text-xs text-vox-accent-warning" data-testid="webhook-reveal-warning">
        <TriangleAlert size={14} className="mt-px shrink-0" />
        <span>{secret ? t('webhooks.reveal.github.copyNow') : t('webhooks.reveal.copyNow')}</span>
      </p>

      <SecretBlock label={t('webhooks.reveal.url')} value={url} copyLabel={t('webhooks.reveal.copyUrl')} onCopy={copy} buttonRef={copyUrlRef} testId="webhook-reveal-url" />
      <p className="mt-1.5 text-xs text-vox-text-muted">{secret ? t('webhooks.reveal.github.urlHint') : t('webhooks.reveal.worksWith')}</p>

      {secret ? (
        <>
          <div className="mt-4">
            <SecretBlock label={t('webhooks.reveal.secret')} value={secret} copyLabel={t('webhooks.reveal.copySecret')} onCopy={copy} testId="webhook-reveal-secret" />
          </div>
          <GitHubSetup url={url} secret={secret} rotated={rotated} />
        </>
      ) : (
        // A curl line only makes sense for a generic webhook: a GitHub one
        // refuses every delivery that is not signed with its secret
        <div className="mt-4">
          <SecretBlock label={t('webhooks.reveal.curlHint')} value={webhookCurlCommand(url)} copyLabel={t('webhooks.reveal.copyCurl')} onCopy={copy} testId="webhook-reveal-curl" />
        </div>
      )}

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

const SETUP_VALUE = 'select-all break-all font-mono text-vox-text-primary';

/**
 * What to enter in GitHub's "Add webhook" form (or, after a rotation, what to
 * replace in it), field by field. The URL and the secret are repeated as
 * plain values for reference only: their copy buttons are the blocks above.
 * GitHub's own field labels come from the locale files (as GitHub shows
 * them), never from this file.
 */
function GitHubSetup({ url, secret, rotated }: { url: string; secret: string; rotated: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="mt-4 rounded-lg border border-vox-border p-3" aria-labelledby="webhook-github-setup-title" data-testid="github-setup">
      <h3 id="webhook-github-setup-title" className="text-sm font-semibold text-vox-text-primary">
        {rotated ? t('webhooks.reveal.github.updateTitle') : t('webhooks.reveal.github.title')}
      </h3>
      <p className="mt-1 text-xs text-vox-text-muted">
        {rotated ? t('webhooks.reveal.github.rotatedIntro') : t('webhooks.reveal.github.intro')}
      </p>
      <ol className="mt-3 list-decimal space-y-2.5 pl-5 text-xs marker:text-vox-text-muted">
        <SetupStep label={t('webhooks.reveal.github.payloadUrl')} testId="github-setup-url">
          <code className={SETUP_VALUE}>{url}</code>
        </SetupStep>
        <SetupStep label={t('webhooks.reveal.github.contentType')} testId="github-setup-content-type">
          <code className={SETUP_VALUE}>{GITHUB_CONTENT_TYPE}</code>
        </SetupStep>
        <SetupStep label={t('webhooks.reveal.github.secret')} testId="github-setup-secret">
          <code className={SETUP_VALUE}>{secret}</code>
        </SetupStep>
        <SetupStep label={t('webhooks.reveal.github.ssl')} testId="github-setup-ssl">
          {t('webhooks.reveal.github.sslValue')}
        </SetupStep>
        <SetupStep label={t('webhooks.reveal.github.events')} testId="github-setup-events">
          <p>{t('webhooks.reveal.github.eventsValue')}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-vox-text-muted">{t('webhooks.reveal.github.eventsTick')}</span>
            <ul className="flex flex-wrap gap-1.5">
              <EventChip label={t('webhooks.reveal.github.eventPushes')} />
              <EventChip label={t('webhooks.reveal.github.eventPullRequests')} />
              <EventChip label={t('webhooks.reveal.github.eventIssues')} />
              <EventChip label={t('webhooks.reveal.github.eventReleases')} />
            </ul>
          </div>
        </SetupStep>
      </ol>
      <p className="mt-3 text-xs text-vox-text-secondary" data-testid="github-setup-check">
        {rotated ? t('webhooks.reveal.github.rotatedCheck') : t('webhooks.reveal.github.ping')}
      </p>
      <p className="mt-1.5 text-xs text-vox-text-secondary" data-testid="github-setup-secret-required">
        {t('webhooks.reveal.github.secretRequired')}
      </p>
    </section>
  );
}

function SetupStep({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <li data-testid={testId}>
      <p className="font-semibold text-vox-text-secondary">{label}</p>
      <div className="mt-0.5 text-vox-text-primary">{children}</div>
    </li>
  );
}

function EventChip({ label }: { label: string }) {
  return (
    <li className="inline-flex items-center gap-1 rounded border border-vox-border px-1.5 py-0.5 text-vox-text-primary">
      <Check size={12} className="shrink-0 text-vox-accent-success" aria-hidden="true" />
      {label}
    </li>
  );
}
