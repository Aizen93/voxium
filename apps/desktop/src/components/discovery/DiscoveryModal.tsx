import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Search, Compass, Loader2, Star, ChevronDown, PowerOff } from 'lucide-react';
import { DISCOVERY_TAGS, DISCOVERY_SORTS, DISCOVERY_SEARCH_MIN, DISCOVERY_TOTAL_CAP } from '@voxium/shared';
import type { DiscoveryServer, DiscoverySort } from '@voxium/shared';
import { useDiscoveryStore, searchableQuery } from '../../stores/discoveryStore';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { getTranslatedError, translateServerError } from '../../utils/serverErrors';
import { DiscoveryCard } from './DiscoveryCard';
import { JoinRequestDialog } from './JoinRequestDialog';
import { ReportModal } from '../chat/ReportModal';

interface Props {
  onClose: () => void;
}

/** The search debounce, as in ThemeBrowser. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Explore: the public directory (docs/local/server-discovery-plan.html,
 * "The shape of it"). A search box (3+ characters, debounced), tag chips, a
 * sort select, a Featured row on the first unsearched page, the ranked grid,
 * Load more on the cursor, and one footer line about the daily figures.
 *
 * The card is the shared DiscoveryCard; its one button is wired here: Join
 * lands in the server and closes the modal, Request opens the message
 * dialog, Cancel withdraws, Open switches to the server, the menu reports.
 */
