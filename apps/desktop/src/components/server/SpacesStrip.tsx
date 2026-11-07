import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Compass, MessageCircle, Pin, PinOff, Plus, Search, Volume2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { Conversation, VoiceUser } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSupportStore } from '../../stores/supportStore';
import { Avatar } from '../common/Avatar';
import { isMacPlatform } from '../../utils/platform';
import { CreateServerModal } from './CreateServerModal';
import { ServerSwitcher } from './ServerSwitcher';
import { ServerIcon } from './ServerIcon';
import { DiscoveryModal } from '../discovery/DiscoveryModal';

/**
 * The spaces strip: the navigation along the top of the app, in two captioned
 * zones (docs/local/spaces-dm-navigation-plan.html, Concept E, decided
 * 2026-10-25).
 *
 *   Messages — a labelled tab that leads to Direct Messages in BOTH contexts
 *   (a logo with no word read as "about", never as "my conversations"), and
 *   the three most recent conversations as presence avatars: one click from
 *   any channel to the person, with their unread count on their face.
 *
 *   Spaces — communities as tabs. This deliberately is NOT a library of every
 *   server the user is in. The strip holds as many tabs as the width allows —
 *   pinned spaces first, then the rest in store order, the active space as an
 *   expanded named tab — and the long tail collapses into a "+N" count.
 *   Positions are STABLE (no unread reshuffling): a tab bar you can aim at
 *   from muscle memory beats one that reorders under the cursor. After the
 *   tabs, a dashed "New space" tab: a plus where a tab row ends means "new" in
 *   every browser, where the old round plus at the far right meant nothing.
 *   Anything not visible is one click (or ⌘⇧L) away in the spaces menu.
 *
 * Live voice is the strip's pulse: a space with people talking gets an
 * animated equalizer on its tab, whatever slot it is in.
 *
 * Two frames for one content (`settingsStore.spacesStripMode`):
 *   pinned — a 56 px row on the page background, the default.
 *   auto   — the row is folded into a 132×12 notch under the title bar and
 *            slides out as a chamfered panel over the panels when the pointer
 *            rests on the notch (STRIP_REVEAL_DELAY_MS, so a pointer crossing
 *            to the sidebar search does not flash it), on ⌘⇧L, on keyboard
 *            focus or on a tap; it folds back STRIP_HIDE_DELAY_MS after the
 *            pointer leaves, never while one of its popovers is open or focus
 *            is inside. The notch carries the signals the fold would hide: a
 *            dot for unread anywhere, a green one for live voice anywhere.
 *            The nav never leaves the DOM, so ⌘⇧L and Tab reach it folded.
 */

/** Fallback when the strip has no measurable width (first paint, jsdom). */
const DEFAULT_MAX_TABS = 7;
/** Compact tab 42px + 8px gap. */
const COMPACT_TAB_W = 50;
/** Expanded active tab (32px icon + truncated name) worst case. */
const ACTIVE_TAB_W = 230;
/** The "+N" overflow chip, reserved so N tabs + overflow never clip. */
const OVERFLOW_W = 80;
/** The "New space" tab after the overflow, reserved so it never pushes a tab out by itself. */
const NEW_SPACE_W = 120;
/** How many recent conversations the Messages zone shows. */
export const RECENT_PEOPLE = 3;
/** The pointer rests on the notch this long before the folded strip slides out. */
export const STRIP_REVEAL_DELAY_MS = 120;
/** Grace after the pointer leaves the revealed strip before it folds back. */
export const STRIP_HIDE_DELAY_MS = 350;
/** After a destination is chosen from the revealed strip (a space, Messages, a
 *  person), it folds on its own this much later, whatever the pointer or the
 *  focus are doing: a menu that stays out after a choice reads as stuck. */
export const STRIP_NAV_FOLD_DELAY_MS = 1500;
/** Below this window width the Find / Explore controls drop their labels (tabs keep their slots). */
export const STRIP_LABELS_MIN_WIDTH_PX = 1200;
/** The revealed panel's shape: a bar with chamfered bottom corners (Concept E3). */
export const STRIP_CLIP_PATH = 'polygon(0 0, 100% 0, 100% 38%, calc(100% - 34px) 100%, 34px 100%, 0 38%)';

/** How many tabs fit in `width` px: the active expanded tab, the overflow
 *  chip and the New space tab, then one compact tab per remaining slot.
 *  Never fewer than 2. */
export function computeMaxTabs(width: number): number {
  if (width <= 0) return DEFAULT_MAX_TABS;
  return Math.max(2, 1 + Math.floor((width - ACTIVE_TAB_W - OVERFLOW_W - NEW_SPACE_W) / COMPACT_TAB_W));
}

