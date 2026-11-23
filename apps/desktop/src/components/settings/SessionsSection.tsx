import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { MonitorSmartphone } from 'lucide-react';
import type { SessionSummary } from '@voxium/shared';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { listSessions, revokeSession } from '../../services/sessions';
import { getTranslatedError } from '../../utils/serverErrors';
import { WebhookDialog } from '../server/WebhookDialog';
import { formatDate } from '../../utils/formatDate';

/**
 * "Where you're signed in" (Settings → Security): every session of the
 * account, the caller's own first, with a sign-out on each other row and one
 * for all the others. Both sign-outs ask for the account password. The list
 * lives in this component's state (nothing else reads it) and is fetched
 * again after every action. A server without the list (404) hides the whole
 * section.
 *
 * The password is held only while a dialog is open, cleared when it closes,
 * and never logged.
 */

// Literal keys (not built from the value), so the translation-key test can
// read them from this file. An unknown value from a newer server falls back
// to the "unknown" / "other" wording.
const KIND_KEYS: Record<string, string> = {
  desktop: 'settings.security.sessions.kind.desktop',
  web: 'settings.security.sessions.kind.web',
  admin: 'settings.security.sessions.kind.admin',
  android: 'settings.security.sessions.kind.android',
  ios: 'settings.security.sessions.kind.ios',
  unknown: 'settings.security.sessions.kind.unknown',
};
const OS_KEYS: Record<string, string> = {
  windows: 'settings.security.sessions.os.windows',
  macos: 'settings.security.sessions.os.macos',
  linux: 'settings.security.sessions.os.linux',
  android: 'settings.security.sessions.os.android',
  ios: 'settings.security.sessions.os.ios',
  other: 'settings.security.sessions.os.other',
};

