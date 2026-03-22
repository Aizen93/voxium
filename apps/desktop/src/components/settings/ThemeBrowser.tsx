import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Download, Trash2, Eye, ChevronDown, Loader2 } from 'lucide-react';
import type { CommunityTheme } from '@voxium/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ThemeId } from '../../stores/settingsStore';
import { applyCustomThemeColors, clearCustomThemeColors, applyCustomPatterns } from '../../services/themeEngine';
import { api } from '../../services/api';
import { toast } from '../../stores/toastStore';

interface ThemeBrowserProps {
  onClose: () => void;
}

type SortOption = 'newest' | 'popular' | 'name';

export function ThemeBrowser({ onClose }: ThemeBrowserProps) {
  const { theme: activeTheme, customThemes, installCustomTheme, uninstallCustomTheme, setTheme } = useSettingsStore();
  const prevThemeRef = useRef<ThemeId>(activeTheme);
  const previewingRef = useRef(false);

  const [themes, setThemes] = useState<CommunityTheme[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('newest');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [previewingName, setPreviewingName] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // Fetch themes
  const fetchThemes = useCallback(async (p: number, append = false) => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page: p, sort, limit: 12 };
      if (debouncedSearch) params.search = debouncedSearch;
      if (tag) params.tag = tag;

      const res = await api.get('/themes', { params });
      const data = res.data;
      if (data.success) {
        setThemes((prev) => append ? [...prev, ...data.data] : data.data);
        setHasMore(data.hasMore);
        setTotal(data.total);
        setPage(p);
      }
    } catch {
      toast.error('Failed to load themes');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, sort, tag]);

  useEffect(() => {
    fetchThemes(1);
  }, [fetchThemes]);

  // Restore theme on close if previewing
  const restoreTheme = useCallback(() => {
    if (!previewingRef.current) return;
    previewingRef.current = false;
    const prev = prevThemeRef.current;
    if (prev.startsWith('custom:')) {
      const localId = prev.slice(7);
      const ct = customThemes.find((t) => t.localId === localId);
      if (ct) {
        applyCustomThemeColors(ct.data.colors);
        applyCustomPatterns(ct.data.patterns);
      } else {
        clearCustomThemeColors();
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } else {
      clearCustomThemeColors();
      document.documentElement.setAttribute('data-theme', prev);
    }
  }, [customThemes]);

  useEffect(() => {
    return () => {
      restoreTheme();
      const settingsEl = document.getElementById('vox-settings-modal');
      if (settingsEl) settingsEl.style.display = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePreview = useCallback((theme: CommunityTheme) => {
    previewingRef.current = true;
    setPreviewingName(theme.name);
    setPreviewingId(theme.id);
    // Hide settings modal so the user sees the full app
    const settingsEl = document.getElementById('vox-settings-modal');
    if (settingsEl) settingsEl.style.display = 'none';
    applyCustomThemeColors(theme.colors);
    applyCustomPatterns(theme.patterns);
  }, []);

  const handleStopPreview = useCallback(() => {
    restoreTheme();
    setPreviewingName(null);
    setPreviewingId(null);
    // Show settings modal again
    const settingsEl = document.getElementById('vox-settings-modal');
    if (settingsEl) settingsEl.style.display = '';
  }, [restoreTheme]);

  const handleInstall = useCallback(async (theme: CommunityTheme) => {
    const localId = installCustomTheme(theme.id, {
      name: theme.name,
      description: theme.description,
      tags: theme.tags,
      colors: theme.colors,
      patterns: theme.patterns,
      version: theme.version,
    });
    try {
      await api.post(`/themes/${theme.id}/install`);
    } catch (err) {
      console.warn('[Themes] Failed to notify install count:', err);
    }
    // Apply as active theme
    previewingRef.current = false;
    prevThemeRef.current = `custom:${localId}`;
    // Restore settings modal visibility since we're leaving preview
    const settingsEl = document.getElementById('vox-settings-modal');
    if (settingsEl) settingsEl.style.display = '';
    setPreviewingName(null);
    setTheme(`custom:${localId}`);
    toast.success(`Installed "${theme.name}"`);
  }, [installCustomTheme, setTheme]);

  const handleUninstall = useCallback(async (theme: CommunityTheme) => {
    const installed = customThemes.find((t) => t.remoteId === theme.id);
    if (!installed) return;
    uninstallCustomTheme(installed.localId);
    try {
      await api.post(`/themes/${theme.id}/uninstall`);
    } catch (err) {
      console.warn('[Themes] Failed to notify uninstall count:', err);
    }
    prevThemeRef.current = useSettingsStore.getState().theme;
    toast.success(`Uninstalled "${theme.name}"`);
  }, [customThemes, uninstallCustomTheme]);

  const isInstalled = useCallback((themeId: string) => {
    return customThemes.some((t) => t.remoteId === themeId);
  }, [customThemes]);

  const handleClose = useCallback(() => {
    restoreTheme();
    onClose();
  }, [restoreTheme, onClose]);

  // When previewing, collapse to a small bottom bar so the user sees the app
  if (previewingName) {
    return createPortal(
      <div
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl"
        style={{
          backgroundColor: 'var(--vox-bg-floating)',
          border: '1px solid var(--vox-border)',
        }}
      >
        <Eye size={14} style={{ color: 'var(--vox-accent-primary)' }} />
        <span className="text-xs font-medium" style={{ color: 'var(--vox-text-primary)' }}>
          Previewing: <span className="font-bold">{previewingName}</span>
        </span>
        <button
          onClick={handleStopPreview}
          className="px-3 py-1 rounded-lg text-xs font-medium text-white"
          style={{ backgroundColor: 'var(--vox-accent-primary)' }}
        >
          Stop Preview
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 'min(900px, 94vw)',
          height: 'min(680px, 90vh)',
          backgroundColor: 'var(--vox-bg-secondary)',
          border: '1px solid var(--vox-border)',
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-3 flex items-center justify-between shrink-0"
          style={{ borderBottom: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-primary)' }}
        >
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--vox-text-primary)' }}>
              Theme Marketplace
            </h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--vox-text-muted)' }}>
              {total} community theme{total !== 1 ? 's' : ''} available
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--vox-text-muted)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Filters */}
        <div
          className="px-5 py-2.5 flex items-center gap-3 shrink-0"
          style={{ borderBottom: '1px solid var(--vox-border)' }}
        >
          {/* Search */}
          <div className="relative flex-1 max-w-[260px]">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--vox-text-muted)' }}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search themes..."
              className="w-full rounded-lg pl-8 pr-3 py-1.5 text-xs outline-none"
              style={{
                backgroundColor: 'var(--vox-bg-floating)',
                border: '1px solid var(--vox-border)',
                color: 'var(--vox-text-primary)',
              }}
            />
          </div>

          {/* Sort */}
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOption)}
              className="appearance-none rounded-lg pl-3 pr-7 py-1.5 text-xs outline-none cursor-pointer"
              style={{
                backgroundColor: 'var(--vox-bg-floating)',
                border: '1px solid var(--vox-border)',
                color: 'var(--vox-text-secondary)',
              }}
            >
              <option value="newest">Newest</option>
              <option value="popular">Popular</option>
              <option value="name">A-Z</option>
            </select>
            <ChevronDown
              size={12}
              className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--vox-text-muted)' }}
            />
          </div>

          {/* Tag filter */}
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Filter by tag..."
            className="rounded-lg px-3 py-1.5 text-xs outline-none w-[140px]"
            style={{
              backgroundColor: 'var(--vox-bg-floating)',
              border: '1px solid var(--vox-border)',
              color: 'var(--vox-text-primary)',
            }}
          />
        </div>

        {/* Theme Grid */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: 'thin' }}>
          {loading && themes.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 size={24} className="animate-spin" style={{ color: 'var(--vox-text-muted)' }} />
            </div>
          ) : themes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2">
              <p className="text-sm" style={{ color: 'var(--vox-text-muted)' }}>No themes found</p>
              <p className="text-xs" style={{ color: 'var(--vox-text-muted)' }}>
                Try a different search or be the first to publish one!
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                {themes.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    installed={isInstalled(theme.id)}
                    previewing={previewingId === theme.id}
                    onPreview={handlePreview}
                    onStopPreview={handleStopPreview}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                  />
                ))}
              </div>

              {hasMore && (
                <div className="flex justify-center mt-4">
                  <button
                    onClick={() => fetchThemes(page + 1, true)}
                    disabled={loading}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{
                      backgroundColor: 'var(--vox-bg-floating)',
                      border: '1px solid var(--vox-border)',
                      color: 'var(--vox-text-secondary)',
                    }}
                  >
                    {loading ? 'Loading...' : 'Load More'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Theme Card ─────────────────────────────────────────────────────────────

function ThemeCard({
  theme,
  installed,
  previewing,
  onPreview,
  onStopPreview,
  onInstall,
  onUninstall,
}: {
  theme: CommunityTheme;
  installed: boolean;
  previewing: boolean;
  onPreview: (theme: CommunityTheme) => void;
  onStopPreview: () => void;
  onInstall: (theme: CommunityTheme) => void;
  onUninstall: (theme: CommunityTheme) => void;
}) {
  const c = theme.colors;

  const togglePreview = useCallback(() => {
    if (previewing) {
      onStopPreview();
    } else {
      onPreview(theme);
    }
  }, [previewing, theme, onPreview, onStopPreview]);

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: previewing ? '2px solid var(--vox-accent-primary)' : '1px solid var(--vox-border)',
        backgroundColor: 'var(--vox-bg-floating)',
      }}
    >
      {/* Mini preview */}
      <div className="h-24 flex overflow-hidden">
        <div className="w-[14%] h-full" style={{ backgroundColor: c.sidebar }} />
        <div className="w-[22%] h-full" style={{ backgroundColor: c.channel }}>
          <div className="mt-3 mx-1.5 space-y-1">
            <div className="h-1 w-3/4 rounded-full" style={{ backgroundColor: c['text-muted'], opacity: 0.4 }} />
            <div className="h-1.5 rounded-sm" style={{ backgroundColor: c['bg-active'] }} />
            <div className="h-1 w-2/3 rounded-full" style={{ backgroundColor: c['text-muted'], opacity: 0.3 }} />
          </div>
        </div>
        <div className="flex-1 h-full p-2 flex flex-col justify-end gap-1" style={{ backgroundColor: c.chat }}>
          <div className="flex gap-1 items-center">
            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c['accent-primary'] }} />
            <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: c['text-primary'], opacity: 0.3 }} />
          </div>
          <div className="flex gap-1 items-center">
            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c['accent-success'] }} />
            <div className="h-1 w-2/3 rounded-full" style={{ backgroundColor: c['text-primary'], opacity: 0.3 }} />
          </div>
          <div className="h-4 rounded-md mt-0.5" style={{ backgroundColor: c['bg-floating'], border: `1px solid ${c.border}` }} />
        </div>
      </div>

      {/* Info */}
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xs font-bold truncate" style={{ color: 'var(--vox-text-primary)' }}>
              {theme.name}
            </h3>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--vox-text-muted)' }}>
              by {theme.authorDisplayName}
            </p>
          </div>
          <span className="text-[10px] shrink-0 tabular-nums" style={{ color: 'var(--vox-text-muted)' }}>
            {theme.installCount} {theme.installCount === 1 ? 'install' : 'installs'}
          </span>
        </div>

        {/* Tags */}
        {theme.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {theme.tags.map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-[9px]"
                style={{ backgroundColor: 'var(--vox-bg-secondary)', color: 'var(--vox-text-muted)' }}
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mt-2.5 flex gap-1.5">
          <button
            onClick={togglePreview}
            className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors"
            style={{
              border: previewing ? '1px solid var(--vox-accent-primary)' : '1px solid var(--vox-border)',
              color: previewing ? 'var(--vox-accent-primary)' : 'var(--vox-text-secondary)',
              backgroundColor: previewing ? 'var(--vox-accent-primary)/10' : 'transparent',
            }}
          >
            <Eye size={11} /> {previewing ? 'Stop' : 'Preview'}
          </button>
          {installed ? (
            <button
              onClick={() => onUninstall(theme)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors"
              style={{
                border: '1px solid var(--vox-accent-danger)',
                color: 'var(--vox-accent-danger)',
              }}
            >
              <Trash2 size={11} /> Uninstall
            </button>
          ) : (
            <button
              onClick={() => onInstall(theme)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold text-white transition-colors"
              style={{ backgroundColor: 'var(--vox-accent-primary)' }}
            >
              <Download size={11} /> Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