const EMPTY_USERS = new Map<string, VoiceUser[]>();
const EMPTY_SERVERS = new Map<string, string>();
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_STATUSES: Record<string, 'online' | 'idle' | 'dnd' | 'offline'> = {};

/** A media query as state; `fallback` where matchMedia does not exist (jsdom). */
function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

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

function UnreadBadge({ count, corner }: { count: number; corner?: boolean }) {
  return (
    <span
      className={clsx(
        'flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[9px] font-bold text-vox-on-accent',
        corner && 'absolute -right-0.5 -top-0.5 ring-2 ring-vox-bg-primary'
      )}
      data-testid="unread-badge"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function SpacesStrip() {
  const { t } = useTranslation();
  const { servers, activeServerId, setActiveServer, serverUnreadCounts, pinnedServerIds, togglePinServer } = useServerStore();
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const totalDMUnread = useMemo(
    () => Object.values(dmUnreadCounts ?? {}).reduce((sum, c) => sum + c, 0),
    [dmUnreadCounts]
  );
  const conversationsRaw = useDMStore((s) => s.conversations);
  const participantStatusesRaw = useDMStore((s) => s.participantStatuses);
  const activeConversationId = useDMStore((s) => s.activeConversationId);
  const conversations = conversationsRaw ?? EMPTY_CONVERSATIONS;
  const participantStatuses = participantStatusesRaw ?? EMPTY_STATUSES;
  const voiceServerId = useVoiceStore((s) => s.activeVoiceServerId);
  const channelUsersRaw = useVoiceStore((s) => s.channelUsers);
  const channelServersRaw = useVoiceStore((s) => s.channelServers);
  const channelUsers = channelUsersRaw ?? EMPTY_USERS;
  const channelServers = channelServersRaw ?? EMPTY_SERVERS;
  const stripMode = useSettingsStore((s) => s.spacesStripMode);
  const setSpacesStripMode = useSettingsStore((s) => s.setSpacesStripMode);
  const autoHide = stripMode === 'auto';

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Explore (server discovery) — one mount point; the switcher's no-match
  // state and the create/join modal hand over to it
  const [showExplore, setShowExplore] = useState(false);
  const openExplore = () => {
    setShowSwitcher(false);
    setShowCreateModal(false);
    setShowExplore(true);
  };
  const [pinMenu, setPinMenu] = useState<{ serverId: string; x: number; y: number } | null>(null);
  const findBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const tabsAreaRef = useRef<HTMLDivElement>(null);
  const [switcherAnchor, setSwitcherAnchor] = useState<'find' | 'more'>('find');
  const [maxTabs, setMaxTabs] = useState(DEFAULT_MAX_TABS);
  // Labels on Find / Explore / New space need room; below the breakpoint they
  // are icon buttons with tooltips so the tabs keep their slots on a narrow
  // window. The revealed panel is narrower than the strip (its insets, its
  // chamfers and the pin), so it is always icon-only.
  const wide = useMediaQuery(`(min-width: ${STRIP_LABELS_MIN_WIDTH_PX}px)`, true);
  const labels = wide && !autoHide;
  // No hover (touch): the notch is a taller tap target.
  const coarse = useMediaQuery('(hover: none)', false);

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

  // ─── Auto-hide: the fold and the reveal ─────────────────────────────────
  const [revealed, setRevealed] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const popoverOpen = showSwitcher || showCreateModal || showExplore || pinMenu !== null;
  const popoverOpenRef = useRef(popoverOpen);
  popoverOpenRef.current = popoverOpen;
  const autoHideRef = useRef(autoHide);
  autoHideRef.current = autoHide;
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;

  const clearTimer = (ref: typeof revealTimer) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };
  const reveal = useCallback(() => {
    clearTimer(revealTimer);
    clearTimer(hideTimer);
    if (autoHideRef.current) setRevealed(true);
  }, []);
  const scheduleReveal = useCallback(() => {
    if (!autoHideRef.current) return;
    clearTimer(hideTimer);
    if (revealedRef.current || revealTimer.current) return;
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      setRevealed(true);
    }, STRIP_REVEAL_DELAY_MS);
  }, []);
  const scheduleHide = useCallback(() => {
    clearTimer(revealTimer);
    if (!autoHideRef.current || hideTimer.current) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      // A popover of the strip, or focus inside it, keeps it out; the pointer
      // coming back cancelled this timer already.
      if (popoverOpenRef.current || focusInside.current || pointerInside.current) return;
      setRevealed(false);
    }, STRIP_HIDE_DELAY_MS);
  }, []);
  // A choice made from the revealed strip folds it on its own. The clicked
  // tab keeps the focus, and the pointer is still over the panel, so neither
  // hold applies here: only a popover of the strip keeps it out.
  const foldAfterNavigation = useCallback(() => {
    if (!autoHideRef.current) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && navRef.current?.contains(active)) active.blur();
    focusInside.current = false;
    clearTimer(revealTimer);
    clearTimer(hideTimer);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (popoverOpenRef.current) return;
      setRevealed(false);
    }, STRIP_NAV_FOLD_DELAY_MS);
  }, []);

  // A popover closing with the pointer elsewhere lets the strip fold.
  useEffect(() => {
    if (!autoHide || popoverOpen) return;
    if (revealedRef.current && !pointerInside.current && !focusInside.current) scheduleHide();
  }, [popoverOpen, autoHide, scheduleHide]);

  // Pinned again: unfold for good and drop any pending fold.
  useEffect(() => {
    if (autoHide) return;
    clearTimer(revealTimer);
    clearTimer(hideTimer);
    setRevealed(false);
  }, [autoHide]);

  useEffect(() => () => {
    clearTimer(revealTimer);
    clearTimer(hideTimer);
  }, []);

  // ⌘⇧L / Ctrl⇧L — the spaces menu from anywhere (⌘K belongs to search); it
  // unfolds the strip first so the menu has its anchor. Escape folds a
  // revealed strip once none of its popovers claims the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        reveal();
        setSwitcherAnchor('find');
        setShowSwitcher((open) => !open);
        return;
      }
      if (e.key === 'Escape' && autoHideRef.current && revealedRef.current && !popoverOpenRef.current) {
        clearTimer(revealTimer);
        clearTimer(hideTimer);
        setRevealed(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reveal]);

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
  const anyUnread = totalDMUnread > 0 || Object.values(serverUnreadCounts).some((c) => c > 0);
  const anyLive = liveServers.size > 0;

  // The conversations the store keeps sorted by most recent activity.
  const recent = conversations.slice(0, RECENT_PEOPLE);
  const atHome = !activeServerId;

  const goHome = () => {
    useServerStore.setState({ activeServerId: null });
    useDMStore.getState().clearActiveConversation();
    foldAfterNavigation();
  };
  const goServer = (id: string) => {
    useDMStore.getState().clearActiveConversation();
    setActiveServer(id);
    foldAfterNavigation();
  };
  // One click from a channel to a person: leave the space, drop the Friends
  // and Support views, open the conversation (dmStore owns the message clear).
  const openConversation = (conversationId: string) => {
    useFriendStore.getState().setShowFriendsView(false);
    useSupportStore.getState().setShowSupportView(false);
    useServerStore.setState({ activeServerId: null });
    useDMStore.getState().setActiveConversation(conversationId);
    foldAfterNavigation();
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

  const isMac = isMacPlatform();

  const tabBase =
    'relative flex h-[42px] flex-none items-center gap-2 rounded-[12px] px-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary';
  // On the page background the active tab is the reading surface; inside the
  // revealed panel (itself that surface) it is the next step up.
  // Explicit text colour: the tab inherits the page's muted tone otherwise,
  // which on the light theme's white reading surface is grey on white.
  const activeTab = clsx('border border-vox-border pr-3 font-semibold text-vox-text-primary', autoHide ? 'bg-vox-bg-floating' : 'bg-vox-chat');
  // 64px zone: 4px above the 9px caption, the 46px rail (42px tabs + 2px of
  // badge overhang each side), 5px under the tabs so they never touch the
  // panels below. In the browser build the strip is the window's top edge,
  // so the caption needs the room above it as much as the tabs below.
  const zoneBase = 'relative flex h-[64px] items-center gap-2 pb-[5px] pt-[13px]';
  const caption =
    'pointer-events-none absolute left-1.5 top-1 font-mono text-[8.5px] font-medium uppercase leading-none tracking-[0.12em] text-vox-text-muted';
  const roundBtn =
    'flex flex-none items-center justify-center rounded-full border border-vox-border text-vox-text-muted transition-colors hover:border-vox-border-strong hover:text-vox-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary';
  const pillBtn =
    'flex h-[32px] flex-none items-center gap-2 rounded-full border border-vox-border px-3.5 text-[12.5px] text-vox-text-muted transition-colors hover:border-vox-border-strong hover:text-vox-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary';

  const content = (
    <>
      {/* Messages zone — the labelled way to Direct Messages, and the people you talk to */}
      <div className={clsx(zoneBase, 'flex-none')} data-testid="strip-zone-messages">
        <span className={caption} aria-hidden>{t('server.messagesTab')}</span>
        <button
          className={clsx(tabBase, 'pr-3', atHome ? activeTab : 'hover:bg-vox-bg-hover')}
          onClick={goHome}
          aria-label={t('server.messagesTab')}
          aria-current={atHome}
          data-testid="messages-tab"
        >
          <span
            className={clsx(
              'flex h-8 w-8 flex-none items-center justify-center rounded-[10px]',
              atHome ? 'bg-vox-accent-primary text-vox-on-accent' : 'bg-vox-accent-tint text-vox-accent-primary'
            )}
          >
            <MessageCircle size={18} />
          </span>
          <span className="text-[13px] font-semibold text-vox-text-primary">{t('server.messagesTab')}</span>
          {!atHome && totalDMUnread > 0 && <UnreadBadge count={totalDMUnread} />}
        </button>
        {recent.map((conv) => {
          const unread = dmUnreadCounts?.[conv.id] || 0;
          const open = atHome && activeConversationId === conv.id;
          return (
            <button
              key={conv.id}
              className="relative flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full transition-colors hover:bg-vox-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary"
              onClick={() => openConversation(conv.id)}
              aria-label={conv.participant.displayName}
              aria-current={open ? 'true' : undefined}
              title={conv.participant.displayName}
              data-testid="recent-person"
            >
              <Avatar
                avatarUrl={conv.participant.avatarUrl}
                displayName={conv.participant.displayName}
                size="sm"
                shape="circle"
                status={participantStatuses[conv.participant.id] || 'offline'}
                className={open ? 'ring-2 ring-vox-accent-primary' : undefined}
              />
              {unread > 0 && <UnreadBadge count={unread} corner />}
            </button>
          );
        })}
      </div>

      <span className="h-[26px] w-px flex-none rounded-full bg-vox-border" aria-hidden />

      {/* Spaces zone — the tabs, the overflow and New space; its width decides how many fit */}
      <div className={clsx(zoneBase, 'min-w-0 flex-1')} data-testid="strip-zone-spaces">
        <span className={caption} aria-hidden>{t('server.spacesZone')}</span>
        <div ref={tabsAreaRef} className="flex min-w-0 flex-1 items-center gap-2">
          {/* py-0.5: overflow-x:auto forces overflow-y to auto as well, so this
              box clips anything outside the 42px tabs — and the unread badge
              hangs 2px above its tab. Two pixels of padding on each side keep
              the badge inside the scrollable box; the 46px result fills the
              zone under its caption. */}
          <div
            className="rail-scroll flex min-w-0 items-center gap-2 overflow-x-auto py-0.5"
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
                  className={clsx(tabBase, active ? activeTab : 'hover:bg-vox-bg-hover')}
                  onClick={() => goServer(server.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPinMenu({ serverId: server.id, x: e.clientX, y: e.clientY });
                  }}
                  aria-label={server.name}
                  aria-current={active}
                  title={server.name}
                >
                  <ServerIcon id={server.id} name={server.name} iconUrl={server.iconUrl} size={32} rounded="rounded-[10px]" />
                  {active && (
                    <span className="max-w-[150px] truncate text-[13px]">{server.name}</span>
                  )}
                  {active && voiceServerId === server.id && (
                    <Volume2 size={12} className="shrink-0 text-vox-voice-connected" />
                  )}
                  {!active && live && <LiveBars />}
                  {!active && unread > 0 && <UnreadBadge count={unread} corner />}
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
              {hiddenUnread > 0 && <UnreadBadge count={hiddenUnread} />}
            </button>
          )}

          {/* New space — where the tab row ends, like a browser's new tab */}
          <button
            className={clsx(
              tabBase,
              'gap-1.5 border border-dashed border-vox-border-strong pl-1.5 pr-3 text-[13px] font-medium text-vox-text-secondary hover:border-vox-accent-primary hover:bg-vox-bg-hover hover:text-vox-text-primary'
            )}
            onClick={() => setShowCreateModal(true)}
            aria-label={t('server.createOrJoin')}
            title={t('server.createOrJoin')}
            data-testid="new-space"
          >
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-vox-bg-hover text-vox-text-primary">
              <Plus size={15} />
            </span>
            {labels && <span>{t('server.newSpace')}</span>}
          </button>
        </div>
      </div>

      {/* Find a space — opens the spaces menu, anchored here */}
      <button
        ref={findBtnRef}
        className={labels ? pillBtn : clsx(roundBtn, 'h-[42px] w-[42px]')}
        onClick={() => openSwitcher('find')}
        aria-label={t('server.switcherTitle')}
        title={labels ? undefined : t('server.findSpace')}
        data-testid="server-switcher-open"
      >
        <Search size={labels ? 13 : 15} />
        {labels && (
          <>
            <span>{t('server.findSpace')}</span>
            <kbd className="rounded-sm bg-vox-bg-hover px-1.5 py-0.5 font-mono text-[10px] text-vox-text-muted/80">
              {isMac ? '⌘⇧L' : `${t('common.ctrlKey')}⇧L`}
            </kbd>
          </>
        )}
      </button>

      {/* Explore — the public directory */}
      <button
        className={labels ? pillBtn : clsx(roundBtn, 'h-[42px] w-[42px]')}
        onClick={openExplore}
        aria-label={t('discovery.explore')}
        title={t('discovery.explore')}
        data-testid="discovery-explore"
      >
        <Compass size={labels ? 13 : 15} />
        {labels && <span>{t('discovery.explore')}</span>}
      </button>

      {autoHide && (
        <button
          className={clsx(roundBtn, 'h-[32px] w-[32px]')}
          onClick={() => setSpacesStripMode('pinned')}
          aria-label={t('server.stripKeepOpen')}
          title={t('server.stripKeepOpen')}
          data-testid="strip-keep-open"
        >
          <Pin size={14} />
        </button>
      )}
    </>
  );

  return (
    <>
      {autoHide ? (
        <div className="relative flex-none" data-testid="spaces-strip-dock">
          {/* The fold: a full-width band with the notch, in flow */}
          <div
            className={clsx('flex w-full items-start justify-center', coarse ? 'h-6' : 'h-3')}
            onPointerEnter={() => {
              pointerInside.current = true;
              scheduleReveal();
            }}
            onPointerLeave={() => {
              pointerInside.current = false;
              scheduleHide();
            }}
          >
            <button
              type="button"
              className={clsx(
                'flex w-[132px] items-center justify-center gap-2 rounded-b-[12px] border border-t-0 border-vox-border bg-vox-chat focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary',
                coarse ? 'h-6' : 'h-3'
              )}
              onClick={reveal}
              onFocus={reveal}
              aria-label={t('server.stripRevealHandle')}
              aria-expanded={revealed}
              data-testid="spaces-strip-handle"
            >
              <i className="block h-[3px] w-7 rounded-full bg-vox-border-strong" aria-hidden />
              {anyUnread && <i className="block h-1.5 w-1.5 rounded-full bg-vox-accent-primary" aria-hidden data-testid="strip-dot-unread" />}
              {anyLive && <i className="block h-1.5 w-1.5 rounded-full bg-vox-voice-connected" aria-hidden data-testid="strip-dot-live" />}
            </button>
          </div>
          {/* The revealed panel: over the panels, never in flow */}
          <div
            className={clsx(
              'absolute left-3 right-3 top-0 z-40 drop-shadow-[0_16px_20px_rgba(0,0,0,0.5)] motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out',
              revealed ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
            )}
            data-testid="spaces-strip-panel"
            data-revealed={revealed}
          >
            <nav
              aria-label={t('server.switcherTitle')}
              data-testid="spaces-strip"
              ref={navRef}
              className="relative flex h-[72px] items-center gap-2 bg-vox-chat px-[46px]"
              style={{ clipPath: STRIP_CLIP_PATH }}
              onPointerEnter={() => {
                pointerInside.current = true;
                clearTimer(hideTimer);
              }}
              onPointerLeave={() => {
                pointerInside.current = false;
                scheduleHide();
              }}
              onFocus={() => {
                focusInside.current = true;
                reveal();
              }}
              onBlur={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                focusInside.current = false;
                scheduleHide();
              }}
            >
              <span
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(141,141,242,0.16),transparent_40%)]"
                aria-hidden
              />
              {content}
            </nav>
          </div>
        </div>
      ) : (
        <nav
          aria-label={t('server.switcherTitle')}
          data-testid="spaces-strip"
          className="flex h-[64px] flex-none items-center gap-2 bg-vox-bg-primary px-2.5"
        >
          {content}
        </nav>
      )}

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
          onExplore={openExplore}
        />
      )}
      {showCreateModal && <CreateServerModal onClose={() => setShowCreateModal(false)} onExplore={openExplore} />}
      {showExplore && <DiscoveryModal onClose={() => setShowExplore(false)} />}
    </>
  );
}
