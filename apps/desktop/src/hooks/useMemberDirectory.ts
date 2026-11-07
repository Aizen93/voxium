import { useCallback, useEffect, useRef, useState } from 'react';
import { LIMITS, MEMBER_LIST } from '@voxium/shared';
import type { ServerMember } from '@voxium/shared';
import { api } from '../services/api';
import { toast } from '../stores/toastStore';
import i18n from '../i18n';

/**
 * The server's member directory for a picker: everyone in the space, paged
 * by the signed keyset cursor the directory already uses, filtered
 * server-side by the search text (CLAUDE.md "Server Membership").
 *
 * The rows the client holds are only a slice of a big server (the People
 * panel: online members above PEOPLE_MAX_ROWS), so a picker listing them
 * showed two people where the space had two hundred. This hook lists the
 * directory instead, a page at a time, and the caller keeps its own rows as
 * the instant first paint and as the fallback: `rows` is null until the
 * first page for THIS text has arrived, and null again if the directory
 * failed (the limiter, the network), so the caller filters its rows with
 * memberMatches and never shows an empty list for a member it already holds.
 */
export interface MemberDirectory {
  /** The directory's rows for the current text, or null (not yet, or failed): show your own. */
  rows: ServerMember[] | null;
  /** The number of members matching the text, once the first page said so. */
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  loadMore: () => void;
}

interface PageState {
  key: string;
  rows: ServerMember[] | null;
  total: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
}

const EMPTY: PageState = { key: '', rows: null, total: null, nextCursor: null, hasMore: false, loading: false, error: false };

function pageOf(data: { data?: unknown; total?: unknown; nextCursor?: unknown; hasMore?: unknown }) {
  const rows = Array.isArray(data.data) ? (data.data as ServerMember[]) : [];
  return {
    rows,
    total: typeof data.total === 'number' ? data.total : rows.length,
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
    hasMore: data.hasMore === true,
  };
}

export function useMemberDirectory(serverId: string, query: string): MemberDirectory {
  const q = query.trim();
  const key = `${serverId}\u0000${q}`;
  const [state, setState] = useState<PageState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  // A newer first page (another text) owns the list; an older answer is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    let cancelled = false;
    // A new text starts from nothing: the caller shows its own rows until
    // this text's first page is in, never the previous text's page.
    setState({ key, rows: null, total: null, nextCursor: null, hasMore: false, loading: true, error: false });
    // Typing is debounced; the empty text (opening the picker) is not.
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get(`/servers/${serverId}/members`, {
          params: { limit: LIMITS.MEMBERS_PER_PAGE, ...(q ? { q } : {}) },
        });
        if (cancelled || gen !== generation.current) return;
        setState({ key, ...pageOf(data), loading: false, error: false });
      } catch (err) {
        if (cancelled || gen !== generation.current) return;
        console.warn('[MemberDirectory] First page failed:', err);
        toast.error(i18n.t('common.somethingWentWrong'));
        setState({ key, rows: null, total: null, nextCursor: null, hasMore: false, loading: false, error: true });
      }
    }, q ? MEMBER_LIST.TYPING_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serverId, q, key]);

  const loadMore = useCallback(() => {
    const prev = stateRef.current;
    if (prev.key !== key || !prev.nextCursor || prev.loading || !prev.rows) return;
    const cursor = prev.nextCursor;
    const gen = generation.current;
    setState((cur) => ({ ...cur, loading: true, error: false }));
    api
      .get(`/servers/${serverId}/members`, { params: { limit: LIMITS.MEMBERS_PER_PAGE, cursor, ...(q ? { q } : {}) } })
      .then(({ data }) => {
        if (gen !== generation.current) return;
        const page = pageOf(data);
        setState((cur) => {
          if (cur.key !== key || !cur.rows) return cur;
          const seen = new Set(cur.rows.map((m) => m.userId));
          return {
            ...cur,
            rows: [...cur.rows, ...page.rows.filter((m) => !seen.has(m.userId))],
            total: page.total,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            loading: false,
          };
        });
      })
      .catch((err) => {
        if (gen !== generation.current) return;
        console.warn('[MemberDirectory] Next page failed:', err);
        toast.error(i18n.t('common.somethingWentWrong'));
        // The rows already shown stay; the next page can be asked for again.
        setState((cur) => (cur.key === key ? { ...cur, loading: false, error: true } : cur));
      });
  }, [serverId, q, key]);

  const current = state.key === key;
  return {
    rows: current ? state.rows : null,
    total: current ? state.total : null,
    hasMore: current && state.hasMore,
    loading: current && state.loading,
    error: current && state.error,
    loadMore,
  };
}
