import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { isNewDay, daySeparatorFor } from '../../utils/dateSeparator';
import { ArrowDown } from 'lucide-react';

/** Virtual index of the oldest loadable message; leaves room to page upward. */
const FIRST_INDEX_BASE = 1000000;

/** Hairline day divider (2026 redesign): "Today", "Yesterday", or the date. */
function DaySeparatorRow({ iso }: { iso: string }) {
  const { t } = useTranslation();
  const sep = daySeparatorFor(iso);
  const label = sep.kind === 'today' ? t('chat.today') : sep.kind === 'yesterday' ? t('chat.yesterday') : sep.label;
  if (!label) return null;
  return (
    <div className="flex items-center gap-3.5 py-4" aria-label={label}>
      <div className="h-px flex-1 bg-vox-border" />
      <span className="select-none font-mono text-[10px] uppercase tracking-[0.12em] text-vox-text-muted/80">{label}</span>
      <div className="h-px flex-1 bg-vox-border" />
    </div>
  );
}

export function MessageList() {
  const { t } = useTranslation();
  const { messages, hasMore, hasMoreAfter, isLoading, fetchMessages, typingUsers, targetMessageId, clearTargetMessage } = useChatStore();
  const { activeChannelId, members, channels } = useServerStore();
  const { user } = useAuthStore();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const fetchingRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  // SECURE channels: moderation is membership-derived, never role-derived —
  // the channel CREATOR moderates (MANAGE_MESSAGES in the fixed creator set),
  // and a server admin/owner who is a plain member (or no member at all) does
  // not. Showing them the admin delete button would only produce a 403.
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const canModerate = activeChannel?.secure
    ? activeChannel.createdById === user?.id
    : isAdmin;

  // Scroll to bottom on channel change
  useEffect(() => {
    fetchingRef.current = false;
    setShowScrollButton(false);
    // Small delay to let Virtuoso render
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
    });
  }, [activeChannelId]);

  // Scroll to target message (from search). The around-fetch sets messages
  // and targetMessageId in one store update, so by the time this runs the
  // target is normally IN the array; if a stale render sneaks in first, keep
  // the target alive for the pass that has the data — clearing it early is
  // what used to silently swallow the jump.
  useEffect(() => {
    if (!targetMessageId) return;
    const idx = messages.findIndex((m) => m.id === targetMessageId);
    if (idx === -1) return;
    // A freshly remounted Virtuoso applies its own initial positioning
    // asynchronously (twice under StrictMode) and can land at the bottom
    // AFTER a single scroll call — so the target scroll repeats until the
    // mount pipeline has settled. 'auto' is idempotent; the extra calls are
    // no-ops once the position sticks.
    const scrollToTarget = () =>
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
    scrollToTarget();
    // The last retry also releases the target: clearing earlier would rerun
    // this effect and cancel the pending retries via cleanup.
    const retries = [
      setTimeout(scrollToTarget, 120),
      setTimeout(() => {
        scrollToTarget();
        clearTargetMessage();
      }, 350),
    ];
    // Highlight once the row exists — after a remount it can take a few frames.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryHighlight = () => {
      const el = document.querySelector(`[data-message-id="${targetMessageId}"]`);
      if (el) {
        el.classList.add('bg-vox-accent-primary/10');
        timer = setTimeout(() => el.classList.remove('bg-vox-accent-primary/10'), 2000);
        return;
      }
      if (++tries < 10) timer = setTimeout(tryHighlight, 50);
    };
    tryHighlight();
    return () => {
      retries.forEach(clearTimeout);
      if (timer) clearTimeout(timer);
    };
  }, [targetMessageId, clearTargetMessage, messages]);

  // firstItemIndex must move ONLY when older pages are PREPENDED. Deriving it
  // from the length (BASE - length) also shifted it on every APPEND, which
  // Virtuoso reads as "an item was prepended at the top" and compensates by
  // nudging the scroll up one estimated row — the "sent a message and the
  // list crept up, hiding it" bug. Refs are mutated during render on purpose:
  // the index must be consistent with `messages` in the SAME render pass.
  const firstIndexRef = useRef(FIRST_INDEX_BASE);
  const prevFirstIdRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<string | null>(null);
  const prevChannelRef = useRef<string | null | undefined>(undefined);
  // Bumped whenever the loaded window is REPLACED rather than grown (channel
  // switch, or a search jump's around-fetch). Keys the Virtuoso instance: a
  // replace can't be described as append/prepend, so the list remounts and
  // initialTopMostItemIndex lands it directly on the right row.
  const epochRef = useRef(0);
  // True when THIS render swapped the whole window (channel switch or search
  // jump): the "new last message" then is not an arrival, and following
  // output to the bottom would override the jump target.
  let windowReplaced = false;
  if (prevChannelRef.current !== activeChannelId) {
    prevChannelRef.current = activeChannelId;
    firstIndexRef.current = FIRST_INDEX_BASE;
    prevFirstIdRef.current = messages[0]?.id ?? null;
    epochRef.current += 1;
    windowReplaced = true;
  } else if (messages.length > 0 && messages[0].id !== prevFirstIdRef.current) {
    const shifted = prevFirstIdRef.current
      ? messages.findIndex((m) => m.id === prevFirstIdRef.current)
      : -1;
    // A real PREPEND keeps the tail: the previous first message moved down
    // AND the previous last message is still here. An around-window that
    // overlaps the old page satisfies the first check but truncates the tail
    // — treating that as a prepend anchors the scroll to the wrong rows.
    const tailSurvives =
      prevLastIdRef.current != null && messages.some((m) => m.id === prevLastIdRef.current);
    if (shifted > 0 && tailSurvives) {
      // Older page PREPENDED — shift the window start so the reading
      // position holds.
      firstIndexRef.current -= shifted;
    } else {
      // The window was replaced.
      epochRef.current += 1;
      firstIndexRef.current = FIRST_INDEX_BASE;
      windowReplaced = true;
    }
    prevFirstIdRef.current = messages[0].id;
  }

  const targetIndex = targetMessageId
    ? messages.findIndex((m) => m.id === targetMessageId)
    : -1;

  // Your OWN new message always follows to the bottom — even if the view had
  // drifted above Virtuoso's at-bottom threshold, where plain followOutput
  // would leave what you just sent hidden below the fold. Others' messages
  // follow only when already at the bottom, so a reading position is never
  // yanked away. Computed at render so the followOutput callback Virtuoso
  // invokes for THIS data change sees the matching verdict.
  const lastMessage = messages[messages.length - 1];
  const lastIsNewOwn =
    !windowReplaced &&
    !!lastMessage && lastMessage.id !== prevLastIdRef.current && lastMessage.author.id === user?.id;
  useEffect(() => {
    prevLastIdRef.current = lastMessage?.id ?? null;
  });

  // Load older messages when scrolled to top
  const handleStartReached = useCallback(() => {
    if (!hasMore || isLoading || fetchingRef.current || !activeChannelId || messages.length === 0) return;
    fetchingRef.current = true;
    const oldestMessage = messages[0];
    fetchMessages(activeChannelId, oldestMessage.createdAt).finally(() => {
      fetchingRef.current = false;
    });
  }, [hasMore, isLoading, activeChannelId, messages, fetchMessages]);

  const handleAtBottomChange = useCallback((bottom: boolean) => {
    setShowScrollButton(!bottom);
  }, []);

  // Group messages by author for compact display
  const shouldShowHeader = (index: number) => {
    if (index === 0) return true;
    const prev = messages[index - 1];
    const curr = messages[index];
    if (curr.replyToId) return true;
    if (prev.author.id !== curr.author.id) return true;
    const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
    return timeDiff > 5 * 60 * 1000;
  };

  const typingText = (() => {
    const names = Array.from(typingUsers.values());
    if (names.length === 0) return null;
    if (names.length === 1) return t('chat.typing', { user: names[0] });
    if (names.length === 2) return t('chat.typingTwo', { user1: names[0], user2: names[1] });
    return t('chat.typingMany', { user: names[0], count: names.length - 1 });
  })();

  const scrollToBottom = () => {
    // Inside a jumped-to history window the newest messages aren't loaded —
    // "back to bottom" must return to NOW, not to the window's edge.
    if (hasMoreAfter && activeChannelId) {
      fetchMessages(activeChannelId);
      return;
    }
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {isLoading && messages.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
        </div>
      )}

      {messages.length > 0 && (
        <Virtuoso
          key={epochRef.current}
          ref={virtuosoRef}
          data={messages}
          // Horizontal padding must live on the rows, NOT here: Virtuoso's item
          // list is absolutely positioned, so width:100% resolves against the
          // scroller's padding box and scroller padding pushes every row (and
          // the right-anchored hover toolbar) past the panel's right edge.
          className="h-full !overflow-x-hidden"
          followOutput={(bottom) =>
            // A pending jump target owns the scroll position — a fresh mount's
            // follow tick briefly reads as "at bottom" and would override it.
            targetIndex >= 0 ? false : lastIsNewOwn ? 'auto' : bottom ? 'smooth' : false
          }
          startReached={handleStartReached}
          atBottomStateChange={handleAtBottomChange}
          atBottomThreshold={100}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          firstItemIndex={firstIndexRef.current}
          initialTopMostItemIndex={
            targetIndex >= 0
              ? { index: targetIndex, align: 'center' }
              : Math.max(0, messages.length - 1)
          }
          itemContent={(index, message) => {
            // During a window replace, Virtuoso's prop snapshot and our index
            // base can disagree for one frame — recover the true index from
            // the message itself rather than crash on stale math.
            let dataIndex = index - firstIndexRef.current;
            if (dataIndex < 0 || dataIndex >= messages.length || messages[dataIndex] !== message) {
              dataIndex = messages.indexOf(message);
            }
            if (dataIndex === -1) return <div className="h-px" />;
            const showHeader = shouldShowHeader(dataIndex);
            const isOwn = message.author.id === user?.id;
            // Day separator: above the first message of each calendar day.
            // For the oldest LOADED message we only know it starts a day once
            // the full history is here (hasMore=false) — otherwise older
            // messages of the same day may still be unfetched above it.
            const startsDay = dataIndex === 0
              ? !hasMore
              : isNewDay(messages[dataIndex - 1]?.createdAt, message.createdAt);

            return (
              <div key={message.id} className="w-full px-6">
                {startsDay && <DaySeparatorRow iso={message.createdAt} />}
                <MessageItem
                  message={message}
                  showHeader={showHeader}
                  addTopMargin={showHeader && dataIndex > 0 && !startsDay}
                  isOwn={isOwn}
                  canDelete={isOwn || canModerate}
                  channelId={activeChannelId!}
                />
              </div>
            );
          }}
          components={{
            Header: () =>
              !hasMore && messages.length > 0 ? (
                <div className="mb-2 w-full px-6 pb-2 pt-5">
                  <h4 className="text-xl font-semibold tracking-[-0.01em] text-vox-text-primary">Welcome to the channel!</h4>
                  <p className="mt-0.5 text-[13px] text-vox-text-secondary">This is the beginning of the conversation.</p>
                </div>
              ) : null,
            Footer: () => (
              <div className="px-6 pb-2">
                <div className={`flex items-center gap-2 px-4 py-1 ${typingText ? 'visible' : 'invisible'}`}>
                  <div className="flex gap-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-vox-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-xs text-vox-text-muted">{typingText ?? '\u00A0'}</span>
                </div>
              </div>
            ),
          }}
        />
      )}

      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-vox-bg-tertiary text-vox-text-secondary shadow-lg hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}
