import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../services/api';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { Avatar } from '../common/Avatar';
import { Search, X, Hash } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import type { SearchResult, Channel } from '@voxium/shared';

interface SearchModalProps {
  onClose: () => void;
  serverId?: string;
  channels?: Channel[];
  conversationId?: string;
  participantName?: string;
}

export function SearchModal({ onClose, serverId, channels, conversationId, participantName }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [channelFilter, setChannelFilter] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const textChannels = channels?.filter((c) => c.type === 'text') ?? [];

  // Auto-focus input + cleanup in-flight requests on unmount
  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const doSearch = useCallback(async (searchQuery: string, beforeCursor?: string) => {
    if (searchQuery.length < 2) {
      if (!beforeCursor) {
        setResults([]);
        setHasMore(false);
        setHasSearched(false);
      }
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    try {
      const params = new URLSearchParams({ q: searchQuery });
      if (beforeCursor) params.set('before', beforeCursor);
      if (channelFilter) params.set('channelId', channelFilter);

      const url = serverId
        ? `/search/servers/${serverId}/messages?${params}`
        : `/search/dm/${conversationId}/messages?${params}`;

      const { data } = await api.get(url, { signal: controller.signal });

      if (controller.signal.aborted) return;

      if (beforeCursor) {
        setResults((prev) => [...prev, ...data.data]);
      } else {
        setResults(data.data);
      }
      setHasMore(data.hasMore);
      setHasSearched(true);
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  }, [serverId, conversationId, channelFilter]);

  // Debounced search on query change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  // Re-search when channel filter changes
  useEffect(() => {
    if (query.length >= 2) {
      doSearch(query);
    }
  }, [channelFilter]);

  const handleLoadMore = () => {
    if (!hasMore || results.length === 0) return;
    const lastResult = results[results.length - 1];
    doSearch(query, lastResult.createdAt);
  };

  const handleResultClick = async (result: SearchResult) => {
    onClose();

    if (serverId && result.channelId) {
      // Server mode: navigate to the channel, then fetch around
      const { activeChannelId, setActiveChannel } = useServerStore.getState();
      if (activeChannelId !== result.channelId) {
        setActiveChannel(result.channelId);
      }
      // Small delay to let channel switch take effect
      await new Promise((r) => setTimeout(r, 50));
      useChatStore.getState().fetchMessagesAround(result.channelId, result.id);
    } else if (conversationId) {
      // DM mode: ensure we're viewing this conversation, then fetch around
      const { activeConversationId, setActiveConversation } = useDMStore.getState();
      if (activeConversationId !== conversationId) {
        setActiveConversation(conversationId);
      }
      await new Promise((r) => setTimeout(r, 50));
      useChatStore.getState().fetchDMMessagesAround(conversationId, result.id);
    }
  };

  const handleScroll = () => {
    const el = resultsRef.current;
    if (!el || !hasMore || isSearching) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      handleLoadMore();
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) return `Today at ${format(date, 'h:mm a')}`;
    if (isYesterday(date)) return `Yesterday at ${format(date, 'h:mm a')}`;
    return format(date, 'MM/dd/yyyy h:mm a');
  };

  const truncate = (text: string, max: number) => {
    return text.length > max ? text.slice(0, max) + '...' : text;
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center" style={{ paddingTop: '15vh' }}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 flex h-fit max-h-[70vh] w-full max-w-2xl flex-col rounded-lg bg-vox-bg-primary shadow-2xl border border-vox-border">
        {/* Search Header */}
        <div className="flex items-center gap-2 border-b border-vox-border px-4 py-3">
          <Search size={18} className="shrink-0 text-vox-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={serverId ? 'Search messages in this server...' : `Search messages with ${participantName || 'this user'}...`}
            className="flex-1 bg-transparent text-sm text-vox-text-primary outline-none placeholder:text-vox-text-muted"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-vox-text-muted hover:text-vox-text-primary">
              <X size={16} />
            </button>
          )}
          <button onClick={onClose} className="ml-1 rounded px-2 py-0.5 text-xs text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary">
            ESC
          </button>
        </div>

        {/* Channel filter (server mode only) */}
        {serverId && textChannels.length > 1 && (
          <div className="flex items-center gap-2 border-b border-vox-border px-4 py-2">
            <Hash size={14} className="text-vox-text-muted" />
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="bg-vox-bg-secondary text-xs text-vox-text-secondary rounded px-2 py-1 outline-none border border-vox-border"
            >
              <option value="">All channels</option>
              {textChannels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Results */}
        <div
          ref={resultsRef}
          className="flex-1 overflow-y-auto"
          onScroll={handleScroll}
        >
          {isSearching && results.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
            </div>
          )}

          {!isSearching && hasSearched && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-vox-text-muted">
              <Search size={32} className="mb-2 opacity-40" />
              <p className="text-sm">No results found</p>
            </div>
          )}

          {!hasSearched && !isSearching && (
            <div className="flex flex-col items-center justify-center py-8 text-vox-text-muted">
              <Search size={32} className="mb-2 opacity-40" />
              <p className="text-sm">Type to search messages</p>
            </div>
          )}

          {results.map((result) => (
            <button
              key={result.id}
              onClick={() => handleResultClick(result)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-vox-bg-hover transition-colors border-b border-vox-border/50 last:border-b-0"
            >
              <Avatar
                avatarUrl={result.author.avatarUrl}
                displayName={result.author.displayName}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-vox-text-primary">
                    {result.author.displayName}
                  </span>
                  {result.channelName && (
                    <span className="flex items-center gap-0.5 text-xs text-vox-text-muted">
                      <Hash size={10} />
                      {result.channelName}
                    </span>
                  )}
                  <span className="text-[11px] text-vox-text-muted ml-auto shrink-0">
                    {formatTime(result.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-vox-text-secondary leading-snug">
                  {truncate(result.content, 150)}
                </p>
              </div>
            </button>
          ))}

          {isSearching && results.length > 0 && (
            <div className="flex items-center justify-center py-4">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
