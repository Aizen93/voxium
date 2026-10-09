import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Trash2, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { getTranslatedError } from '../../utils/serverErrors';

/**
 * Self-service account deletion (GDPR right to erasure — the Terms promise
 * "you may delete your account at any time", and until this existed that was
 * only true by emailing the DPO).
 *
 * Three things stand between the button and the deletion: the password (a
 * stolen session must not be enough), the TOTP code when 2FA is on, and the
 * typed confirmation word. The server additionally refuses while the account
 * still owns servers and says which; handing a community over or destroying
 * it is the owner's decision, made in each server's settings first.
 */
export function DeleteAccountSection() {
  const { t } = useTranslation();
  const { user, deleteAccount } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownedServers, setOwnedServers] = useState<Array<{ id: string; name: string }>>([]);

  const CONFIRM_WORD = t('settings.deleteAccount.confirmWord');
  const ready = password.length > 0 && confirmation === CONFIRM_WORD && (!user?.totpEnabled || totpCode.trim().length > 0) && !deleting;

  const reset = () => {
    setOpen(false);
    setPassword('');
    setTotpCode('');
    setConfirmation('');
    setError(null);
    setOwnedServers([]);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setDeleting(true);
    setError(null);
    setOwnedServers([]);
    try {
      await deleteAccount(password, user?.totpEnabled ? totpCode : undefined);
      // The store has logged out and the app is re-rendering to the login
      // page; nothing left to do here.
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409 && Array.isArray(err.response.data?.data?.ownedServers)) {
        setOwnedServers(err.response.data.data.ownedServers);
      } else {
        setError(getTranslatedError(err, t, 'settings.deleteAccount.failed'));
      }
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-vox-accent-danger/30 p-4" data-testid="delete-account-section">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-accent-danger">
        <Trash2 size={14} />
        {t('settings.deleteAccount.title')}
      </h3>
      <p className="mt-1 text-xs text-vox-text-muted">{t('settings.deleteAccount.description')}</p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg border border-vox-accent-danger/50 px-4 py-2 text-sm font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
          data-testid="delete-account-open"
        >
          {t('settings.deleteAccount.open')}
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
          <p className="flex items-start gap-2 text-xs text-vox-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-vox-accent-danger" />
            <span>{t('settings.deleteAccount.warning')}</span>
          </p>

          {ownedServers.length > 0 && (
            <div className="rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/10 px-3 py-2 text-xs text-vox-text-primary" data-testid="delete-account-owned-servers">
              <p className="font-medium">{t('settings.deleteAccount.ownsServers')}</p>
              <ul className="mt-1 list-disc list-inside">
                {ownedServers.map((s) => <li key={s.id}>{s.name}</li>)}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-3 py-2 text-xs text-vox-accent-danger">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="delete-account-password" className="mb-1 block text-xs font-medium text-vox-text-secondary">
              {t('settings.deleteAccount.password')}
            </label>
            <input
              id="delete-account-password"
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
              required
            />
          </div>

          {user?.totpEnabled && (
            <div>
              <label htmlFor="delete-account-totp" className="mb-1 block text-xs font-medium text-vox-text-secondary">
                {t('settings.deleteAccount.totpCode')}
              </label>
              <input
                id="delete-account-totp"
                name="one-time-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="delete-account-confirm" className="mb-1 block text-xs font-medium text-vox-text-secondary">
              {t('settings.deleteAccount.typeToConfirm', { word: CONFIRM_WORD })}
            </label>
            <input
              id="delete-account-confirm"
              name="confirmation"
              type="text"
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-danger"
              required
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!ready}
              className="flex-1 rounded-lg bg-vox-accent-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-vox-accent-danger/80 transition-colors"
              data-testid="delete-account-confirm"
            >
              {deleting ? t('settings.deleteAccount.deleting') : t('settings.deleteAccount.confirm')}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-vox-border px-4 py-2 text-sm font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
