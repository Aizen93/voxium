import { useEffect, useRef, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import EmojiPickerReact, { Theme, EmojiStyle, type EmojiClickData } from 'emoji-picker-react';
import { useEmojiStore } from '../../stores/emojiStore';
import { useStickerStore } from '../../stores/stickerStore';
import { useGifStore } from '../../stores/gifStore';
import { useServerStore } from '../../stores/serverStore';
import { api } from '../../services/api';
import { toast } from '../../stores/toastStore';
import { LIMITS, ALLOWED_EMOJI_TYPES } from '@voxium/shared';
import type { CustomEmoji, StickerData, StickerPackData, GiphyGif, GifUploadData } from '@voxium/shared';
import { Smile, Star, Image, Film, Plus, Trash2, ArrowLeft, Upload, Search, X } from 'lucide-react';

const PICKER_WIDTH = 420;
const PICKER_HEIGHT = 460;
const GAP = 8;
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

type PickerTab = 'emoji' | 'stickers' | 'gif';

interface Props {
  onEmojiSelect: (emoji: string) => void;
  onStickerSelect?: (stickerId: string) => void;
  onGifSelect?: (gif: GiphyGif | GifUploadData) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  mode?: 'full' | 'emoji-only';
}

// ─── Main Picker ───────────────────────────────────────────────────────────

export function EmojiPicker({ onEmojiSelect, onStickerSelect, onGifSelect, onClose, anchorRef, mode = 'full' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [activeTab, setActiveTab] = useState<PickerTab>('emoji');

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    let top: number;
    if (vh - rect.bottom >= PICKER_HEIGHT + GAP) top = rect.bottom + GAP;
    else if (rect.top >= PICKER_HEIGHT + GAP) top = rect.top - PICKER_HEIGHT - GAP;
    else top = vh - rect.bottom >= rect.top ? Math.max(GAP, vh - PICKER_HEIGHT - GAP) : GAP;

    let left = rect.right - PICKER_WIDTH;
    if (left < GAP) left = GAP;
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP;
    setPosition({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [updatePosition]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('mousedown', handleMouseDown); document.removeEventListener('keydown', handleKeyDown); };
  }, [onClose]);

  if (!position) return null;

  const showStickers = mode === 'full' && !!onStickerSelect;
  const showGifs = mode === 'full' && !!onGifSelect;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-50 rounded-xl overflow-hidden shadow-2xl border border-vox-border bg-vox-bg-floating flex flex-col"
      style={{ top: position.top, left: position.left, width: PICKER_WIDTH, height: PICKER_HEIGHT }}
    >
      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'emoji' && (
          <EmojiTabContent
            onEmojiSelect={onEmojiSelect}
            onCustomSelect={(emoji) => onEmojiSelect(`<:${emoji.name}:${emoji.id}>`)}
          />
        )}
        {activeTab === 'stickers' && showStickers && (
          <StickerTabContent onSelect={(s) => onStickerSelect!(s.id)} />
        )}
        {activeTab === 'gif' && showGifs && (
          <GifTabContent onSelect={onGifSelect!} />
        )}
      </div>

      {/* Bottom tab bar — WhatsApp style */}
      {(showStickers || showGifs) && (
        <div className="flex items-center border-t border-vox-border bg-vox-bg-secondary shrink-0">
          <TabButton icon={<Smile size={18} />} label="Emoji" active={activeTab === 'emoji'} onClick={() => setActiveTab('emoji')} />
          {showStickers && <TabButton icon={<Star size={18} />} label="Stickers" active={activeTab === 'stickers'} onClick={() => setActiveTab('stickers')} />}
          {showGifs && <TabButton icon={<Film size={18} />} label="GIF" active={activeTab === 'gif'} onClick={() => setActiveTab('gif')} />}
        </div>
      )}
    </div>,
    document.body,
  );
}

function TabButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center gap-0.5 py-2 transition-colors ${
        active ? 'text-vox-accent-primary' : 'text-vox-text-muted hover:text-vox-text-secondary'
      }`}
    >
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

// ─── Emoji Tab (Standard + Custom merged) ──────────────────────────────────

function EmojiTabContent({ onEmojiSelect, onCustomSelect }: {
  onEmojiSelect: (emoji: string) => void;
  onCustomSelect: (emoji: CustomEmoji) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [search, setSearch] = useState('');
  const emojisByServer = useEmojiStore((s) => s.emojisByServer);
  const hasCustom = emojisByServer.size > 0;

  if (showCustom) {
    return (
      <CustomEmojiView
        search={search}
        onSearchChange={setSearch}
        onSelect={onCustomSelect}
        onBack={() => { setShowCustom(false); setSearch(''); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <EmojiPickerReact
        theme={Theme.DARK}
        emojiStyle={EmojiStyle.TWITTER}
        width={PICKER_WIDTH}
        height={PICKER_HEIGHT - (hasCustom ? 82 : 44)}
        lazyLoadEmojis
        onEmojiClick={(d: EmojiClickData) => onEmojiSelect(d.emoji)}
        searchPlaceholder="Search emoji..."
      />
      {hasCustom && (
        <button
          onClick={() => setShowCustom(true)}
          className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-vox-border text-xs text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
        >
          <Star size={14} className="text-vox-accent-primary" />
          <span>Custom Server Emojis</span>
          <span className="ml-auto text-vox-text-muted">
            {Array.from(emojisByServer.values()).reduce((n, arr) => n + arr.length, 0)}
          </span>
        </button>
      )}
    </div>
  );
}

function CustomEmojiView({ search, onSearchChange, onSelect, onBack }: {
  search: string; onSearchChange: (s: string) => void;
  onSelect: (emoji: CustomEmoji) => void; onBack: () => void;
}) {
  const emojisByServer = useEmojiStore((s) => s.emojisByServer);
  const getEmojiImageUrl = useEmojiStore((s) => s.getEmojiImageUrl);
  const servers = useServerStore((s) => s.servers);

  const filtered = useMemo(() => {
    const result: { serverName: string; emojis: CustomEmoji[] }[] = [];
    for (const [serverId, emojis] of emojisByServer) {
      const server = servers.find((s) => s.id === serverId);
      const matching = search ? emojis.filter((e) => e.name.toLowerCase().includes(search.toLowerCase())) : emojis;
      if (matching.length > 0) result.push({ serverName: server?.name || 'Unknown', emojis: matching });
    }
    return result;
  }, [emojisByServer, servers, search]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vox-border shrink-0">
        <button onClick={onBack} className="text-vox-text-muted hover:text-vox-text-primary transition-colors"><ArrowLeft size={16} /></button>
        <div className="flex-1 flex items-center gap-2 bg-vox-bg-tertiary rounded-md px-2 py-1">
          <Search size={14} className="text-vox-text-muted shrink-0" />
          <input
            type="text" value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search custom emojis..." autoFocus
            className="flex-1 bg-transparent text-sm text-vox-text-primary focus:outline-none"
          />
          {search && <button onClick={() => onSearchChange('')} className="text-vox-text-muted hover:text-vox-text-primary"><X size={12} /></button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <div className="text-center text-vox-text-muted text-sm py-10">{search ? 'No matches' : 'No custom emojis'}</div>
        )}
        {filtered.map(({ serverName, emojis }) => (
          <div key={serverName} className="mb-3">
            <div className="text-[11px] font-semibold text-vox-text-muted uppercase tracking-wider mb-1.5 px-1">{serverName}</div>
            <div className="flex flex-wrap gap-0.5">
              {emojis.map((emoji) => (
                <button key={emoji.id} onClick={() => onSelect(emoji)} title={`:${emoji.name}:`}
                  className="w-9 h-9 rounded-md hover:bg-vox-bg-hover flex items-center justify-center transition-all hover:scale-110">
                  <img src={getEmojiImageUrl(emoji)} alt={emoji.name} className="w-7 h-7 object-contain" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sticker Tab ───────────────────────────────────────────────────────────

function StickerTabContent({ onSelect }: { onSelect: (sticker: StickerData) => void }) {
  const [view, setView] = useState<'browse' | 'manage'>('browse');

  if (view === 'manage') return <StickerManager onBack={() => setView('browse')} />;
  return <StickerBrowser onSelect={onSelect} onManage={() => setView('manage')} />;
}

function StickerBrowser({ onSelect, onManage }: { onSelect: (sticker: StickerData) => void; onManage: () => void }) {
  const serverPacks = useStickerStore((s) => s.serverPacks);
  const personalPacks = useStickerStore((s) => s.personalPacks);
  const getStickerImageUrl = useStickerStore((s) => s.getStickerImageUrl);
  const allPacks = useMemo(() => [...personalPacks, ...serverPacks], [personalPacks, serverPacks]);
  const servers = useServerStore((s) => s.servers);

  return (
    <div className="flex flex-col h-full">
      {/* Header with manage button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-vox-border shrink-0">
        <span className="text-sm font-semibold text-vox-text-primary">Stickers</span>
        <button onClick={onManage}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors">
          <Plus size={12} /> My Stickers
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {allPacks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-vox-text-muted gap-2 px-6">
            <Image size={32} className="opacity-40" />
            <p className="text-sm text-center">No sticker packs yet</p>
            <button onClick={onManage}
              className="text-xs text-vox-accent-primary hover:underline">Create your first pack</button>
          </div>
        ) : (
          allPacks.map((pack) => {
            const server = pack.serverId ? servers.find((s) => s.id === pack.serverId) : null;
            const label = server ? server.name : 'My Stickers';
            return (
              <div key={pack.id} className="px-2 pt-2">
                <div className="text-[11px] font-semibold text-vox-text-muted uppercase tracking-wider mb-1.5 px-1">
                  {pack.name} <span className="font-normal opacity-70">/ {label}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 pb-2">
                  {pack.stickers.map((sticker) => (
                    <button key={sticker.id} onClick={() => onSelect(sticker)} title={sticker.name}
                      className="aspect-square rounded-lg bg-vox-bg-tertiary hover:bg-vox-bg-hover flex items-center justify-center p-1.5 transition-all hover:scale-105">
                      <img src={getStickerImageUrl(sticker)} alt={sticker.name} className="w-full h-full object-contain" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StickerManager({ onBack }: { onBack: () => void }) {
  const personalPacks = useStickerStore((s) => s.personalPacks);
  const getStickerImageUrl = useStickerStore((s) => s.getStickerImageUrl);
  const [newPackName, setNewPackName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreatePack = async () => {
    if (!newPackName.trim()) return;
    setCreating(true);
    try {
      await api.post('/stickers/personal', { name: newPackName.trim() });
      setNewPackName('');
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to create pack');
    } finally {
      setCreating(false);
    }
  };

  const handleDeletePack = async (packId: string) => {
    if (!confirm('Delete this sticker pack and all its stickers?')) return;
    try { await api.delete(`/stickers/personal/${packId}`); }
    catch { toast.error('Failed to delete pack'); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vox-border shrink-0">
        <button onClick={onBack} className="text-vox-text-muted hover:text-vox-text-primary transition-colors"><ArrowLeft size={16} /></button>
        <span className="text-sm font-semibold text-vox-text-primary">My Sticker Packs</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* Create pack — clean inline form */}
        <div className="flex items-center gap-2 mb-4">
          <input type="text" value={newPackName} onChange={(e) => setNewPackName(e.target.value)}
            placeholder="New pack name..." maxLength={50}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreatePack(); }}
            className="flex-1 px-3 py-1.5 rounded-lg bg-vox-bg-tertiary text-sm text-vox-text-primary border border-vox-border focus:outline-none focus:border-vox-accent-primary" />
          <button onClick={handleCreatePack} disabled={creating || !newPackName.trim()}
            className="px-3 py-1.5 rounded-lg bg-vox-accent-primary text-white text-sm font-medium hover:bg-vox-accent-hover disabled:opacity-40 transition-colors">
            {creating ? '...' : 'Create'}
          </button>
        </div>

        {personalPacks.length === 0 && (
          <div className="text-center text-vox-text-muted text-sm py-8">
            Create a pack to start adding stickers
          </div>
        )}
        {personalPacks.map((pack) => (
          <PackEditor key={pack.id} pack={pack} getStickerImageUrl={getStickerImageUrl} onDeletePack={handleDeletePack} />
        ))}
      </div>
    </div>
  );
}

function PackEditor({ pack, getStickerImageUrl, onDeletePack }: {
  pack: StickerPackData; getStickerImageUrl: (s: StickerData) => string; onDeletePack: (id: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Simplified: auto-derive name from file name, no separate name field
  const handleAddSticker = async (file: File) => {
    if (!ALLOWED_EMOJI_TYPES.includes(file.type as typeof ALLOWED_EMOJI_TYPES[number])) { toast.error('Only PNG, WebP, or GIF'); return; }
    if (file.size > LIMITS.MAX_STICKER_FILE_SIZE) { toast.error(`Max ${LIMITS.MAX_STICKER_FILE_SIZE / 1024}KB`); return; }

    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 32) || 'sticker';
    setUploading(true);
    try {
      const { data: presignData } = await api.post(`/uploads/presign/sticker/${pack.id}`, { fileName: file.name, fileSize: file.size, mimeType: file.type });
      await fetch(presignData.data.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      await api.post(`/stickers/personal/${pack.id}/stickers`, { name, s3Key: presignData.data.key });
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to add sticker');
    } finally { setUploading(false); }
  };

  const handleDeleteSticker = async (stickerId: string) => {
    try { await api.delete(`/stickers/personal/${pack.id}/stickers/${stickerId}`); }
    catch { toast.error('Failed to remove sticker'); }
  };

  return (
    <div className="mb-4 rounded-lg border border-vox-border bg-vox-bg-secondary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-vox-bg-tertiary/50">
        <span className="text-xs font-bold text-vox-text-primary">{pack.name}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-vox-text-muted">{pack.stickers.length}/{LIMITS.MAX_STICKERS_PER_PACK}</span>
          <button onClick={() => onDeletePack(pack.id)} className="text-vox-text-muted hover:text-vox-accent-danger transition-colors" title="Delete pack"><Trash2 size={12} /></button>
        </div>
      </div>

      <div className="p-2">
        {/* Sticker grid with add button */}
        <div className="grid grid-cols-4 gap-1">
          {pack.stickers.map((s) => (
            <div key={s.id} className="relative group aspect-square rounded-lg bg-vox-bg-tertiary flex items-center justify-center p-1">
              <img src={getStickerImageUrl(s)} alt={s.name} title={s.name} className="w-full h-full object-contain" loading="lazy" />
              <button onClick={() => handleDeleteSticker(s.id)}
                className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 bg-vox-accent-danger text-white rounded-full w-4 h-4 flex items-center justify-center transition-opacity shadow-sm">
                <X size={10} />
              </button>
            </div>
          ))}
          {/* Add sticker button — the big + tile */}
          {pack.stickers.length < LIMITS.MAX_STICKERS_PER_PACK && (
            <>
              <input ref={fileRef} type="file" accept=".png,.webp,.gif" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAddSticker(f); e.target.value = ''; }} />
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="aspect-square rounded-lg border-2 border-dashed border-vox-border hover:border-vox-accent-primary flex flex-col items-center justify-center gap-0.5 transition-colors disabled:opacity-40">
                {uploading ? (
                  <div className="w-4 h-4 border-2 border-vox-accent-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <Upload size={14} className="text-vox-text-muted" />
                    <span className="text-[9px] text-vox-text-muted">Add</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── GIF Tab ───────────────────────────────────────────────────────────────

function GifTabContent({ onSelect }: { onSelect: (gif: GiphyGif | GifUploadData) => void }) {
  const giphyEnabled = useGifStore((s) => s.giphyEnabled);
  const giphyResults = useGifStore((s) => s.giphyResults);
  const giphyTrending = useGifStore((s) => s.giphyTrending);
  const giphyQuery = useGifStore((s) => s.giphyQuery);
  const libraryResults = useGifStore((s) => s.libraryResults);
  const isSearching = useGifStore((s) => s.isSearching);
  const searchGiphy = useGifStore((s) => s.searchGiphy);
  const fetchGiphyTrending = useGifStore((s) => s.fetchGiphyTrending);
  const searchLibrary = useGifStore((s) => s.searchLibrary);
  const clearSearch = useGifStore((s) => s.clearSearch);

  const [source, setSource] = useState<'library' | 'giphy'>('library');
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (source === 'giphy' && giphyEnabled && giphyTrending.length === 0) fetchGiphyTrending();
    if (source === 'library' && libraryResults.length === 0) searchLibrary('');
  }, [source, giphyEnabled, giphyTrending.length, libraryResults.length, fetchGiphyTrending, searchLibrary]);

  useEffect(() => { return () => { if (debounceRef.current) clearTimeout(debounceRef.current); }; }, []);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) { clearSearch(); if (source === 'library') searchLibrary(''); return; }
    debounceRef.current = setTimeout(() => {
      if (source === 'giphy') searchGiphy(value); else searchLibrary(value);
    }, 300);
  };

  const switchSource = (s: 'library' | 'giphy') => { setSource(s); setQuery(''); clearSearch(); if (s === 'library') searchLibrary(''); };

  const gifs = source === 'giphy' ? (giphyQuery ? giphyResults : giphyTrending) : libraryResults;

  return (
    <div className="flex flex-col h-full">
      {/* Header: search + source toggle */}
      <div className="px-3 pt-2 pb-1 shrink-0 space-y-1.5">
        <div className="flex items-center gap-2 bg-vox-bg-tertiary rounded-lg px-2.5 py-1.5">
          <Search size={14} className="text-vox-text-muted shrink-0" />
          <input type="text" value={query} onChange={(e) => handleSearch(e.target.value)}
            placeholder={source === 'giphy' ? 'Search Giphy...' : 'Search GIF library...'}
            className="flex-1 bg-transparent text-sm text-vox-text-primary focus:outline-none" />
          {query && <button onClick={() => handleSearch('')} className="text-vox-text-muted hover:text-vox-text-primary"><X size={12} /></button>}
        </div>
        {giphyEnabled && (
          <div className="flex gap-1">
            <SourcePill label="Library" active={source === 'library'} onClick={() => switchSource('library')} />
            <SourcePill label="Giphy" active={source === 'giphy'} onClick={() => switchSource('giphy')} />
          </div>
        )}
      </div>

      {/* GIF grid */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isSearching && gifs.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-vox-accent-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!isSearching && gifs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-vox-text-muted gap-1">
            <Film size={24} className="opacity-40" />
            <span className="text-sm">{query ? 'No GIFs found' : source === 'library' ? 'No GIFs in library yet' : 'No trending GIFs'}</span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          {gifs.map((gif) => {
            const isGiphy = 'url' in gif;
            const src = isGiphy ? (gif as GiphyGif).previewUrl : `${API_URL}/uploads/${(gif as GifUploadData).s3Key}?inline`;
            const alt = isGiphy ? (gif as GiphyGif).title : (gif as GifUploadData).fileName;
            return (
              <button key={gif.id} onClick={() => onSelect(gif)}
                className="rounded-lg overflow-hidden bg-vox-bg-tertiary hover:ring-2 hover:ring-vox-accent-primary transition-all">
                <img src={src} alt={alt} className="w-full h-auto object-cover" loading="lazy" style={{ minHeight: 80, maxHeight: 150 }} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SourcePill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
        active ? 'bg-vox-accent-primary text-white' : 'bg-vox-bg-tertiary text-vox-text-muted hover:text-vox-text-primary'
      }`}>
      {label}
    </button>
  );
}
