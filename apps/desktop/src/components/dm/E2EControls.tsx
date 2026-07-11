import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Lock, ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useDMStore } from '../../stores/dmStore';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { getE2EService } from '../../services/e2e/e2eService';
import type { Conversation } from '@voxium/shared';

interface Props {
  conversation: Conversation;
}

/**
 * Header control for DM encryption: an enable button for plaintext
 * conversations, a lock badge (→ safety-number modal) for encrypted ones.
 */
export function E2EControls({ conversation }: Props) {
  const { t } = useTranslation();
  const e2eReady = useE2EStore((s) => s.ready);
  const identityWarning = useE2EStore((s) => !!s.identityWarnings[conversation.participant.id]);
  const [modal, setModal] = useState<'enable' | 'safety' | null>(null);

  if (!e2eReady) return null;

  const encrypted = !!conversation.encryptedAt;

  return (
    <>
      <button
        onClick={() => setModal(encrypted ? 'safety' : 'enable')}
        className={clsx(
          'rounded-md p-1.5 transition-colors',
          identityWarning
            ? 'text-vox-accent-warning hover:bg-vox-accent-warning/10'
            : encrypted
              ? 'text-vox-accent-success hover:bg-vox-accent-success/10'
              : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
        )}
        title={encrypted ? t('e2e.badgeTitle') : t('e2e.enableTitle')}
        aria-label={encrypted ? t('e2e.badgeTitle') : t('e2e.enableTitle')}
      >
        {identityWarning ? <ShieldAlert size={18} /> : <Lock size={18} />}
      </button>
      {modal === 'enable' && (
        <EnableEncryptionModal conversation={conversation} onClose={() => setModal(null)} />
      )}
      {modal === 'safety' && (
        <SafetyNumberModal conversation={conversation} onClose={() => setModal(null)} />
      )}
    </>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg bg-vox-bg-primary p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function EnableEncryptionModal({ conversation, onClose }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const handleEnable = async () => {
    setBusy(true);
    try {
      await useDMStore.getState().enableEncryption(conversation.id);
      toast.success(t('e2e.enabled'));
      onClose();
    } catch (err) {
      const apiError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(apiError ?? t('e2e.enableFailed'));
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-vox-text-primary">
          <Lock size={16} className="text-vox-accent-success" />
          {t('e2e.enableTitle')}
        </h3>
        <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>
      <p className="mb-2 text-sm text-vox-text-secondary">{t('e2e.enableExplainer')}</p>
      <ul className="mb-4 list-inside list-disc space-y-1 text-xs text-vox-text-muted">
        <li>{t('e2e.enablePointIrreversible')}</li>
        <li>{t('e2e.enablePointServer')}</li>
        <li>{t('e2e.enablePointLimits')}</li>
      </ul>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-vox-text-secondary hover:bg-vox-bg-hover"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={handleEnable}
          disabled={busy}
          className="rounded-md bg-vox-accent-success px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('common.loading') : t('e2e.enableConfirm')}
        </button>
      </div>
    </ModalShell>
  );
}

function SafetyNumberModal({ conversation, onClose }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const identityWarning = useE2EStore((s) => !!s.identityWarnings[conversation.participant.id]);
  const [digits, setDigits] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    getE2EService(user.id)
      .safetyNumber(conversation.participant.id)
      .then((result) => {
        if (result) {
          setDigits(result.digits);
          setVerified(result.verified);
        } else {
          setError(true);
        }
      })
      .catch((err) => {
        console.warn('e2e: safety number unavailable:', err instanceof Error ? err.message : err);
        setError(true);
      });
  }, [user?.id, conversation.participant.id]);

  const handleMarkVerified = async () => {
    if (!user?.id) return;
    await getE2EService(user.id).markIdentityVerified(conversation.participant.id);
    setVerified(true);
  };

  const handleAcceptNewIdentity = async () => {
    if (!user?.id) return;
    try {
      await useE2EStore.getState().acceptNewIdentity(user.id, conversation.participant.id);
      setDigits(null);
      setVerified(false);
      const result = await getE2EService(user.id).safetyNumber(conversation.participant.id);
      if (result) setDigits(result.digits);
      toast.success(t('e2e.identityAccepted'));
    } catch (err) {
      console.warn('e2e: accepting new identity failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.enableFailed'));
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-vox-text-primary">
          {verified ? <ShieldCheck size={16} className="text-vox-accent-success" /> : <Lock size={16} className="text-vox-accent-success" />}
          {t('e2e.safetyNumberTitle')}
        </h3>
        <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>

      {identityWarning && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-warning/10 p-3 text-xs text-vox-accent-warning">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="mb-2">{t('e2e.identityChangedWarning', { name: conversation.participant.displayName })}</p>
            <button
              onClick={handleAcceptNewIdentity}
              className="rounded bg-vox-accent-warning px-2 py-1 font-medium text-black hover:opacity-90"
            >
              {t('e2e.acceptNewIdentity')}
            </button>
          </div>
        </div>
      )}

      <p className="mb-3 text-xs text-vox-text-muted">
        {t('e2e.safetyNumberExplainer', { name: conversation.participant.displayName })}
      </p>

      {digits ? (
        <div className="mb-4 grid grid-cols-4 gap-x-4 gap-y-1 rounded-md bg-vox-bg-secondary p-4 text-center font-mono text-sm text-vox-text-primary select-all">
          {(digits.match(/.{5}/g) ?? []).map((group, i) => (
            <span key={i}>{group}</span>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-sm text-vox-text-muted">
          {error ? t('e2e.safetyNumberUnavailable') : t('common.loading')}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className={clsx('text-xs', verified ? 'text-vox-accent-success' : 'text-vox-text-muted')}>
          {verified ? t('e2e.verified') : t('e2e.notVerified')}
        </span>
        {!verified && digits && (
          <button
            onClick={handleMarkVerified}
            className="rounded-md bg-vox-accent-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            {t('e2e.markVerified')}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
