import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
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

const COLOR_LABELS: Record<string, string> = {
  'bg-primary': 'Primary',
  'bg-secondary': 'Secondary',
  'bg-tertiary': 'Tertiary',
  'bg-hover': 'Hover',
  'bg-active': 'Active',
  'bg-floating': 'Floating',
  sidebar: 'Sidebar',
  channel: 'Channel List',
  chat: 'Chat Area',
  'text-primary': 'Primary',
  'text-secondary': 'Secondary',
  'text-muted': 'Muted',
  'text-link': 'Links',
  'accent-primary': 'Primary',
  'accent-hover': 'Hover',
  'accent-success': 'Success',
  'accent-warning': 'Warning',
  'accent-danger': 'Danger',
  'accent-info': 'Info',
  border: 'Border',
  'voice-connected': 'Connected',
  'voice-speaking': 'Speaking',
  'voice-muted': 'Muted',
  'scrollbar-thumb': 'Thumb',
  'scrollbar-thumb-hover': 'Thumb Hover',
  'selection-bg': 'Background',
  'selection-text': 'Text',
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
    startPreview('editor', name.trim() || 'Untitled theme', colors, patterns);
  }, [startPreview, name, colors, patterns]);

  const handleStartFrom = useCallback((themeId: string) => {
    const base = getBuiltInThemeColors(themeId);
    setColors(base);
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim()) {
      toast.error('Theme name is required');
      return;
    }
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);

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
      toast.success('Theme updated');
    } else {
      const localId = createLocalTheme(data);
      setTheme(`custom:${localId}`);
      toast.success('Theme created');
    }
    onClose();
  }, [name, description, tagsInput, colors, patterns, editTheme, saveLocalTheme, createLocalTheme, setTheme, adoptPreview, onClose]);

  const handleExport = useCallback(() => {
    if (!name.trim()) {
      toast.error('Give your theme a name before exporting');
      return;
    }
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5);
    const hasPatterns = Object.values(patterns).some((p) => p && p.type !== 'none');
    exportTheme({ name: name.trim(), description: description.trim(), tags, colors, patterns: hasPatterns ? patterns : undefined, version: editTheme ? editTheme.data.version : 1 });
    toast.success('Theme exported');
  }, [name, description, tagsInput, colors, patterns, editTheme]);

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
              Live Preview
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
              title="Apply these colors to the whole app until you stop"
            >
              <Eye size={12} />
              Preview in app
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
              {editTheme ? 'Edit Theme' : 'Create Theme'}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 rounded-md transition-colors hover:opacity-80"
              style={{ color: 'var(--vox-text-muted)' }}
              aria-label="Close"
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
                  Name <span style={{ color: 'var(--vox-accent-danger)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Awesome Theme"
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
                  Tags <span className="font-normal" style={{ color: 'var(--vox-text-muted)' }}>(comma-separated, max 5)</span>
                </label>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="dark, minimal, blue"
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
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of your theme..."
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
              <span className="text-xs" style={{ color: 'var(--vox-text-muted)' }}>Start from:</span>
              <div className="flex gap-1.5">
                {BUILT_IN_THEME_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => handleStartFrom(id)}
                    className="px-2.5 py-1 rounded-md text-xs capitalize transition-all hover:scale-105"
                    style={{
                      backgroundColor: 'var(--vox-bg-floating)',
                      border: '1px solid var(--vox-border)',
                      color: 'var(--vox-text-secondary)',
                    }}
                  >
                    {id}
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
              Export JSON
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
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white transition-all hover:scale-[1.02]"
                style={{ backgroundColor: 'var(--vox-accent-primary)' }}
              >
                <Save size={13} />
                {editTheme ? 'Update' : 'Save'}
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
        <span className="text-xs font-semibold flex-1">{name}</span>
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
              label={COLOR_LABELS[key] || key}
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

const AREA_LABELS: Record<string, string> = {
  sidebar: 'Sidebar',
  channel: 'Channel List',
  chat: 'Chat Area',
};

const PATTERN_TYPE_LABELS: Record<string, string> = {
  none: 'None',
  stripes: 'Stripes',
  grid: 'Grid',
  dots: 'Dots',
  crosshatch: 'Crosshatch',
  'custom-svg': 'Custom SVG',
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
          Patterns & Branding
        </span>
        <span className="text-[10px]" style={{ color: 'var(--vox-text-muted)' }}>
          (decorative backgrounds)
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
                <span className="text-xs font-semibold flex-1">{AREA_LABELS[area]}</span>
                <span className="text-[10px]" style={{ color: 'var(--vox-text-muted)' }}>
                  {PATTERN_TYPE_LABELS[pattern.type]}
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
  return (
    <div className="px-3 pb-3 space-y-2.5">
      {/* Pattern type */}
      <div>
        <label className="block text-[11px] mb-1" style={{ color: 'var(--vox-text-secondary)' }}>
          Type
        </label>
        <div className="flex flex-wrap gap-1">
          {THEME_PATTERN_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => onChange({ type: t })}
              className="px-2 py-1 rounded text-[10px] transition-colors"
              style={{
                backgroundColor: pattern.type === t ? 'var(--vox-accent-primary)' : 'var(--vox-bg-secondary)',
                color: pattern.type === t ? '#fff' : 'var(--vox-text-secondary)',
                border: `1px solid ${pattern.type === t ? 'var(--vox-accent-primary)' : 'var(--vox-border)'}`,
              }}
            >
              {PATTERN_TYPE_LABELS[t]}
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
                Color
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
                Opacity ({Math.round(pattern.opacity * 100)}%)
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
                  Size ({pattern.size ?? (pattern.type === 'grid' ? 40 : pattern.type === 'dots' ? 24 : 20)}px)
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
                    Angle ({pattern.angle ?? (pattern.type === 'crosshatch' ? 45 : -45)}&deg;)
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
                SVG Markup <span className="font-normal" style={{ color: 'var(--vox-text-muted)' }}>
                  (max {(LIMITS.THEME_SVG_MAX_SIZE / 1000).toFixed(0)}KB &mdash; paste your brand/game SVG here)
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
                  {(pattern.svgData?.length || 0).toLocaleString()} / {LIMITS.THEME_SVG_MAX_SIZE.toLocaleString()} chars
                </p>
                <div className="flex items-center gap-2">
                  <label className="text-[10px]" style={{ color: 'var(--vox-text-secondary)' }}>Tile size</label>
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