const hasOwn = (map: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(map, key);

function sessionDate(date: Date, language: string, timeZone?: string): string {
  return formatDate('date', date, { language, timeZone });
}

/** Whole calendar days from `then` to `now` in LOCAL time (0 = the same day). */
function localDaysBetween(then: Date, now: Date): number {
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  return Math.round((a - b) / 86_400_000);
}

type Dialog = { kind: 'one'; session: SessionSummary } | { kind: 'others' };
type Status = 'loading' | 'ready' | 'failed' | 'hidden';

export function SessionsSection() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? 'en';
  const [status, setStatus] = useState<Status>('loading');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const loadSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const list = await listSessions();
      if (!mounted.current || seq !== loadSeq.current) return;
      if (list === null) {
        setStatus('hidden');
        return;
      }
      setSessions(list);
      setStatus('ready');
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      console.warn('[Sessions] Could not load the session list:', err instanceof Error ? err.message : 'unknown error');
      setStatus('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeDialog = () => {
    setDialog(null);
    setPassword('');
    setError(null);
  };

  const labelOf = (session: SessionSummary) => {
    const kind = t(hasOwn(KIND_KEYS, session.clientKind) ? KIND_KEYS[session.clientKind] : KIND_KEYS.unknown);
    const os = t(hasOwn(OS_KEYS, session.clientOs) ? OS_KEYS[session.clientOs] : OS_KEYS.other);
    return t('settings.security.sessions.kindAndOs', { kind, os });
  };

  const activeLabel = (session: SessionSummary) => {
    const last = new Date(session.lastActiveAt);
    if (Number.isNaN(last.getTime())) return null;
    const days = localDaysBetween(last, new Date());
    if (days <= 0) return t('settings.security.sessions.activeToday');
    if (days === 1) return t('settings.security.sessions.activeYesterday');
    return t('settings.security.sessions.activeOn', { date: sessionDate(last, language) });
  };

  const signedInLabel = (session: SessionSummary) => {
    const at = new Date(session.signedInAt);
    if (Number.isNaN(at.getTime())) return null;
    // The server sends UTC midnight of the sign-in day: a local format could show the day before
    return t('settings.security.sessions.signedInOn', { date: sessionDate(at, language, 'UTC') });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dialog || busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === 'one') {
        await revokeSession(dialog.session.id, password);
        if (!mounted.current) return;
        toast.success(t('settings.security.sessions.signedOutOne'));
      } else {
        const { revoked } = await useAuthStore.getState().revokeOtherSessions(password);
        if (!mounted.current) return;
        toast.success(t('settings.security.sessions.signedOutOthers', { count: revoked }));
      }
      closeDialog();
      void load();
    } catch (err) {
      if (!mounted.current) return;
      const message = getTranslatedError(err, t, 'settings.security.sessions.failed');
      if (dialog.kind === 'one' && axios.isAxiosError(err) && err.response?.status === 404) {
        // It ended meanwhile: nothing left to confirm, show what the list says now
        toast.error(message);
        closeDialog();
        void load();
      } else {
        setError(message);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (status === 'hidden') return null;

  const others = sessions.filter((s) => !s.current);
  // The caller's own row first (the server already orders it so; the list is short)
  const ordered = [...sessions.filter((s) => s.current), ...others];

  return (
    <div className="border-t border-vox-border pt-5" data-testid="sessions-section">
      <div className="flex items-center gap-2 mb-1">
        <MonitorSmartphone size={16} className="text-vox-text-muted" />
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('settings.security.sessions.title')}</h3>
      </div>
      <p className="text-xs text-vox-text-muted mb-4">{t('settings.security.sessions.description')}</p>

      {status === 'loading' && sessions.length === 0 && (
        <p className="text-xs text-vox-text-muted">{t('common.loading')}</p>
      )}

      {status === 'failed' && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-3 py-2 text-xs text-vox-accent-danger" role="alert">
          <span>{t('settings.security.sessions.loadFailed')}</span>
          <button
            type="button"
            onClick={() => { setStatus('loading'); void load(); }}
            className="shrink-0 rounded-md border border-vox-accent-danger/30 px-2 py-1 hover:bg-vox-accent-danger/20 transition-colors"
            data-testid="sessions-retry"
          >
            {t('settings.security.sessions.retry')}
          </button>
        </div>
      )}

      {ordered.length > 0 && (
        <ul className="space-y-2">
          {ordered.map((session) => {
            const signedIn = signedInLabel(session);
            const active = activeLabel(session);
            return (
              <li
                key={session.id}
                className="flex items-center gap-3 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2"
                data-testid="session-row"
                data-session-current={session.current ? 'true' : 'false'}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-vox-text-primary">{labelOf(session)}</span>
                    {session.current && (
                      <span className="shrink-0 rounded-full bg-vox-voice-connected/20 px-2 py-0.5 text-[10px] font-medium text-vox-voice-connected" data-testid="session-this-device">
                        {t('settings.security.sessions.thisDevice')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-vox-text-muted">
                    {[signedIn, active].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {!session.current && (
                  <button
                    type="button"
                    onClick={() => { setError(null); setPassword(''); setDialog({ kind: 'one', session }); }}
                    className="shrink-0 rounded-lg border border-vox-border px-3 py-1.5 text-xs text-vox-text-secondary hover:bg-vox-bg-tertiary hover:text-vox-text-primary transition-colors"
                    data-testid="session-sign-out"
                  >
                    {t('settings.security.sessions.signOut')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {status === 'ready' && (
        others.length > 0 ? (
          <button
            type="button"
            onClick={() => { setError(null); setPassword(''); setDialog({ kind: 'others' }); }}
            className="mt-3 w-full rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/10 px-3 py-2 text-xs text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors"
            data-testid="sessions-sign-out-others"
          >
            {t('settings.security.sessions.signOutOthers')}
          </button>
        ) : (
          <p className="mt-3 text-xs text-vox-text-muted">{t('settings.security.sessions.noOthers')}</p>
        )
      )}

      {dialog && (
        <WebhookDialog labelledBy="sessions-confirm-title" onClose={closeDialog} busy={busy} testId="sessions-confirm-dialog">
          <form onSubmit={handleSubmit}>
            <h2 id="sessions-confirm-title" className="mb-3 text-base font-bold text-vox-text-primary">
              {t('settings.security.sessions.confirmTitle')}
            </h2>
            {dialog.kind === 'one' ? (
              <div className="space-y-2 text-sm text-vox-text-secondary">
                <p>{t('settings.security.sessions.confirmOne', { label: labelOf(dialog.session) })}</p>
                <p className="text-xs text-vox-text-muted">{t('settings.security.sessions.confirmOneTrusted')}</p>
              </div>
            ) : (
              <p className="text-sm text-vox-text-secondary">{t('settings.security.sessions.confirmOthers')}</p>
            )}

            <label htmlFor="sessions-confirm-password" className="mt-4 mb-1 block text-xs font-medium text-vox-text-secondary">
              {t('settings.security.sessions.password')}
            </label>
            <input
              id="sessions-confirm-password"
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
              data-testid="sessions-confirm-password"
            />

            {error && (
              <div className="mt-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-3 py-2 text-xs text-vox-accent-danger" role="alert" data-testid="sessions-confirm-error">
                {error}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={closeDialog} disabled={busy} className="btn-secondary" data-testid="sessions-confirm-cancel">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || password.length === 0} className="btn-danger disabled:opacity-50" data-testid="sessions-confirm-submit">
                {busy ? t('common.loading') : t('settings.security.sessions.signOut')}
              </button>
            </div>
          </form>
        </WebhookDialog>
      )}
    </div>
  );
}
