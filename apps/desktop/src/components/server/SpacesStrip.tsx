import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Pin, PinOff, Plus, Search, Volume2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { VoiceUser } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { CreateServerModal } from './CreateServerModal';
import { ServerSwitcher } from './ServerSwitcher';
import { ServerIcon } from './ServerIcon';

/**
 * The spaces strip: communities as tabs along the top of the app.
 *
 * This deliberately is NOT a library of every server the user is in.
 * The strip holds as many tabs as the width allows — pinned spaces first,
 * then the rest in store order, the active space as an expanded named tab —
 * and the long tail collapses into a "+N" count. Positions are STABLE
 * (no unread reshuffling): a tab bar you can aim at from muscle memory
 * beats one that reorders under the cursor. Anything not visible is one
 * click (or ⌘⇧L) away in the spaces menu.
 *
 * Live voice is the strip's pulse: a space with people talking gets an
 * animated equalizer on its tab, whatever slot it is in.
 */

/** Fallback when the strip has no measurable width (first paint, jsdom). */
const DEFAULT_MAX_TABS = 7;
/** Compact tab ≈ 38px + 6px gap. */
const COMPACT_TAB_W = 44;
/** Expanded active tab (icon + truncated name) worst case. */
const ACTIVE_TAB_W = 210;
/** The "+N" overflow chip, reserved so N tabs + overflow never clip. */
const OVERFLOW_W = 70;

/** How many tabs fit in `width` px: the active expanded tab, the overflow
 *  chip, then one compact tab per remaining slot. Never fewer than 2. */
export function computeMaxTabs(width: number): number {
  if (width <= 0) return DEFAULT_MAX_TABS;
  return Math.max(2, 1 + Math.floor((width - ACTIVE_TAB_W - OVERFLOW_W) / COMPACT_TAB_W));
}

const EMPTY_USERS = new Map<string, VoiceUser[]>();
const EMPTY_SERVERS = new Map<string, string>();

/** Three-bar equalizer — the "people are talking here" mark. */
function LiveBars({ className }: { className?: string }) {
  return (
    <span data-testid="live-bars" className={clsx('flex h-[10px] items-end gap-[1.5px]', className)} aria-hidden>
      <i className="w-[2px] rounded-full bg-vox-accent-primary motion-safe:animate-[stripEq_1.1s_ease-in-out_infinite] h-[45%]" />
      <i className="w-[2px] rounded-full bg-vox-accent-primary motion-safe:animate-[stripEq_1.3s_ease-in-out_0.15s_infinite] h-[95%]" />
      <i className="w-[2px] rounded-full bg-vox-accent-primary motion-safe:animate-[stripEq_0.9s_ease-in-out_0.3s_infinite] h-[65%]" />
      <style>{`@keyframes stripEq { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }`}</style>
    </span>
  );
}

