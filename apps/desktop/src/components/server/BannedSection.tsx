import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban } from 'lucide-react';
import { useServerStore, NO_BANS } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { getTranslatedError } from '../../utils/serverErrors';
import { Avatar } from '../common/Avatar';

/**
 * Server settings → Members → Banned (KICK_MEMBERS). Every removal is a ban;
 * this is the undo. No socket event carries bans (the plan defines none), so
 * the list is fetched on open and edited locally on unban.
 */
export function BannedSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const bans = useServerStore((s) => (s.bansServerId === serverId ? s.bans : NO_BANS));
  const fetchBans = useServerStore((s) => s.fetchBans);
  const unbanMember = useServerStore((s) => s.unbanMember);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBans(serverId)
      .catch((err) => { if (!cancelled) toast.error(getTranslatedError(err, t, 'server.banned.failedToLoad')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverId, fetchBans, t]);

  const handleUnban = async (userId: string, name: string) => {
    setBusy(userId);
    try {
      await unbanMember(serverId, userId);
      toast.success(t('server.banned.unbanned', { name }));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'server.banned.failedToUnban'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-vox-border bg-vox-bg-secondary p-3" data-testid="banned-section">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-text-primary">
        <Ban size={14} />
        {t('server.banned.title')}
        {bans.length > 0 && (
          <span className="rounded-full bg-vox-bg-hover px-1.5 text-[10px] font-semibold text-vox-text-muted">{bans.length}</span>
        )}
      </h3>
      {loading && bans.length === 0 ? (
        <p className="mt-2 text-xs text-vox-text-muted">{t('common.loading')}</p>
      ) : bans.length === 0 ? (
        <p className="mt-2 text-xs text-vox-text-muted" data-testid="banned-empty">{t('server.banned.empty')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {bans.map((b) => (
            <li key={b.userId} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-vox-bg-hover/50" data-testid="ban-row">
              <Avatar avatarUrl={b.user.avatarUrl} displayName={b.user.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-vox-text-primary">{b.user.displayName}</span>
                  <span className="truncate text-xs text-vox-text-muted">@{b.user.username}</span>
                </div>
                <p className={`mt-0.5 text-xs ${b.reason ? 'text-vox-text-secondary' : 'italic text-vox-text-muted'}`} data-testid="ban-reason">
                  {b.reason || t('server.banned.noReason')}
                </p>
                <p className="mt-0.5 text-[11px] text-vox-text-muted">
                  {t('server.banned.at', { when: new Date(b.createdAt).toLocaleString() })}
                  {b.bannedBy ? ` · ${t('server.banned.by', { name: b.bannedBy.displayName })}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleUnban(b.userId, b.user.displayName)}
                disabled={busy === b.userId}
                className="shrink-0 rounded-md border border-vox-border px-2.5 py-1 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover disabled:opacity-50"
                data-testid="ban-unban"
              >
                {t('server.banned.unban')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
