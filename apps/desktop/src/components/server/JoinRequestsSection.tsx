import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import { useServerStore, NO_JOIN_REQUESTS } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { getTranslatedError } from '../../utils/serverErrors';
import { Avatar } from '../common/Avatar';

/**
 * Server settings → Members → Join requests (KICK_MEMBERS). Rows are the
 * store's list: fetched on open, appended by server:join_request and dropped
 * by server:join_request_resolved — approving here removes the row through
 * the same resolution path the socket event takes.
 */
export function JoinRequestsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  // Only THIS server's list — the store holds one list at a time, and a
  // fetch for another server must not render here (default outside the
  // selector, against the module constant, never a fresh `[]`).
  const requests = useServerStore((s) => (s.joinRequestsServerId === serverId ? s.joinRequests : NO_JOIN_REQUESTS));
  const fetchJoinRequests = useServerStore((s) => s.fetchJoinRequests);
  const approveJoinRequest = useServerStore((s) => s.approveJoinRequest);
  const declineJoinRequest = useServerStore((s) => s.declineJoinRequest);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJoinRequests(serverId)
      .catch((err) => { if (!cancelled) toast.error(getTranslatedError(err, t, 'server.joinRequests.failedToLoad')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverId, fetchJoinRequests, t]);

  const decide = async (userId: string, name: string, approve: boolean) => {
    setBusy(userId);
    try {
      if (approve) {
        await approveJoinRequest(serverId, userId);
        toast.success(t('server.joinRequests.approved', { name }));
      } else {
        await declineJoinRequest(serverId, userId);
        toast.success(t('server.joinRequests.declined', { name }));
      }
    } catch (err) {
      toast.error(getTranslatedError(err, t, approve ? 'server.joinRequests.failedToApprove' : 'server.joinRequests.failedToDecline'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-vox-border bg-vox-bg-secondary p-3" data-testid="join-requests">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-text-primary">
        <UserPlus size={14} />
        {t('server.joinRequests.title')}
        {requests.length > 0 && (
          <span className="rounded-full bg-vox-accent-primary/15 px-1.5 text-[10px] font-semibold text-vox-accent-primary">{requests.length}</span>
        )}
      </h3>
      {loading && requests.length === 0 ? (
        <p className="mt-2 text-xs text-vox-text-muted">{t('common.loading')}</p>
      ) : requests.length === 0 ? (
        <p className="mt-2 text-xs text-vox-text-muted" data-testid="join-requests-empty">{t('server.joinRequests.empty')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {requests.map((r) => (
            <li key={r.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-vox-bg-hover/50" data-testid="join-request-row">
              <Avatar avatarUrl={r.user.avatarUrl} displayName={r.user.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-vox-text-primary">{r.user.displayName}</span>
                  <span className="truncate text-xs text-vox-text-muted">@{r.user.username}</span>
                </div>
                <p className={`mt-0.5 text-xs ${r.message ? 'text-vox-text-secondary' : 'italic text-vox-text-muted'}`} data-testid="join-request-message">
                  {r.message || t('server.joinRequests.noMessage')}
                </p>
                <p className="mt-0.5 text-[11px] text-vox-text-muted">{t('server.joinRequests.requestedAt', { when: new Date(r.createdAt).toLocaleString() })}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => decide(r.userId, r.user.displayName, true)}
                  disabled={busy === r.userId}
                  className="rounded-md bg-vox-accent-primary px-2.5 py-1 text-xs font-medium text-vox-on-accent hover:bg-vox-accent-hover disabled:opacity-50"
                  data-testid="join-request-approve"
                >
                  {t('server.joinRequests.approve')}
                </button>
                <button
                  type="button"
                  onClick={() => decide(r.userId, r.user.displayName, false)}
                  disabled={busy === r.userId}
                  className="rounded-md border border-vox-border px-2.5 py-1 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover disabled:opacity-50"
                  data-testid="join-request-decline"
                >
                  {t('server.joinRequests.decline')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
