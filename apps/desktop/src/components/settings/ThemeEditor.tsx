import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Download, Save, ChevronDown, RotateCcw, Pipette, Layers, Eye } from 'lucide-react';
import {
  THEME_COLOR_GROUPS,
  BUILT_IN_THEME_IDS,
  THEME_PATTERN_TYPES,
  THEME_PATTERN_AREAS,
  LIMITS,
  allowsAlphaThemeColor,
  isValidThemeColorValue,
} from '@voxium/shared';
import type { ThemeColors, ThemePatterns, ThemePattern, CommunityThemeData } from '@voxium/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  getBuiltInThemeColors,
  exportTheme,
} from '../../services/themeEngine';
import { AppShellMock, APP_SHELL_MOCK_WIDTH } from '../common/AppShellMock';
import { useFullAppThemePreview } from '../../hooks/useFullAppThemePreview';
import { ThemePreviewBar } from './ThemePreviewBar';
import { toast } from '../../stores/toastStore';

interface ThemeEditorProps {
  onClose: () => void;
  editTheme?: { localId: string; data: CommunityThemeData };
  /** Pre-fill data for new themes (e.g. imported from JSON) — ignored when editTheme is set */
  initialData?: CommunityThemeData;
}

/** The translation key of each color slot's label (`themes.colors.*`). */
export const COLOR_LABEL_KEYS: Record<string, string> = {
  'bg-primary': 'themes.colors.primary',
  'bg-secondary': 'themes.colors.secondary',
  'bg-tertiary': 'themes.colors.tertiary',
  'bg-hover': 'themes.colors.hover',
  'bg-active': 'themes.colors.active',
  'bg-floating': 'themes.colors.floating',
  sidebar: 'themes.colors.sidebar',
  channel: 'themes.colors.channelList',
  chat: 'themes.colors.chatArea',
  'text-primary': 'themes.colors.primary',
  'text-secondary': 'themes.colors.secondary',
  'text-muted': 'themes.colors.muted',
  'text-link': 'themes.colors.links',
  'accent-primary': 'themes.colors.primary',
  'accent-hover': 'themes.colors.hover',
  'accent-success': 'themes.colors.success',
  'accent-warning': 'themes.colors.warning',
  'accent-danger': 'themes.colors.danger',
  'accent-info': 'themes.colors.info',
  border: 'themes.colors.border',
  'voice-connected': 'themes.colors.connected',
  'voice-speaking': 'themes.colors.speaking',
  'voice-muted': 'themes.colors.voiceMuted',
  'scrollbar-thumb': 'themes.colors.thumb',
  'scrollbar-thumb-hover': 'themes.colors.thumbHover',
  'selection-bg': 'themes.colors.background',
  'selection-text': 'themes.colors.text',
};

/** The translation key of each color group's title (THEME_COLOR_GROUPS names them in English). */
export const COLOR_GROUP_LABEL_KEYS: Record<string, string> = {
  Backgrounds: 'themes.groups.backgrounds',
  Layout: 'themes.groups.layout',
  Text: 'themes.groups.text',
  Accents: 'themes.groups.accents',
  Borders: 'themes.groups.borders',
  Voice: 'themes.groups.voice',
  Scrollbar: 'themes.groups.scrollbar',
  Selection: 'themes.groups.selection',
};

function rgbaToHex(value: string): string {
  if (value.startsWith('#')) return value.slice(0, 7);
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match) {
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return '#000000';
}