export function SpacesStrip() {
  const { t } = useTranslation();
  const { servers, activeServerId, setActiveServer, serverUnreadCounts, pinnedServerIds, togglePinServer } = useServerStore();
  const totalDMUnread = useDMStore((s) =>
    Object.values(s.dmUnreadCounts).reduce((sum, c) => sum + c, 0)
  );
  const voiceServerId = useVoiceStore((s) => s.activeVoiceServerId);
  const channelUsersRaw = useVoiceStore((s) => s.channelUsers);
  const channelServersRaw = useVoiceStore((s) => s.channelServers);
  const channelUsers = channelUsersRaw ?? EMPTY_USERS;
  const channelServers = channelServersRaw ?? EMPTY_SERVERS;

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [pinMenu, setPinMenu] = useState<{ serverId: string; x: number; y: number } | null>(null);
  const findBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const tabsAreaRef = useRef<HTMLDivElement>(null);
  const [switcherAnchor, setSwitcherAnchor] = useState<'find' | 'more'>('find');
  const [maxTabs, setMaxTabs] = useState(DEFAULT_MAX_TABS);

  // Responsive: as many tabs as the middle region actually fits. Measured via
  // ResizeObserver; a 0 width (jsdom, pre-layout) keeps the default.
  useEffect(() => {
    const el = tabsAreaRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setMaxTabs(computeMaxTabs(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return; // jsdom
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ⌘⇧L / Ctrl⇧L — the spaces menu from anywhere (⌘K belongs to search).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setSwitcherAnchor('find');
        setShowSwitcher((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Servers with someone in voice right now. */
  const liveServers = useMemo(() => {
    const live = new Set<string>();
    for (const [chId, users] of channelUsers) {
      if (users.length === 0) continue;
      const sid = channelServers.get(chId);
      if (sid) live.add(sid);
    }
    return live;
  }, [channelUsers, channelServers]);

  // Pinned first (in pin order), then everything else in store order. Visible
  // = as many as fit; if the active space lives beyond the fold it borrows the
  // last slot — you are always looking at a real tab.
  const { visible, hidden } = useMemo(() => {
    const byId = new Map(servers.map((s) => [s.id, s]));
    const pinned = pinnedServerIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
    const pinnedSet = new Set(pinned.map((s) => s.id));
    const ordered = [...pinned, ...servers.filter((s) => !pinnedSet.has(s.id))];

    const vis = ordered.slice(0, maxTabs);
    if (activeServerId && !vis.some((s) => s.id === activeServerId)) {
      const active = ordered.find((s) => s.id === activeServerId);
      if (active) vis[Math.max(0, vis.length - 1)] = active;
    }
    const visIds = new Set(vis.map((s) => s.id));
    return { visible: vis, hidden: ordered.filter((s) => !visIds.has(s.id)) };
  }, [servers, pinnedServerIds, activeServerId, maxTabs]);

  const hiddenUnread = hidden.reduce((sum, s) => sum + (serverUnreadCounts[s.id] || 0), 0);
  const hiddenLive = hidden.some((s) => liveServers.has(s.id));

  const goHome = () => {
    useServerStore.setState({ activeServerId: null });
    useDMStore.getState().clearActiveConversation();
  };
  const goServer = (id: string) => {
    useDMStore.getState().clearActiveConversation();
    setActiveServer(id);
  };
  const openSwitcher = (anchor: 'find' | 'more') => {
    setSwitcherAnchor(anchor);
    setShowSwitcher(true);
  };

  // Pin menu: right-click a tab. Closes on any click or Escape.
  useEffect(() => {
    if (!pinMenu) return;
    const close = () => setPinMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinMenu]);

  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  const tabBase =
    'relative flex h-[34px] flex-none items-center gap-2 rounded-[10px] px-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary';

  return (
    <>
      <nav
        aria-label={t('server.switcherTitle')}
        data-testid="spaces-strip"
        className="flex h-[48px] flex-none items-center gap-1.5 bg-vox-bg-primary px-2.5"
      >
        {/* Home / DMs tab */}
        <button
          className={clsx(
            tabBase,
            !activeServerId
              ? 'border border-vox-border bg-vox-chat pr-3 font-semibold'
              : 'hover:bg-vox-bg-hover'
          )}
          onClick={goHome}
          aria-label={t('dm.title')}
          aria-current={!activeServerId}
        >
          <img src="/logo.svg" alt="" className="h-6 w-6 rounded-[8px]" draggable={false} />
          {!activeServerId && <span className="text-[13px]">{t('dm.title')}</span>}
          {activeServerId && totalDMUnread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[9px] font-bold text-vox-on-accent ring-2 ring-vox-bg-primary" data-testid="unread-badge">
              {totalDMUnread > 99 ? '99+' : totalDMUnread}
            </span>
          )}
        </button>

        <span className="h-5 w-px flex-none rounded-full bg-vox-border" aria-hidden />

        {/* Space tabs + overflow — this region's width decides how many fit */}
        <div ref={tabsAreaRef} className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* py-1: overflow-x:auto forces overflow-y to auto as well, so this box
              clips anything outside the 34px tabs — and the unread badge hangs
              4px above its tab. Four pixels of padding on each side keep the
              badge inside the scrollable box; the 42px result still centres in
              the 48px strip. */}
          <div
            className="rail-scroll flex min-w-0 items-center gap-1.5 overflow-x-auto py-1"
            data-testid="spaces-rail"
          >
            {visible.map((server) => {
              const active = activeServerId === server.id;
              const unread = serverUnreadCounts[server.id] || 0;
              const live = liveServers.has(server.id);
              return (
                <button
                  key={server.id}
                  data-active={active}
                  className={clsx(
                    tabBase,
                    active
                      ? 'border border-vox-border bg-vox-chat pr-3 font-semibold'
                      : 'hover:bg-vox-bg-hover'
                  )}
                  onClick={() => goServer(server.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPinMenu({ serverId: server.id, x: e.clientX, y: e.clientY });
                  }}
                  aria-label={server.name}
                  aria-current={active}
                  title={server.name}
                >
                  <ServerIcon
                    id={server.id}
                    name={server.name}
                    iconUrl={server.iconUrl}
                    size={24}
                    rounded="rounded-[8px]"
                    className={clsx(
                      'transition-opacity duration-150',
                      active || unread > 0 || live ? 'opacity-100' : 'opacity-[0.82]'
                    )}
                  />
                  {active && (
                    <span className="max-w-[150px] truncate text-[13px]">{server.name}</span>
                  )}
                  {active && voiceServerId === server.id && (
                    <Volume2 size={12} className="shrink-0 text-vox-voice-connected" />
                  )}
                  {!active && live && <LiveBars />}
                  {!active && unread > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[9px] font-bold text-vox-on-accent ring-2 ring-vox-bg-primary" data-testid="unread-badge">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Overflow: the long tail, one click away */}
          {hidden.length > 0 && (
            <button
              ref={moreBtnRef}
              className={clsx(
                tabBase,
                'border border-dashed border-vox-border px-2.5 text-[12px] text-vox-text-muted hover:border-vox-border-strong hover:text-vox-text-secondary'
              )}
              onClick={() => openSwitcher('more')}
              aria-label={t('server.moreSpaces', { count: hidden.length })}
            >
              +{hidden.length}
              {hiddenLive && <LiveBars />}
              {hiddenUnread > 0 && (
                <span className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[9px] font-bold text-vox-on-accent">
                  {hiddenUnread > 99 ? '99+' : hiddenUnread}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Find a space — opens the spaces menu, anchored here */}
        <button
          ref={findBtnRef}
          className="flex h-[32px] flex-none items-center gap-2 rounded-full border border-vox-border px-3.5 text-[12.5px] text-vox-text-muted transition-colors hover:border-vox-border-strong hover:text-vox-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary"
          onClick={() => openSwitcher('find')}
          aria-label={t('server.switcherTitle')}
          data-testid="server-switcher-open"
        >
          <Search size={13} />
          <span className="hidden sm:inline">{t('server.findSpace')}</span>
          <kbd className="hidden rounded-sm bg-vox-bg-hover px-1.5 py-0.5 font-mono text-[10px] text-vox-text-muted/80 md:inline">
            {isMac ? '⌘⇧L' : 'Ctrl⇧L'}
          </kbd>
        </button>

        <button
          className="flex h-[32px] w-[32px] flex-none items-center justify-center rounded-full border border-vox-border text-vox-text-muted transition-colors hover:border-vox-border-strong hover:text-vox-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary"
          onClick={() => setShowCreateModal(true)}
          aria-label={t('server.createOrJoin')}
        >
          <Plus size={15} />
        </button>
      </nav>

      {/* Pin / unpin context menu */}
      {pinMenu && createPortal(
        <div
          className="fixed z-[110] min-w-40 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-float animate-fade-in"
          style={{ left: pinMenu.x, top: pinMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              togglePinServer(pinMenu.serverId);
              setPinMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            {pinnedServerIds.includes(pinMenu.serverId) ? (
              <>
                <PinOff size={14} className="text-vox-text-muted" />
                {t('server.unpinSpace')}
              </>
            ) : (
              <>
                <Pin size={14} className="text-vox-accent-primary" />
                {t('server.pinSpace')}
              </>
            )}
          </button>
        </div>,
        document.body
      )}

      {showSwitcher && (
        <ServerSwitcher
          anchorRef={switcherAnchor === 'more' ? moreBtnRef : findBtnRef}
          onClose={() => setShowSwitcher(false)}
        />
      )}
      {showCreateModal && <CreateServerModal onClose={() => setShowCreateModal(false)} />}
    </>
  );
}
