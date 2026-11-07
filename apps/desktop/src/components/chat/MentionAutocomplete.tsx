import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore } from '../../stores/serverStore';
import { api } from '../../services/api';
import { Avatar } from '../common/Avatar';
import { Users } from 'lucide-react';
import type { ServerMember } from '@voxium/shared';

/**
 * A row of the dropdown: a member, or the `@everyone` token — offered only
 * when the composer says the author may ping the channel (MENTION_EVERYONE;
 * the server decides again on send, so this is a courtesy, not the check).
 */
export type MentionCandidate =
  | { kind: 'member'; member: ServerMember }
  | { kind: 'everyone' };

interface Props {
  /** Current full text of the textarea */
  text: string;
  /** Cursor position in the textarea */
  cursorPos: number;
  /** Whether to offer the `@everyone` row. */
  canMentionEveryone?: boolean;
  /** Called when user selects a member from the dropdown */
  onSelect: (userId: string, displayName: string, mentionStart: number, mentionEnd: number) => void;
  /** Called when the user selects the `@everyone` row. */
  onSelectEveryone?: (mentionStart: number, mentionEnd: number) => void;
  /** Called when the autocomplete is dismissed */
  onClose: () => void;
  /** Callback to sync results with parent for keyboard handling */
  onResultsChange: (results: MentionCandidate[]) => void;
}

/**
 * Find the @mention query at the cursor position.
 * Returns null if cursor is not in a mention context.
 */
function getMentionQuery(text: string, cursorPos: number): { query: string; start: number } | null {
  // Walk backwards from cursor to find @
  let i = cursorPos - 1;
  while (i >= 0) {
    const ch = text[i];
    // Stop at whitespace or newline — no mention
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') return null;
    if (ch === '@') {
      // Found @. The query is everything between @ and cursor.
      const query = text.slice(i + 1, cursorPos);
      // Don't trigger for @[ which is an already-completed mention
      if (query.startsWith('[')) return null;
      return { query, start: i };
    }
    i--;
  }
  return null;
}

/** Whether the `@everyone` row belongs in the list for this query. */
function everyoneMatches(query: string): boolean {
  return 'everyone'.startsWith(query.toLowerCase());
}

export function MentionAutocomplete({ text, cursorPos, canMentionEveryone = false, onSelect, onSelectEveryone, onClose, onResultsChange }: Props) {
  const { t } = useTranslation();
  const activeServerId = useServerStore((s) => s.activeServerId);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onResultsChangeRef = useRef(onResultsChange);
  onResultsChangeRef.current = onResultsChange;

  const mention = getMentionQuery(text, cursorPos);
  const offerEveryone = !!mention && canMentionEveryone && everyoneMatches(mention.query);

  /** The rows, in display order: the `@everyone` token first when offered, then the members. */
  function buildCandidates(): MentionCandidate[] {
    return [
      ...(offerEveryone ? [{ kind: 'everyone' } as const] : []),
      ...members.map((member) => ({ kind: 'member', member } as const)),
    ];
  }
  const candidates = buildCandidates();

  // The parent drives the keyboard from the same list the user sees
  useEffect(() => {
    onResultsChangeRef.current([
      ...(offerEveryone ? [{ kind: 'everyone' } as const] : []),
      ...members.map((member) => ({ kind: 'member', member } as const)),
    ]);
  }, [members, offerEveryone]);

  // Debounced server-side search
  useEffect(() => {
    if (!mention || !activeServerId || mention.query.length === 0) {
      // Cancel any in-flight request when mention context is lost
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setMembers([]);
      return;
    }

    // Cancel previous debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = mention.query;
    const serverId = activeServerId;

    debounceRef.current = setTimeout(async () => {
      // Cancel previous in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsSearching(true);
      try {
        const { data } = await api.get(
          `/servers/${serverId}/members/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setMembers(data.data ?? []);
          setSelectedIndex(0);
        }
      } catch (err) {
        // An aborted request is the expected end of a superseded search; a
        // failed one leaves the list as it was (the user keeps typing)
        if (!controller.signal.aborted) console.warn('[Mentions] Member search failed:', err instanceof Error ? err.message : err);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 150); // 150ms debounce — fast enough to feel responsive

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mention?.query, activeServerId]); // Only re-trigger on query/serverId changes

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-mention-item]');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback((candidate: MentionCandidate) => {
    if (!mention) return;
    const mentionEnd = mention.start + 1 + mention.query.length;
    if (candidate.kind === 'everyone') onSelectEveryone?.(mention.start, mentionEnd);
    else onSelect(candidate.member.user.id, candidate.member.user.displayName, mention.start, mentionEnd);
  }, [mention, onSelect, onSelectEveryone]);

  // If no mention context, close
  useEffect(() => {
    if (!mention) onClose();
  }, [mention, onClose]);

  if (!mention) return null;

  // Show the dropdown even while loading (for perceived speed)
  if (candidates.length === 0 && !isSearching) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-52 overflow-y-auto rounded-lg border border-vox-border bg-vox-bg-secondary shadow-xl"
      ref={listRef}
      data-testid="mention-autocomplete"
    >
      <div className="px-2 py-1.5 text-[11px] font-semibold uppercase text-vox-text-muted">
        {t('chat.mentionAutocomplete.header', { query: mention.query })}
      </div>
      {members.length === 0 && isSearching && (
        <div className="px-2 py-2 text-xs text-vox-text-muted">{t('chat.mentionAutocomplete.searching')}</div>
      )}
      {candidates.map((candidate, i) => (
        <button
          key={candidate.kind === 'everyone' ? 'everyone' : candidate.member.userId}
          data-mention-item
          data-testid={candidate.kind === 'everyone' ? 'mention-everyone-option' : undefined}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent textarea blur
            handleSelect(candidate);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
          className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
            i === selectedIndex ? 'bg-vox-accent-primary/20 text-vox-text-primary' : 'text-vox-text-secondary hover:bg-vox-bg-hover'
          }`}
        >
          {candidate.kind === 'everyone' ? (
            <>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-vox-accent-primary/20 text-vox-accent-primary">
                <Users size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{t('chat.mentionEveryone.label')}</span>
                <span className="ml-1.5 text-xs text-vox-text-muted">{t('chat.mentionEveryone.description')}</span>
              </div>
            </>
          ) : (
            <>
              <Avatar avatarUrl={candidate.member.user.avatarUrl} displayName={candidate.member.user.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{candidate.member.user.displayName}</span>
                <span className="ml-1.5 text-xs text-vox-text-muted">@{candidate.member.user.username}</span>
              </div>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** Keyboard handler for mention autocomplete. Returns true if the key was consumed. */
export function handleMentionKeyDown(
  e: React.KeyboardEvent,
  results: MentionCandidate[],
  selectedIndex: number,
  setSelectedIndex: (i: number) => void,
  onSelect: (candidate: MentionCandidate) => void,
): boolean {
  if (results.length === 0) return false;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSelectedIndex(selectedIndex > 0 ? selectedIndex - 1 : results.length - 1);
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSelectedIndex(selectedIndex < results.length - 1 ? selectedIndex + 1 : 0);
    return true;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    onSelect(results[selectedIndex]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    return true;
  }
  return false;
}

export { getMentionQuery, everyoneMatches };