export function DiscoveryModal({ onClose }: Props) {
  const { t } = useTranslation();
  const query = useDiscoveryStore((s) => s.query);
  const tag = useDiscoveryStore((s) => s.tag);
  const sort = useDiscoveryStore((s) => s.sort);
  const featured = useDiscoveryStore((s) => s.featured);
  const servers = useDiscoveryStore((s) => s.servers);
  const nextCursor = useDiscoveryStore((s) => s.nextCursor);
  const totalCapped = useDiscoveryStore((s) => s.totalCapped);
  const status = useDiscoveryStore((s) => s.status);
  const error = useDiscoveryStore((s) => s.error);
  const loading = useDiscoveryStore((s) => s.loading);
  const loadingMore = useDiscoveryStore((s) => s.loadingMore);
  const busyServerId = useDiscoveryStore((s) => s.busyServerId);
  const setQuery = useDiscoveryStore((s) => s.setQuery);
  const setTag = useDiscoveryStore((s) => s.setTag);
  const setSort = useDiscoveryStore((s) => s.setSort);
  const fetchFirst = useDiscoveryStore((s) => s.fetchFirst);
  const fetchMore = useDiscoveryStore((s) => s.fetchMore);

  const [requestFor, setRequestFor] = useState<DiscoveryServer | null>(null);
  const [reportFor, setReportFor] = useState<DiscoveryServer | null>(null);

  // What the directory is actually asked for: the query only once it can be
  // searched (3+ chars), settled 300 ms after the last keystroke.
  const [searchKey, setSearchKey] = useState(searchableQuery(query) ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchKey(searchableQuery(query) ?? ''), SEARCH_DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    void fetchFirst();
  }, [searchKey, tag, sort, fetchFirst]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !requestFor && !reportFor) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, requestFor, reportFor]);

  const tooShort = query.trim().length > 0 && query.trim().length < DISCOVERY_SEARCH_MIN;
  const filtered = !!searchKey || !!tag;

  const handleJoin = async (server: DiscoveryServer) => {
    try {
      await useDiscoveryStore.getState().join(server.id);
      toast.success(t('discovery.toasts.joined', { name: server.name }));
      onClose();
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'discovery.modal.joinFailed'));
    }
  };

  const handleSendRequest = async (server: DiscoveryServer, message: string | undefined) => {
    try {
      await useDiscoveryStore.getState().request(server.id, message);
      toast.success(t('discovery.toasts.requestSent', { name: server.name }));
      setRequestFor(null);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'discovery.modal.requestFailed'));
      throw err;
    }
  };

  const handleCancel = async (server: DiscoveryServer) => {
    try {
      await useDiscoveryStore.getState().cancelRequest(server.id);
      toast.info(t('discovery.toasts.requestCancelled', { name: server.name }));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'discovery.modal.cancelFailed'));
    }
  };

  const handleOpen = (server: DiscoveryServer) => {
    void useServerStore.getState().setActiveServer(server.id);
    onClose();
  };

  const handleLoadMore = () => {
    fetchMore().catch((err) => toast.error(getTranslatedError(err, t, 'discovery.modal.failedToLoad')));
  };

  const cardProps = (server: DiscoveryServer) => ({
    server,
    busy: busyServerId === server.id,
    onJoin: handleJoin,
    onRequest: setRequestFor,
    onCancelRequest: handleCancel,
    onOpen: handleOpen,
    onReport: setReportFor,
  });

  const resultsLabel = totalCapped >= DISCOVERY_TOTAL_CAP
    ? t('discovery.modal.resultsCapped', { count: DISCOVERY_TOTAL_CAP })
    : t('discovery.modal.results', { count: totalCapped });

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="discovery-title"
      data-testid="discovery-modal"
    >
      <div
        className="relative flex flex-col overflow-hidden rounded-xl border border-vox-border bg-vox-bg-secondary shadow-2xl"
        style={{ width: 'min(960px, 94vw)', height: 'min(720px, 90vh)' }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-vox-border bg-vox-bg-primary px-5 py-3">
          <div className="flex items-center gap-2">
            <Compass size={18} className="text-vox-accent-primary" />
            <div>
              <h2 id="discovery-title" className="text-sm font-bold text-vox-text-primary">{t('discovery.modal.title')}</h2>
              <p className="mt-0.5 text-[11px] text-vox-text-muted">{t('discovery.modal.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-vox-text-muted transition-colors hover:text-vox-text-primary" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        {/* Filters */}
        <div className="shrink-0 space-y-2.5 border-b border-vox-border px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-vox-text-muted" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('discovery.modal.searchPlaceholder')}
                aria-label={t('discovery.modal.searchPlaceholder')}
                className="w-full rounded-lg border border-vox-border bg-vox-bg-floating py-1.5 pl-8 pr-3 text-xs text-vox-text-primary outline-none placeholder:text-vox-text-muted focus:border-vox-accent-primary"
                data-testid="discovery-search"
                autoFocus
              />
            </div>
            <label className="relative">
              <span className="sr-only">{t('discovery.modal.sortLabel')}</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as DiscoverySort)}
                className="cursor-pointer appearance-none rounded-lg border border-vox-border bg-vox-bg-floating py-1.5 pl-3 pr-7 text-xs text-vox-text-secondary outline-none"
                data-testid="discovery-sort"
              >
                {DISCOVERY_SORTS.map((s) => (
                  <option key={s} value={s}>{t('discovery.modal.sortPrefix')}{t(`discovery.sort.${s}`)}</option>
                ))}
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-vox-text-muted" />
            </label>
          </div>
          {tooShort && (
            <p className="text-[11px] text-vox-text-muted" data-testid="discovery-search-hint">
              {t('discovery.modal.searchHint', { min: DISCOVERY_SEARCH_MIN })}
            </p>
          )}
          <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'thin' }} role="group" aria-label={t('discovery.modal.tagsLabel')} data-testid="discovery-tags">
            <TagChip active={tag === ''} onClick={() => setTag('')} testid="discovery-tag-all">{t('discovery.modal.allTags')}</TagChip>
            {DISCOVERY_TAGS.map((item) => (
              <TagChip key={item} active={tag === item} onClick={() => setTag(tag === item ? '' : item)} testid={`discovery-tag-${item}`}>
                {t(`discovery.tags.${item}`)}
              </TagChip>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: 'thin' }}>
          {status === 'off' ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-center" data-testid="discovery-off">
              <PowerOff size={22} className="text-vox-text-muted" />
              <p className="text-sm text-vox-text-secondary">{t('discovery.modal.off')}</p>
              <p className="text-xs text-vox-text-muted">{t('discovery.modal.offHint')}</p>
            </div>
          ) : status === 'error' && servers.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-3 text-center" data-testid="discovery-error">
              <p className="text-sm text-vox-text-secondary">{translateServerError(error ?? undefined, t, 'discovery.modal.failedToLoad')}</p>
              <button type="button" onClick={() => void fetchFirst()} className="rounded-lg border border-vox-border px-3 py-1.5 text-xs text-vox-text-secondary hover:bg-vox-bg-hover">
                {t('discovery.modal.retry')}
              </button>
            </div>
          ) : loading && servers.length === 0 && featured.length === 0 ? (
            <div className="flex h-48 items-center justify-center" data-testid="discovery-loading">
              <Loader2 size={24} className="animate-spin text-vox-text-muted" />
            </div>
          ) : servers.length === 0 && featured.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-1 text-center" data-testid="discovery-empty">
              <p className="text-sm text-vox-text-secondary">{filtered ? t('discovery.modal.emptyMatch') : t('discovery.modal.emptyNone')}</p>
              {filtered && <p className="text-xs text-vox-text-muted">{t('discovery.modal.emptyMatchHint')}</p>}
            </div>
          ) : (
            <div className="space-y-5">
              {featured.length > 0 && (
                <section data-testid="discovery-featured-row">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-vox-accent-warning">
                    <Star size={12} />
                    {t('discovery.modal.featured')}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {featured.map((server) => <DiscoveryCard key={`featured-${server.id}`} {...cardProps(server)} />)}
                  </div>
                </section>
              )}
              <section data-testid="discovery-results">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-vox-text-muted" data-testid="discovery-results-heading">
                  {t(`discovery.sort.${sort}`)} · {resultsLabel}
                </h3>
                {servers.length === 0 ? (
                  <p className="py-6 text-center text-sm text-vox-text-muted" data-testid="discovery-empty">
                    {filtered ? t('discovery.modal.emptyMatch') : t('discovery.modal.emptyNone')}
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {servers.map((server) => <DiscoveryCard key={server.id} {...cardProps(server)} />)}
                  </div>
                )}
                {nextCursor && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="rounded-lg border border-vox-border bg-vox-bg-floating px-4 py-1.5 text-xs font-medium text-vox-text-secondary transition-colors hover:bg-vox-bg-hover disabled:opacity-50"
                      data-testid="discovery-load-more"
                    >
                      {loadingMore ? t('common.loading') : t('discovery.modal.loadMore')}
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-vox-border px-5 py-2 text-[11px] text-vox-text-muted" data-testid="discovery-footer">
          {t('discovery.modal.footer')}
        </div>
      </div>

      {requestFor && (
        <JoinRequestDialog
          server={requestFor}
          busy={busyServerId === requestFor.id}
          onSend={(message) => handleSendRequest(requestFor, message)}
          onClose={() => setRequestFor(null)}
        />
      )}
      {reportFor && (
        <ReportModal type="server" serverId={reportFor.id} onClose={() => setReportFor(null)} />
      )}
    </div>,
    document.body,
  );
}

function TagChip({ active, onClick, testid, children }: { active: boolean; onClick: () => void; testid: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-vox-accent-primary bg-vox-accent-primary/15 text-vox-text-primary'
          : 'border-vox-border text-vox-text-secondary hover:border-vox-text-muted'
      }`}
      data-testid={testid}
    >
      {children}
    </button>
  );
}
