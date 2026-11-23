import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDMStore } from '../../stores/dmStore';

/**
 * The end of the conversation list: the next page loads as the end scrolls
 * into view (an observer on a sentinel), or on the button, which stays for
 * keyboards, for tests and for the environments without an observer. After a
 * failed request nothing loads by itself: the message and its retry button
 * are shown until the person asks again. Nothing at all once the whole list
 * is loaded (no cursor), which is also what a server from before the paged
 * list leaves it at.
 */
export function DMListFooter() {
  const { t } = useTranslation();
  const hasMore = useDMStore((s) => s.listNextCursor !== null);
  const loading = useDMStore((s) => s.isLoadingMore);
  const failed = useDMStore((s) => s.loadMoreFailed);
  const loadMore = useDMStore((s) => s.loadMoreConversations);
  const rows = useDMStore((s) => s.conversations.length);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || failed || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // rows: a page that leaves the sentinel in view asks for the next one
  }, [hasMore, loading, failed, loadMore, rows]);

  if (!hasMore) return null;

  return (
    <div className="flex flex-col items-center gap-1.5 px-2 py-2" data-testid="dm-list-footer">
      {/* Mounted before its text appears, so the failure is announced (an
          element inserted with its text already in it is not) */}
      <p
        role="status"
        className={failed ? 'text-center text-[11.5px] text-vox-text-muted' : 'sr-only'}
        data-testid="dm-list-more-failed"
      >
        {failed ? t('dm.list.loadMoreFailed') : ''}
      </p>
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
      {/* The same button in every state: aria-disabled while loading (not
          disabled, which would drop the focus the person's click or key gave it) */}
      <button
        type="button"
        onClick={() => { if (!loading) void loadMore(); }}
        aria-disabled={loading}
        aria-busy={loading}
        className="rounded-md border border-vox-border px-3 py-1 text-xs text-vox-text-secondary transition-colors hover:border-vox-border-strong hover:text-vox-text-primary aria-disabled:opacity-60"
        data-testid="dm-list-more"
      >
        {loading ? t('common.loading') : failed ? t('dm.list.loadMoreRetry') : t('dm.list.loadMore')}
      </button>
    </div>
  );
}
