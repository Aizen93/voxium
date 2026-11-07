import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { AlertCircle, CheckCircle, MailX, MailCheck } from 'lucide-react';
import { api } from '../services/api';

type Phase = 'checking' | 'ready' | 'working' | 'invalid' | 'failed';

/**
 * "Not you? Block Voxium mail to this address" — the page every account
 * e-mail links to. It knows nothing but the token in the URL: the server says
 * whether the mailbox that token names is blocked, and one click blocks it or
 * allows it again. The address is never shown and never sent; the token
 * carries a digest of it. Public: whoever holds the e-mail holds the right.
 */
export function MailBlockPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>('checking');
  const [blocked, setBlocked] = useState(false);
  const [done, setDone] = useState<'blocked' | 'allowed' | null>(null);

  // A 400 is the token itself refused (forged, expired, not a block token):
  // nothing a retry can fix. Anything else is the network or the server.
  const fail = useCallback((err: unknown) => {
    setPhase(axios.isAxiosError(err) && err.response?.status === 400 ? 'invalid' : 'failed');
  }, []);

  const check = useCallback(() => {
    if (!token) {
      setPhase('invalid');
      return;
    }
    setPhase('checking');
    api.post('/auth/mail-block/status', { token })
      .then(({ data }) => {
        setBlocked(Boolean(data?.data?.blocked));
        setPhase('ready');
      })
      .catch(fail);
  }, [token, fail]);

  useEffect(() => {
    check();
  }, [check]);

  const act = (path: '/auth/mail-block' | '/auth/mail-unblock') => {
    setPhase('working');
    setDone(null);
    api.post(path, { token })
      .then(({ data }) => {
        const now = Boolean(data?.data?.blocked);
        setBlocked(now);
        setDone(now ? 'blocked' : 'allowed');
        setPhase('ready');
      })
      .catch(fail);
  };

  const working = phase === 'working';

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1 className="mt-4 text-center text-2xl font-bold text-vox-text-primary">{t('auth.mailBlock.title')}</h1>
          </div>

          {phase === 'checking' && (
            <div className="flex flex-col items-center gap-4 py-4" data-testid="mail-block-checking">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-vox-accent-primary border-t-transparent" />
              <p className="text-sm text-vox-text-secondary">{t('auth.mailBlock.checking')}</p>
            </div>
          )}

          {phase === 'invalid' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-vox-accent-danger/20 bg-vox-accent-danger/10 px-4 py-3" role="alert">
                <AlertCircle size={20} className="shrink-0 text-vox-accent-danger" />
                <p className="text-sm text-vox-accent-danger">{t('auth.mailBlock.invalidLink')}</p>
              </div>
              <Link to="/" className="btn-secondary block w-full py-2.5 text-center">{t('auth.mailBlock.home')}</Link>
            </div>
          )}

          {phase === 'failed' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-vox-accent-danger/20 bg-vox-accent-danger/10 px-4 py-3" role="alert">
                <AlertCircle size={20} className="shrink-0 text-vox-accent-danger" />
                <p className="text-sm text-vox-accent-danger">{t('auth.mailBlock.failed')}</p>
              </div>
              <button type="button" onClick={check} className="btn-primary block w-full py-2.5 text-center" data-testid="mail-block-retry">
                {t('auth.mailBlock.retry')}
              </button>
              <Link to="/" className="btn-secondary block w-full py-2.5 text-center">{t('auth.mailBlock.home')}</Link>
            </div>
          )}

          {(phase === 'ready' || working) && (
            <div className="space-y-4">
              {done ? (
                <div className="flex items-center gap-3 rounded-lg border border-vox-voice-connected/20 bg-vox-voice-connected/10 px-4 py-3" role="status" data-testid="mail-block-done">
                  <CheckCircle size={20} className="shrink-0 text-vox-voice-connected" />
                  <p className="text-sm text-vox-voice-connected">{t(done === 'blocked' ? 'auth.mailBlock.blockedDone' : 'auth.mailBlock.allowedDone')}</p>
                </div>
              ) : (
                <p className="text-sm text-vox-text-secondary" data-testid="mail-block-status">
                  {t(blocked ? 'auth.mailBlock.blockedIntro' : 'auth.mailBlock.intro')}
                </p>
              )}

              <button
                type="button"
                onClick={() => act(blocked ? '/auth/mail-unblock' : '/auth/mail-block')}
                disabled={working}
                className={`${blocked ? 'btn-secondary' : 'btn-primary'} flex w-full items-center justify-center gap-2 py-2.5`}
                data-testid="mail-block-action"
              >
                {blocked ? <MailCheck size={18} /> : <MailX size={18} />}
                {working ? t('auth.mailBlock.working') : t(blocked ? 'auth.mailBlock.allow' : 'auth.mailBlock.block')}
              </button>

              <p className="text-xs text-vox-text-muted">{t('auth.mailBlock.note')}</p>
              <Link to="/" className="block text-center text-sm text-vox-text-link hover:underline">{t('auth.mailBlock.home')}</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
