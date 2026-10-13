import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import type { ServerMember, MemberRole } from '@voxium/shared';
import { LIMITS, validateBanReason } from '@voxium/shared';
import { outranksRole } from '../../utils/roles';
import { getTranslatedError, translateServerError } from '../../utils/serverErrors';

/** How long typing settles before the search goes to the server. */
export const DIRECTORY_SEARCH_DEBOUNCE_MS = 300;

/** Module-level constant so a selector for another server's list never allocates. */
const NO_ROWS: ServerMember[] = [];

/**
 * Server settings → Members: the DIRECTORY. Unlike the People panel, which
 * shows who is around, this is every member of the server — paged by the
 * server in owner, admins, join-date order, searched and filtered server-side
 * (CLAUDE.md "Server Membership"). The rows are the store's directory state,
 * so a kick, a role or nickname change and a join land here live.
 */
export function MembersDirectory({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const directory = useServerStore((s) => s.directory);
  const rows = directory.serverId === serverId ? directory.rows : NO_ROWS;
  const loading = directory.serverId === serverId && directory.loading;
  const hasMore = directory.serverId === serverId && directory.hasMore;
  const matching = directory.serverId === serverId ? directory.total : 0;
  const memberCount = useServerStore((s) => s.people.memberCount);
  const roles = useServerStore((s) => s.roles);
  const fetchDirectory = useServerStore((s) => s.fetchDirectory);
  const fetchDirectoryMore = useServerStore((s) => s.fetchDirectoryMore);
  const assignMemberRoles = useServerStore((s) => s.assignMemberRoles);
  // The viewer's own row is always among the known rows (the slice includes them)
  const currentMember = useServerStore((s) => s.members.find((m) => m.userId === currentUser?.id));

  const [confirmAction, setConfirmAction] = useState<{ type: 'kick' | 'transfer'; userId: string } | null>(null);
  const [banReason, setBanReason] = useState('');
  const [removing, setRemoving] = useState(false);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [savingRoles, setSavingRoles] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);

  const isOwner = currentMember?.role === 'owner';
  const isAdmin = currentMember?.role === 'admin';
  const canManageRoles = isOwner || isAdmin;
  const assignableRoles = roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  // Typing settles before it becomes a request; the filter is immediate
  useEffect(() => {
    const next = search.trim();
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), DIRECTORY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    let cancelled = false;
    fetchDirectory(serverId, { q: query, role: roleFilter })
      .catch((err) => { if (!cancelled) toast.error(getTranslatedError(err, t, 'serverSettings.members.failedToLoad')); });
    return () => { cancelled = true; };
  }, [serverId, query, roleFilter, fetchDirectory, t]);

  const loadMore = () => {
    fetchDirectoryMore(serverId)
      .catch((err) => toast.error(getTranslatedError(err, t, 'serverSettings.members.failedToLoad')));
  };

  // The next page loads as the end of the list scrolls into view; the button
  // stays for keyboards, for tests, and for the environments without an observer
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, rows.length, serverId]);

  async function handleRoleChange(memberId: string, newRole: MemberRole) {
    try {
      await useServerStore.getState().updateMemberRole(serverId, memberId, newRole);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'serverSettings.members.failedToUpdateRole'));
    }
  }

  async function handleKick(memberId: string, name: string) {
    if (removing) return;
    const reason = banReason.trim();
    const invalid = reason ? validateBanReason(reason) : null;
    if (invalid) { toast.error(translateServerError(invalid, t)); return; }
    setRemoving(true);
    try {
      await useServerStore.getState().kickMember(serverId, memberId, reason || undefined);
      toast.success(t('server.removeAndBanned', { name }));
      setConfirmAction(null);
      setBanReason('');
      setExpandedMember(null);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'server.removeAndBanFailed'));
    } finally {
      setRemoving(false);
    }
  }

  async function handleTransfer(targetUserId: string) {
    try {
      await useServerStore.getState().transferOwnership(serverId, targetUserId);
      setConfirmAction(null);
      setExpandedMember(null);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'serverSettings.members.failedToTransfer'));
    }
  }

  async function handleToggleRole(memberId: string, roleId: string) {
    const member = rows.find((m) => m.userId === memberId);
    if (!member) return;
    setSavingRoles(true);
    try {
      const currentRoleIds = new Set(member.roles?.map((r) => r.id) || []);
      const newRoleIds = currentRoleIds.has(roleId)
        ? [...currentRoleIds].filter((id) => id !== roleId)
        : [...currentRoleIds, roleId];
      await assignMemberRoles(serverId, memberId, newRoleIds);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'serverSettings.members.failedToUpdateRoles'));
    } finally {
      setSavingRoles(false);
    }
  }

  function canKickMember(member: ServerMember): boolean {
    if (!currentMember || member.userId === currentUser?.id) return false;
    if (!isOwner && !isAdmin) return false;
    return outranksRole(currentMember.role, member.role);
  }

  const filtered = !!query || !!roleFilter;
  const total = Math.max(memberCount, matching);

  return (
    <div className="space-y-3" data-testid="members-directory">
      {/* Search + Filter bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-vox-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t('serverSettings.members.searchPlaceholder')}
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-primary pl-8 pr-3 py-1.5 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
            data-testid="members-search"
          />
        </div>
        <select
          value={roleFilter ?? ''}
          onChange={(e) => setRoleFilter(e.target.value || null)}
          className="rounded-lg border border-vox-border bg-vox-bg-primary px-2 py-1.5 text-xs text-vox-text-secondary focus:outline-none focus:border-vox-accent-primary"
          data-testid="members-role-filter"
        >
          <option value="">{t('serverSettings.members.allRoles')}</option>
          <option value="owner">{t('serverSettings.members.owners')}</option>
          <option value="admin">{t('serverSettings.members.admins')}</option>
          {assignableRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
          <option value="none">{t('serverSettings.members.noRoles')}</option>
        </select>
      </div>

      {/* Member count: the server's figures, not the rows on screen */}
      <p className="text-xs text-vox-text-muted" data-testid="members-count">
        {t(total !== 1 ? 'serverSettings.members.memberCountPlural' : 'serverSettings.members.memberCount', { filtered: filtered ? matching : total, total })}
      </p>

      {/* Member list */}
      <div className="space-y-0.5">
        {rows.map((member) => {
          const isSelf = member.userId === currentUser?.id;
          const isExpanded = expandedMember === member.userId;
          const showPromote = isOwner && member.role === 'member' && !isSelf;
          const showDemote = isOwner && member.role === 'admin' && !isSelf;
          const showKick = canKickMember(member);
          const showTransfer = isOwner && !isSelf;
          const showRoleEdit = canManageRoles && !isSelf && member.role !== 'owner' && assignableRoles.length > 0;
          const hasActions = showPromote || showDemote || showKick || showTransfer || showRoleEdit;
          const isConfirmingKick = confirmAction?.type === 'kick' && confirmAction.userId === member.userId;
          const isConfirmingTransfer = confirmAction?.type === 'transfer' && confirmAction.userId === member.userId;

          return (
            <div key={member.userId} className="rounded-lg border border-transparent hover:border-vox-border transition-colors" data-testid="member-row">
              {/* Main row */}
              <div
                className={`flex items-center gap-3 px-3 py-2 cursor-pointer rounded-lg transition-colors ${
                  isExpanded ? 'bg-vox-bg-hover' : 'hover:bg-vox-bg-hover/50'
                }`}
                onClick={() => {
                  if (!hasActions && !isSelf) return;
                  setExpandedMember(isExpanded ? null : member.userId);
                  setConfirmAction(null);
                }}
              >
                <Avatar avatarUrl={member.user.avatarUrl} displayName={member.user.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-vox-text-primary">
                      {member.nickname || member.user.displayName}
                    </span>
                    {member.nickname && (
                      <span className="text-xs text-vox-text-muted truncate">({member.user.displayName})</span>
                    )}
                    {isSelf && (
                      <span className="text-[10px] font-medium text-vox-accent-primary bg-vox-accent-primary/10 rounded px-1">{t('serverSettings.members.you')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-vox-text-muted">@{member.user.username}</span>
                    <RoleBadge role={member.role} />
                  </div>
                </div>

                {/* Role pills (always visible) */}
                <div className="flex flex-wrap gap-1 shrink-0 max-w-[180px] justify-end">
                  {member.roles?.map((role) => (
                    <span
                      key={role.id}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        color: role.color || '#99aab5',
                        backgroundColor: (role.color || '#99aab5') + '18',
                        border: `1px solid ${(role.color || '#99aab5')}30`,
                      }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-current" />
                      {role.name}
                    </span>
                  ))}
                </div>

                {/* Expand indicator */}
                {hasActions && (
                  <svg
                    className={`h-4 w-4 text-vox-text-muted shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </div>

              {/* Expanded panel */}
              {isExpanded && hasActions && (
                <div className="px-3 pb-3 pt-1 space-y-3 border-t border-vox-border/50 mx-2">
                  {/* Role assignment */}
                  {showRoleEdit && (
                    <div>
                      <p className="text-[11px] font-semibold text-vox-text-muted uppercase tracking-wider mb-1.5">{t('serverSettings.members.assignRoles')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {assignableRoles.map((role) => {
                          const hasRole = member.roles?.some((r) => r.id === role.id) ?? false;
                          return (
                            <button
                              key={role.id}
                              onClick={(e) => { e.stopPropagation(); handleToggleRole(member.userId, role.id); }}
                              disabled={savingRoles}
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border transition-all disabled:opacity-50 ${
                                hasRole
                                  ? 'shadow-sm'
                                  : 'border-dashed border-vox-border text-vox-text-muted hover:border-vox-text-secondary hover:text-vox-text-secondary'
                              }`}
                              style={hasRole ? {
                                color: role.color || '#99aab5',
                                borderColor: (role.color || '#99aab5') + '60',
                                backgroundColor: (role.color || '#99aab5') + '18',
                              } : undefined}
                            >
                              {hasRole ? (
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                              )}
                              {role.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Promote / Demote */}
                  {(showPromote || showDemote) && (
                    <div className="flex items-center gap-2">
                      {showPromote && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRoleChange(member.userId, 'admin'); }}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-vox-accent-primary hover:bg-vox-accent-primary/10 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                          {t('serverSettings.members.promoteToAdmin')}
                        </button>
                      )}
                      {showDemote && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRoleChange(member.userId, 'member'); }}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                          {t('serverSettings.members.demoteToMember')}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Dangerous actions */}
                  {(showKick || showTransfer) && (
                    <div className="space-y-2 pt-1 border-t border-vox-border/30">
                      {/* Confirmation dialog */}
                      {isConfirmingKick && (
                        <div className="rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3" data-testid="remove-and-ban-confirm">
                          <p className="text-xs text-vox-text-primary font-medium mb-1">
                            {t('server.removeAndBanConfirm', { name: member.nickname || member.user.displayName })}
                          </p>
                          <p className="text-[11px] text-vox-text-muted mb-2.5">
                            {t('server.removeAndBanDescription')}
                          </p>
                          <input
                            type="text"
                            value={banReason}
                            maxLength={LIMITS.SERVER_BAN_REASON_MAX}
                            onChange={(e) => setBanReason(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            disabled={removing}
                            placeholder={t('server.banReasonPlaceholder')}
                            className="mb-2.5 w-full rounded-md border border-vox-border bg-vox-bg-secondary px-2.5 py-1.5 text-xs text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-danger focus:outline-none"
                            data-testid="ban-reason-input"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleKick(member.userId, member.nickname || member.user.displayName); }}
                              disabled={removing}
                              className="rounded-md bg-vox-accent-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-danger/80 transition-colors disabled:opacity-50"
                              data-testid="remove-and-ban-submit"
                            >
                              {t('server.removeAndBan')}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction(null); setBanReason(''); }}
                              disabled={removing}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      )}

                      {isConfirmingTransfer && (
                        <div className="rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
                          <p className="text-xs text-vox-text-primary font-medium mb-1">
                            {t('serverSettings.members.transferConfirm', { name: member.nickname || member.user.displayName })}
                          </p>
                          <p className="text-[11px] text-vox-text-muted mb-2.5">
                            {t('serverSettings.members.transferDescription')}
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleTransfer(member.userId); }}
                              className="rounded-md bg-vox-accent-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-danger/80 transition-colors"
                            >
                              {t('serverSettings.members.transfer')}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction(null); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Action buttons (hidden when confirming) */}
                      {!isConfirmingKick && !isConfirmingTransfer && (
                        <div className="flex items-center gap-2">
                          {showKick && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setBanReason(''); setConfirmAction({ type: 'kick', userId: member.userId }); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                              data-testid="remove-and-ban"
                            >
                              {t('server.removeAndBan')}
                            </button>
                          )}
                          {showTransfer && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'transfer', userId: member.userId }); }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-vox-text-muted hover:bg-vox-bg-hover transition-colors"
                            >
                              {t('serverSettings.members.transferOwnership')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {rows.length === 0 && !loading && (
          <p className="text-center text-sm text-vox-text-muted py-8" data-testid="members-empty">
            {filtered ? t('serverSettings.members.noResults') : t('serverSettings.members.noMembers')}
          </p>
        )}
        {loading && rows.length === 0 && (
          <p className="text-center text-sm text-vox-text-muted py-8">{t('common.loading')}</p>
        )}

        {hasMore && (
          <div ref={sentinelRef} className="flex justify-center py-2">
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="rounded-md border border-vox-border px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover disabled:opacity-50"
              data-testid="members-load-more"
            >
              {loading ? t('common.loading') : t('serverSettings.members.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: MemberRole }) {
  const { t } = useTranslation();
  if (role === 'owner') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-yellow-500/20 text-yellow-400" title={t('serverSettings.members.owner')}>
        <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        {t('serverSettings.members.owner')}
      </span>
    );
  }
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-vox-accent-primary/20 text-vox-accent-primary" title={t('serverSettings.members.admin')}>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        {t('serverSettings.members.admin')}
      </span>
    );
  }
  return null;
}
