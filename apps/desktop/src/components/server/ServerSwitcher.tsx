import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Pin, Search, Hash, Volume2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { VoiceUser } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { ServerIcon } from './ServerIcon';

/**
 * The spaces menu: jump to any server by typing (spec: the answer to "what
 * about 100+ servers"), ordered by what matters right now.
 *
 * Sections, in priority order:
 *   Live now — servers where people are in voice at this moment. Voxium is
 *   voice-first; "where is something happening" beats the alphabet.
 *   Pinned — the user's chosen favorites, in the order they pinned them.
 *   All spaces — unread first, then alphabetical. Stable and predictable:
 *   the same query always produces the same order, so muscle memory survives.
 *
 * Rows carry a hover pin toggle (a sibling of the row button — buttons must
 * not nest) so favorites are managed right where you find them.
 *
 * Given an `anchorRef` it renders as a dropdown under the trigger (the spaces
 * strip's "Find a space" control); without one it is a centered palette.
 */

const EMPTY_USERS = new Map<string, VoiceUser[]>();
const EMPTY_SERVERS = new Map<string, string>();
const EMPTY_PINNED: string[] = [];

export function ServerSwitcher({
  onClose,
  anchorRef,
}: {
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const servers = useServerStore((s) => s.servers);
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const pinnedServerIdsRaw = useServerStore((s) => s.pinnedServerIds);
  const togglePinServer = useServerStore((s) => s.togglePinServer);
  const pinnedServerIds = pinnedServerIdsRaw ?? EMPTY_PINNED;
  const voiceServerId = useVoiceStore((s) => s.activeVoiceServerId);
  // Raw selects with module-level fallbacks OUTSIDE the selector — a `?? new
  // Map()` inside would mint a fresh reference per read and loop the snapshot.
  const channelUsersRaw = useVoiceStore((s) => s.channelUsers);
  const channelServersRaw = useVoiceStore((s) => s.channelServers);
  const channelUsers = channelUsersRaw ?? EMPTY_USERS;
  const channelServers = channelServersRaw ?? EMPTY_SERVERS;
  const totalDMUnread = useDMStore((s) =>
    Object.values(s.dmUnreadCounts).reduce((sum, c) => sum + c, 0)
  );

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Anchored mode: sit under the trigger, right edges aligned. Repositions on
  // resize only (portal-popup convention).
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!anchorRef) return;
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchorRef]);

  /** serverId → people currently in that server's voice channels. */
  const voiceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [chId, users] of channelUsers) {
      if (users.length === 0) continue;
      const sid = channelServers.get(chId);
      if (sid) counts.set(sid, (counts.get(sid) || 0) + users.length);
    }
    return counts;
  }, [channelUsers, channelServers]);

  type Row =
    | { kind: 'dm'; id: '__dm__'; name: string; unread: number }
    | { kind: 'server'; id: string; name: string; unread: number; iconUrl?: string | null; live?: number };

  const { rows, liveCount, pinnedCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: Row[] = [];

    const dmName = t('dm.title');
    if (!q || dmName.toLowerCase().includes(q)) {
      list.push({ kind: 'dm', id: '__dm__', name: dmName, unread: totalDMUnread });
    }

    const matched = servers
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map((s) => ({
        kind: 'server' as const,
        id: s.id,
        name: s.name,
        unread: serverUnreadCounts[s.id] || 0,
        iconUrl: s.iconUrl,
        live: voiceCounts.get(s.id),
      }));

    // Live rooms first (busiest on top) — they are why you'd switch right now.
    const live = matched
      .filter((s) => (s.live ?? 0) > 0)
      .sort((a, b) => (b.live ?? 0) - (a.live ?? 0));
    const liveIds = new Set(live.map((s) => s.id));

    // Then favorites, in the order they were pinned.
    const byId = new Map(matched.map((s) => [s.id, s]));
    const pinned = pinnedServerIds
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s && !liveIds.has(s.id));
    const pinnedIds = new Set(pinned.map((s) => s.id));

    // Everyone else: unread first, then alphabetical.
    const rest = matched.filter((s) => !liveIds.has(s.id) && !pinnedIds.has(s.id));
    rest.sort((a, b) => {
      if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return b.unread - a.unread > 0 ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return { rows: list.concat(live, pinned, rest), liveCount: live.length, pinnedCount: pinned.length };
  }, [query, servers, serverUnreadCounts, totalDMUnread, voiceCounts, pinnedServerIds, t]);

  // Clamp rather than reset: typing narrows the list, and a cursor past the end
  // would make Enter do nothing.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const choose = (row: Row) => {
    useDMStore.getState().clearActiveConversation();
    if (row.kind === 'dm') {
      useServerStore.setState({ activeServerId: null });
    } else {
      setActiveServer(row.id);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) choose(row);
    }
  };

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const sectionLabel = (text: string) => (
    <div className="section-label px-2.5 pb-1 pt-2.5">{text}</div>
  );

  // Section headers sit between rows. Captions only appear when there is a
  // section to separate from — a flat list needs none.
  const firstServerIndex = rows.findIndex((r) => r.kind === 'server');
  const hasSections = liveCount > 0 || pinnedCount > 0;
  const firstLiveIndex = liveCount > 0 ? firstServerIndex : -1;
  const firstPinnedIndex = pinnedCount > 0 ? firstServerIndex + liveCount : -1;
  const firstRestIndex = hasSections ? firstServerIndex + liveCount + pinnedCount : -1;

  const panel = (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border border-vox-border bg-vox-bg-floating shadow-float',
        anchorRef ? 'fixed z-[100] w-[340px]' : 'w-full max-w-[520px]'
      )}
      style={anchorRef && pos ? { top: pos.top, right: pos.right } : undefined}
      role="dialog"
      aria-label={t('server.switcherTitle')}
      data-testid="server-switcher"
    >
      <div className="flex items-center gap-2.5 border-b border-vox-border px-3.5">
        <Search size={15} className="shrink-0 text-vox-text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('server.switcherPlaceholder')}
          aria-label={t('server.switcherPlaceholder')}
          className="h-[46px] flex-1 bg-transparent text-[14px] text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none"
          data-testid="server-switcher-input"
        />
        <kbd className="shrink-0 rounded-sm bg-vox-bg-hover px-1.5 py-0.5 font-mono text-[10px] text-vox-text-muted">
          esc
        </kbd>
      </div>

      <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-[13px] text-vox-text-muted">
            {t('server.switcherEmpty')}
          </p>
        )}
        {rows.map((row, i) => {
          const isPinned = row.kind === 'server' && pinnedServerIds.includes(row.id);
          return (
            <div key={row.id}>
              {i === firstLiveIndex && sectionLabel(t('server.liveNow'))}
              {i === firstPinnedIndex && sectionLabel(t('server.pinnedSection'))}
              {i === firstRestIndex && sectionLabel(t('server.allSpaces'))}
              <div
                data-active={i === cursor}
                onMouseMove={() => setCursor(i)}
                className={clsx(
                  'group flex w-full items-center rounded-lg pr-1 transition-colors',
                  i === cursor ? 'bg-vox-accent-tint' : 'hover:bg-vox-bg-hover'
                )}
              >
                <button
                  data-row-btn
                  onClick={() => choose(row)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                >
                  {row.kind === 'dm' ? (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-vox-bg-tertiary">
                      <img src="/logo.svg" alt="" className="h-4 w-4" draggable={false} />
                    </span>
                  ) : (
                    <ServerIcon id={row.id} name={row.name} iconUrl={row.iconUrl} size={28} rounded="rounded-md" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span data-row-name className="block truncate text-[13.5px] text-vox-text-primary">
                      {row.name}
                    </span>
                    {row.kind === 'server' && (row.live ?? 0) > 0 && (
                      <span className="block text-[10.5px] leading-tight text-vox-accent-primary">
                        {t('server.inVoiceCount', { count: row.live })}
                      </span>
                    )}
                  </span>
                  {row.kind === 'server' && voiceServerId === row.id && (
                    <Volume2 size={13} className="shrink-0 text-vox-voice-connected" />
                  )}
                  {row.unread > 0 && (
                    <span className="shrink-0 rounded-full bg-vox-accent-primary px-1.5 py-0.5 text-[10px] font-bold text-vox-on-accent">
                      {row.unread > 99 ? '99+' : row.unread}
                    </span>
                  )}
                </button>
                {row.kind === 'server' && (
                  <button
                    onClick={() => togglePinServer?.(row.id)}
                    aria-label={isPinned ? t('server.unpinSpace') : t('server.pinSpace')}
                    title={isPinned ? t('server.unpinSpace') : t('server.pinSpace')}
                    className={clsx(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-vox-bg-hover',
                      isPinned
                        ? 'text-vox-accent-primary'
                        : 'text-vox-text-muted opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                    )}
                  >
                    <Pin size={12} className={isPinned ? 'fill-current' : undefined} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-vox-border px-3.5 py-2 text-[11px] text-vox-text-muted">
        <span className="flex items-center gap-1">
          <Hash size={11} /> {t('server.switcherHint')}
        </span>
      </div>
    </div>
  );

  return createPortal(
    anchorRef ? (
      <div
        className="fixed inset-0 z-[100]"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {panel}
      </div>
    ) : (
      <div
        className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {panel}
      </div>
    ),
    document.body
  );
}
