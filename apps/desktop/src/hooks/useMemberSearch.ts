import { useEffect, useState } from 'react';
import { MEMBER_LIST } from '@voxium/shared';
import { api } from '../services/api';
import { toast } from '../stores/toastStore';
import i18n from '../i18n';
import type { ServerMember } from '@voxium/shared';

/**
 * The server's member search for a picker: null while the text is empty (the
 * caller shows the rows it holds), the matching rows once it settled. The
 * rows the client holds are only a slice of a big server (CLAUDE.md "Server
 * Membership"), so a picker filtering them locally would miss most members.
 *
 * A failed search (the search limiter, the network) is ALSO null: the caller
 * falls back to filtering its own rows with memberMatches, which on a small
 * server is the whole membership — never an empty "No members found" for a
 * member the client already holds.
 */
export function useMemberSearch(serverId: string, query: string): ServerMember[] | null {
  const q = query.trim();
  const [results, setResults] = useState<{ q: string; rows: ServerMember[] | null } | null>(null);

  useEffect(() => {
    if (!q) { setResults(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get(`/servers/${serverId}/members/search`, { params: { q, limit: MEMBER_LIST.SEARCH_MAX } });
        if (!cancelled) setResults({ q, rows: Array.isArray(data.data) ? (data.data as ServerMember[]) : [] });
      } catch (err) {
        console.warn('[MemberSearch] Search failed:', err);
        if (!cancelled) {
          setResults({ q, rows: null });
          toast.error(i18n.t('common.somethingWentWrong'));
        }
      }
    }, MEMBER_LIST.TYPING_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [serverId, q]);

  // Results for another text are stale: the caller falls back to its own rows meanwhile
  return q && results && results.q === q ? results.rows : null;
}

/** The local filter a picker applies to the rows it holds while the server has not answered. */
export function memberMatches(m: ServerMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q
    || m.user.displayName.toLowerCase().includes(q)
    || m.user.username.toLowerCase().includes(q)
    || (m.nickname ?? '').toLowerCase().includes(q);
}