export function ThemeEditor({ onClose, editTheme, initialData }: ThemeEditorProps) {
  const { t } = useTranslation();
  const { setTheme, createLocalTheme, saveLocalTheme } = useSettingsStore();
  const prefill = editTheme?.data ?? initialData;

  // Editor state
  const [name, setName] = useState(prefill?.name ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [tagsInput, setTagsInput] = useState(prefill?.tags.join(', ') ?? '');
  const [colors, setColors] = useState<ThemeColors>(() => {
    if (prefill) return { ...prefill.colors };
    // New themes start from the Voxium brand theme.
    return getBuiltInThemeColors('dark');
  });
  const [patterns, setPatterns] = useState<ThemePatterns>(() => {
    if (prefill?.patterns) return { ...prefill.patterns };
    return {};
  });
  const [expandedGroup, setExpandedGroup] = useState<string>('Backgrounds');
  const { previewName, previewing, startPreview, stopPreview, adoptPreview } = useFullAppThemePreview();

  const updateColor = useCallback((key: string, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleFullPreview = useCallback(() => {
    startPreview('editor', name.trim() || t('themes.editor.untitled'), colors, patterns);
  }, [startPreview, name, colors, patterns, t]);

  const handleStartFrom = useCallback((themeId: string) => {
    const base = getBuiltInThemeColors(themeId);
    setColors(base);
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim()) {
      toast.error(t('themes.editor.nameRequired'));
      return;
    }
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, LIMITS.THEME_MAX_TAGS);

    // Only include patterns if at least one area has a non-none pattern
    const hasPatterns = Object.values(patterns).some((p) => p && p.type !== 'none');
    const data: CommunityThemeData = {
      name: name.trim(),
      description: description.trim(),
      tags,
      colors,
      patterns: hasPatterns ? patterns : undefined,
      version: editTheme ? editTheme.data.version + 1 : 1,
    };

    // The store applies the saved theme itself — hand the app over instead of
    // restoring the pre-preview theme on unmount and undoing the save.
    adoptPreview();

    if (editTheme) {
      saveLocalTheme(editTheme.localId, data);
      setTheme(`custom:${editTheme.localId}`);
      toast.success(t('themes.editor.updated'));
    } else {
      const localId = createLocalTheme(data);
      setTheme(`custom:${localId}`);
      toast.success(t('themes.editor.created'));
    }
    onClose();
  }, [name, description, tagsInput, colors, patterns, editTheme, saveLocalTheme, createLocalTheme, setTheme, adoptPreview, onClose, t]);

  const handleExport = useCallback(() => {
    if (!name.trim()) {
      toast.error(t('themes.editor.nameBeforeExport'));
      return;
    }
    const tags = tagsInput.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, LIMITS.THEME_MAX_TAGS);
    const hasPatterns = Object.values(patterns).some((p) => p && p.type !== 'none');
    exportTheme({ name: name.trim(), description: description.trim(), tags, colors, patterns: hasPatterns ? patterns : undefined, version: editTheme ? editTheme.data.version : 1 });
    toast.success(t('themes.editor.exported'));
  }, [name, description, tagsInput, colors, patterns, editTheme, t]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return createPortal(
    <>
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      // Kept mounted (not unmounted) while previewing on the full app: every
      // field in here is local state, and re-mounting would wipe the theme
      // being authored the moment the user peeked at it.
      //
      // Hidden with `visibility`, not `display` — display:none CANCELS the
      // mock's CSS animations, so coming back from a preview replayed the
      // whole conversation fade-in from an empty chat panel.
      style={{
        visibility: previewing ? 'hidden' : 'visible',
        pointerEvents: previewing ? 'none' : undefined,
        backgroundColor: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="relative flex rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 'min(1480px, 96vw)',
          height: 'min(880px, 93vh)',
          backgroundColor: 'var(--vox-bg-secondary)',
          border: '1px solid var(--vox-border)',
        }}
      >
        {/* ─── Left: Live Preview ─────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col" style={{ borderRight: '1px solid var(--vox-border)' }}>
          <div
            className="px-4 py-3 flex items-center gap-2 shrink-0"
            style={{ borderBottom: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-primary)' }}
          >
            <Pipette size={14} style={{ color: 'var(--vox-accent-primary)' }} />
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--vox-text-secondary)' }}>
              {t('themes.editor.livePreview')}
            </span>
            <button
              onClick={handleFullPreview}
              data-testid="theme-editor-preview-app"
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all hover:scale-[1.02]"
              style={{
                backgroundColor: 'var(--vox-bg-floating)',
                border: '1px solid var(--vox-border)',
                color: 'var(--vox-text-secondary)',
              }}
              title={t('themes.editor.previewInAppHint')}
            >
              <Eye size={12} />
              {t('themes.editor.previewInApp')}
            </button>
          </div>
          <div className="flex-1 min-h-0" style={{ backgroundColor: 'var(--vox-bg-primary)' }}>
            <ScaledShellPreview colors={colors} patterns={patterns} />
          </div>
        </div>

        {/* ─── Right: Editor ──────────────────────────────────────── */}
        <div className="w-[500px] shrink-0 flex flex-col min-w-0">
          {/* Header */}
          <div
            className="px-5 py-3 flex items-center justify-between shrink-0"
            style={{ borderBottom: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-primary)' }}
          >
            <h2 className="text-sm font-bold" style={{ color: 'var(--vox-text-primary)' }}>
              {editTheme ? t('themes.editor.editTitle') : t('settings.appearance.createTheme')}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 rounded-md transition-colors hover:opacity-80"
              style={{ color: 'var(--vox-text-muted)' }}
              aria-label={t('common.close')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" style={{ scrollbarWidth: 'thin' }}>
            {/* Name & Description */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                  {t('themes.editor.name')} <span style={{ color: 'var(--vox-accent-danger)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('themes.editor.namePlaceholder')}
                  maxLength={50}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors"
                  style={{
                    backgroundColor: 'var(--vox-bg-floating)',
                    border: '1px solid var(--vox-border)',
                    color: 'var(--vox-text-primary)',
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                  {t('themes.editor.tags')} <span className="font-normal" style={{ color: 'var(--vox-text-muted)' }}>{t('themes.editor.tagsHint', { max: LIMITS.THEME_MAX_TAGS })}</span>
                </label>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder={t('themes.editor.tagsPlaceholder')}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors"
                  style={{
                    backgroundColor: 'var(--vox-bg-floating)',
                    border: '1px solid var(--vox-border)',
                    color: 'var(--vox-text-primary)',
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                {t('themes.editor.description')}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('themes.editor.descriptionPlaceholder')}
                rows={2}
                maxLength={500}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none resize-none transition-colors"
                style={{
                  backgroundColor: 'var(--vox-bg-floating)',
                  border: '1px solid var(--vox-border)',
                  color: 'var(--vox-text-primary)',
                }}
              />
            </div>

            {/* Start from built-in */}
            <div className="flex items-center gap-2">
              <RotateCcw size={13} style={{ color: 'var(--vox-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--vox-text-muted)' }}>{t('themes.editor.startFrom')}</span>
              <div className="flex gap-1.5">
                {BUILT_IN_THEME_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => handleStartFrom(id)}
                    className="px-2.5 py-1 rounded-md text-xs transition-all hover:scale-105"
                    style={{
                      backgroundColor: 'var(--vox-bg-floating)',
                      border: '1px solid var(--vox-border)',
                      color: 'var(--vox-text-secondary)',
                    }}
                  >
                    {t(`themes.builtIn.${id}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Color Groups */}
            <div className="space-y-1">
              {Object.entries(THEME_COLOR_GROUPS).map(([groupName, keys]) => (
                <ColorGroup
                  key={groupName}
                  name={groupName}
                  keys={keys as string[]}
                  colors={colors}
                  expanded={expandedGroup === groupName}
                  onToggle={() => setExpandedGroup(expandedGroup === groupName ? '' : groupName)}
                  onColorChange={updateColor}
                />
              ))}
            </div>

            {/* Patterns & Branding */}
            <PatternsSection patterns={patterns} onPatternsChange={setPatterns} />
          </div>

          {/* Footer actions */}
          <div
            className="px-5 py-3 flex items-center justify-between shrink-0"
            style={{ borderTop: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-primary)' }}
          >
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02]"
              style={{
                backgroundColor: 'var(--vox-bg-floating)',
                border: '1px solid var(--vox-border)',
                color: 'var(--vox-text-secondary)',
              }}
            >
              <Download size={13} />
              {t('themes.editor.exportJson')}
            </button>
            <div className="flex gap-2">
              <button
                onClick={handleClose}
                className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  border: '1px solid var(--vox-border)',
                  color: 'var(--vox-text-secondary)',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:scale-[1.02]"
                style={{ backgroundColor: 'var(--vox-accent-primary)' }}
              >
                <Save size={13} />
                {editTheme ? t('themes.editor.update') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    {previewing && previewName && <ThemePreviewBar name={previewName} onStop={stopPreview} />}
    </>,
    document.body,
  );
}

// ─── Scaled shell preview ───────────────────────────────────────────────────

/**
 * The app-shell mock, laid out once at its design width and then scaled up to
 * fill the preview panel.
 *
 * Scaling rather than reflowing is the point: the mock's type sizes are tuned
 * as a miniature of the real shell, so letting it re-flow at every panel width
 * would show the theme author a layout the app never actually has. A transform
 * keeps the proportions exact and just makes them bigger.
 *
 * The one thing that DOES adapt is how tall the window is — a real app window
 * can be any height, and matching the panel's aspect is what stops the preview
 * from floating in a band of dead space.
 */
const MIN_MOCK_BODY = 320;
const MAX_MOCK_BODY = 470;

function ScaledShellPreview({ colors, patterns }: { colors: ThemeColors; patterns: ThemePatterns }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [bodyHeight, setBodyHeight] = useState(400);
  const bodyHeightRef = useRef(400);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;

    const measure = () => {
      // offsetWidth/Height are layout dimensions — unaffected by the transform
      // we are about to set, so this cannot feed back on itself.
      const availW = box.clientWidth;
      const availH = box.clientHeight;
      const naturalH = inner.offsetHeight;
      if (!availW || !availH || !naturalH) return;

      // Everything above the panel row (title bar + spaces strip + borders),
      // measured rather than hard-coded so the mock can grow a row without
      // silently un-fitting itself here.
      const chrome = naturalH - bodyHeightRef.current;
      const target = Math.max(
        MIN_MOCK_BODY,
        Math.min(MAX_MOCK_BODY, Math.round((APP_SHELL_MOCK_WIDTH * availH) / availW) - chrome),
      );
      bodyHeightRef.current = target;
      setBodyHeight(target);

      // Capped: past ~1.9x the hairlines and 7px type start looking like a
      // blown-up screenshot rather than the app.
      setScale(Math.min(availW / APP_SHELL_MOCK_WIDTH, availH / (chrome + target), 1.9));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    // The padding lives on the outer box so `boxRef.clientWidth` is the space
    // actually available — clientWidth includes padding, and measuring it
    // would scale the mock right into the gutter it is supposed to keep.
    <div className="h-full w-full overflow-hidden p-4">
    <div ref={boxRef} className="flex h-full w-full items-center justify-center">
      <div
        ref={innerRef}
        data-testid="theme-editor-shell-preview"
        className="rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: APP_SHELL_MOCK_WIDTH,
          border: `1px solid ${colors.border}`,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <AppShellMock colors={colors} patterns={patterns} variant="full" bodyHeight={bodyHeight} />
      </div>
    </div>
    </div>
  );
}

// ─── Color Group Accordion ──────────────────────────────────────────────────

function ColorGroup({
  name,
  keys,
  colors,
  expanded,
  onToggle,
  onColorChange,
}: {
  name: string;
  keys: string[];
  colors: ThemeColors;
  expanded: boolean;
  onToggle: () => void;
  onColorChange: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-floating)' }}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
        style={{ color: 'var(--vox-text-primary)' }}
      >
        {/* Color dots preview */}
        <div className="flex -space-x-1">
          {keys.slice(0, 4).map((key) => (
            <div
              key={key}
              className="w-3.5 h-3.5 rounded-full"
              style={{
                backgroundColor: rgbaToHex(colors[key as keyof ThemeColors]),
                boxShadow: '0 0 0 1px var(--vox-bg-floating)',
              }}
            />
          ))}
        </div>
        <span className="text-xs font-semibold flex-1">{COLOR_GROUP_LABEL_KEYS[name] ? t(COLOR_GROUP_LABEL_KEYS[name]) : name}</span>
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--vox-text-muted)' }}>
          {keys.length}
        </span>
        <ChevronDown
          size={14}
          className="transition-transform"
          style={{
            color: 'var(--vox-text-muted)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {expanded && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {keys.map((key) => (
            <ColorPicker
              key={key}
              colorKey={key}
              label={COLOR_LABEL_KEYS[key] ? t(COLOR_LABEL_KEYS[key]) : key}
              value={colors[key as keyof ThemeColors]}
              onChange={(val) => onColorChange(key, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Individual Color Picker ────────────────────────────────────────────────

function ColorPicker({
  colorKey,
  label,
  value,
  onChange,
}: {
  colorKey: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [textValue, setTextValue] = useState('');
  const [editing, setEditing] = useState(false);
  const hexValue = rgbaToHex(value);
  // Which keys may carry alpha is the marketplace's rule, not this component's
  // — hard-coding a shorter list here is what let the editor flatten a
  // translucent value the server would happily have taken.
  const isRgba = allowsAlphaThemeColor(colorKey);

  return (
    <div className="flex items-center gap-2 group" data-color-key={colorKey}>
      {/* Swatch — click opens native picker */}
      <button
        onClick={() => inputRef.current?.click()}
        className="w-6 h-6 rounded-md shrink-0 transition-transform hover:scale-110 cursor-pointer"
        style={{
          backgroundColor: hexValue,
          boxShadow: '0 0 0 1px var(--vox-border)',
        }}
      />
      <input
        ref={inputRef}
        type="color"
        value={hexValue}
        onChange={(e) => {
          if (isRgba && value.startsWith('rgba')) {
            const alpha = value.match(/,\s*([\d.]+)\s*\)/)?.[1] || '1';
            const hex = e.target.value;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            onChange(`rgba(${r}, ${g}, ${b}, ${alpha})`);
          } else {
            onChange(e.target.value);
          }
        }}
        className="sr-only"
      />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] block truncate" style={{ color: 'var(--vox-text-secondary)' }}>
          {label}
        </span>
      </div>
      <input
        type="text"
        value={editing ? textValue : (isRgba ? value : hexValue)}
        onChange={(e) => setTextValue(e.target.value)}
        onFocus={() => { setEditing(true); setTextValue(isRgba ? value : hexValue); }}
        onBlur={() => {
          setEditing(false);
          // Vet against the marketplace's own rule, so a typo is rejected here
          // instead of surviving into a draft that only fails on publish.
          if (isValidThemeColorValue(colorKey, textValue.trim())) onChange(textValue.trim());
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        spellCheck={false}
        // An rgba() value is wider than the field; the tooltip is how you read
        // the alpha you are editing without widening every row for 7 keys.
        title={isRgba ? value : hexValue}
        className="w-[72px] shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono outline-none transition-colors"
        style={{
          backgroundColor: 'var(--vox-bg-secondary)',
          border: '1px solid var(--vox-border)',
          color: 'var(--vox-text-muted)',
        }}
      />
    </div>
  );
}

// ─── Patterns & Branding Section ────────────────────────────────────────────

/** The translation key of each pattern area's title (the same words as its color slot). */
export const AREA_LABEL_KEYS: Record<string, string> = {
  sidebar: 'themes.colors.sidebar',
  channel: 'themes.colors.channelList',
  chat: 'themes.colors.chatArea',
};

/** The translation key of each pattern type's name (`themes.patterns.*`). */
export const PATTERN_TYPE_LABEL_KEYS: Record<string, string> = {
  none: 'themes.patterns.none',
  stripes: 'themes.patterns.stripes',
  grid: 'themes.patterns.grid',
  dots: 'themes.patterns.dots',
  crosshatch: 'themes.patterns.crosshatch',
  'custom-svg': 'themes.patterns.customSvg',
};

function makeDefaultPattern(): ThemePattern {
  return { type: 'none', color: '#ffffff', opacity: 0.03 };
}

function PatternsSection({
  patterns,
  onPatternsChange,
}: {
  patterns: ThemePatterns;
  onPatternsChange: (p: ThemePatterns) => void;
}) {
  const { t } = useTranslation();
  const [expandedArea, setExpandedArea] = useState<string>('');

  const updatePattern = useCallback(
    (area: string, patch: Partial<ThemePattern>) => {
      const current = patterns[area as keyof ThemePatterns] || makeDefaultPattern();
      onPatternsChange({ ...patterns, [area]: { ...current, ...patch } });
    },
    [patterns, onPatternsChange],
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Layers size={13} style={{ color: 'var(--vox-accent-primary)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--vox-text-primary)' }}>
          {t('themes.editor.patternsTitle')}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--vox-text-muted)' }}>
          {t('themes.editor.patternsHint')}
        </span>
      </div>
      <div className="space-y-1">
        {THEME_PATTERN_AREAS.map((area) => {
          const pattern = patterns[area] || makeDefaultPattern();
          const isExpanded = expandedArea === area;
          return (
            <div
              key={area}
              className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--vox-border)', backgroundColor: 'var(--vox-bg-floating)' }}
            >
              <button
                onClick={() => setExpandedArea(isExpanded ? '' : area)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left"
                style={{ color: 'var(--vox-text-primary)' }}
              >
                <span className="text-xs font-semibold flex-1">{t(AREA_LABEL_KEYS[area])}</span>
                <span className="text-[10px]" style={{ color: 'var(--vox-text-muted)' }}>
                  {t(PATTERN_TYPE_LABEL_KEYS[pattern.type])}
                </span>
                <ChevronDown
                  size={14}
                  className="transition-transform"
                  style={{
                    color: 'var(--vox-text-muted)',
                    transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              </button>

              {isExpanded && (
                <PatternEditor
                  pattern={pattern}
                  onChange={(patch) => updatePattern(area, patch)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PatternEditor({
  pattern,
  onChange,
}: {
  pattern: ThemePattern;
  onChange: (patch: Partial<ThemePattern>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 pb-3 space-y-2.5">
      {/* Pattern type */}
      <div>
        <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
          {t('themes.editor.patternType')}
        </label>
        <div className="flex flex-wrap gap-1">
          {THEME_PATTERN_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => onChange({ type })}
              className="px-2 py-1 rounded text-[10px] transition-colors"
              style={{
                backgroundColor: pattern.type === type ? 'var(--vox-accent-primary)' : 'var(--vox-bg-secondary)',
                color: pattern.type === type ? '#fff' : 'var(--vox-text-secondary)',
                border: `1px solid ${pattern.type === type ? 'var(--vox-accent-primary)' : 'var(--vox-border)'}`,
              }}
            >
              {t(PATTERN_TYPE_LABEL_KEYS[type])}
            </button>
          ))}
        </div>
      </div>

      {pattern.type !== 'none' && (
        <>
          {/* Color & Opacity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                {t('themes.editor.patternColor')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={pattern.color}
                  onChange={(e) => onChange({ color: e.target.value })}
                  className="w-7 h-7 rounded cursor-pointer border-0 p-0"
                  style={{ backgroundColor: 'transparent' }}
                />
                <input
                  type="text"
                  defaultValue={pattern.color}
                  key={pattern.color}
                  onBlur={(e) => {
                    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange({ color: e.target.value });
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  spellCheck={false}
                  className="flex-1 rounded px-2 py-1 text-[10px] font-mono outline-none"
                  style={{
                    backgroundColor: 'var(--vox-bg-secondary)',
                    border: '1px solid var(--vox-border)',
                    color: 'var(--vox-text-muted)',
                  }}
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                {t('themes.editor.opacity', { value: Math.round(pattern.opacity * 100) })}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={pattern.opacity}
                onChange={(e) => onChange({ opacity: parseFloat(e.target.value) })}
                className="w-full h-1.5 cursor-pointer"
                style={{ accentColor: 'var(--vox-accent-primary)' }}
              />
            </div>
          </div>

          {/* Size & Angle (for applicable types) */}
          {pattern.type !== 'custom-svg' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                  {t('themes.editor.size', { value: pattern.size ?? (pattern.type === 'grid' ? 40 : pattern.type === 'dots' ? 24 : 20) })}
                </label>
                <input
                  type="range"
                  min={4}
                  max={100}
                  step={1}
                  value={pattern.size ?? (pattern.type === 'grid' ? 40 : pattern.type === 'dots' ? 24 : 20)}
                  onChange={(e) => onChange({ size: parseInt(e.target.value) })}
                  className="w-full h-1.5 cursor-pointer"
                  style={{ accentColor: 'var(--vox-accent-primary)' }}
                />
              </div>
              {(pattern.type === 'stripes' || pattern.type === 'crosshatch') && (
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                    {t('themes.editor.angle', { value: pattern.angle ?? (pattern.type === 'crosshatch' ? 45 : -45) })}
                  </label>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    value={pattern.angle ?? (pattern.type === 'crosshatch' ? 45 : -45)}
                    onChange={(e) => onChange({ angle: parseInt(e.target.value) })}
                    className="w-full h-1.5 cursor-pointer"
                    style={{ accentColor: 'var(--vox-accent-primary)' }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Custom SVG input */}
          {pattern.type === 'custom-svg' && (
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
                {t('themes.editor.svgMarkup')} <span className="font-normal" style={{ color: 'var(--vox-text-muted)' }}>
                  {/* The cap counts CHARACTERS (validateThemePatterns), not bytes */}
                  {t('themes.editor.svgHint', { max: LIMITS.THEME_SVG_MAX_SIZE.toLocaleString() })}
                </span>
              </label>
              <textarea
                value={pattern.svgData || ''}
                onChange={(e) => onChange({ svgData: e.target.value })}
                placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <path d="..." />\n</svg>'}
                rows={4}
                spellCheck={false}
                className="w-full rounded-lg px-3 py-2 text-[10px] font-mono outline-none resize-none"
                style={{
                  backgroundColor: 'var(--vox-bg-secondary)',
                  border: '1px solid var(--vox-border)',
                  color: 'var(--vox-text-primary)',
                }}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-[9px]" style={{ color: 'var(--vox-text-muted)' }}>
                  {t('themes.editor.svgCount', { used: (pattern.svgData?.length || 0).toLocaleString(), max: LIMITS.THEME_SVG_MAX_SIZE.toLocaleString() })}
                </p>
                <div className="flex items-center gap-2">
                  <label className="text-[10px]" style={{ color: 'var(--vox-text-secondary)' }}>{t('themes.editor.tileSize')}</label>
                  <input
                    type="range"
                    min={50}
                    max={400}
                    step={10}
                    value={pattern.size ?? 200}
                    onChange={(e) => onChange({ size: parseInt(e.target.value) })}
                    className="w-24 h-1.5 cursor-pointer"
                    style={{ accentColor: 'var(--vox-accent-primary)' }}
                  />
                  <span className="text-[9px] tabular-nums w-8" style={{ color: 'var(--vox-text-muted)' }}>
                    {pattern.size ?? 200}px
                  </span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
