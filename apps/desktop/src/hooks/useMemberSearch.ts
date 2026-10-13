import { useEffect, useState } from 'react';
import { MEMBER_LIST } from '@voxium/shared';
import { api } from '../services/api';
import type { ServerMember } from '@voxium/shared';

/** How long typing settles before the search goes to the server. */
export const MEMBER_SEARCH_DEBOUNCE_MS = 300;

/**
 * The server's member search for a picker: null while the text is empty (the
 * caller shows the rows it holds), the matching rows once it settled. The
 * rows the client holds are only a slice of a big server (CLAUDE.md "Server
 * Membership"), so a picker filtering them locally would miss most members.
 */
export function useMemberSearch(serverId: string, query: string): ServerMember[] | null {
  const q = query.trim();
  const [results, setResults] = useState<{ q: string; rows: ServerMember[] } | null>(null);

  useEffect(() => {
    if (!q) { setResults(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get(`/servers/${serverId}/members/search`, { params: { q, limit: MEMBER_LIST.SEARCH_MAX } });
        if (!cancelled) setResults({ q, rows: Array.isArray(data.data) ? (data.data as ServerMember[]) : [] });
      } catch (err) {
        console.warn('[MemberSearch] Search failed:', err);
        if (!cancelled) setResults({ q, rows: [] });
      }
    }, MEMBER_SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [serverId, q]);

  // Results for another text are stale: the caller falls back to its own rows meanwhile
  return q && results && results.q === q ? results.rows : null;
}
