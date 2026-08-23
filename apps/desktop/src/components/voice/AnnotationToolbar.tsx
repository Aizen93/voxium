import { useTranslation } from 'react-i18next';
import { Undo2, Redo2, Trash2, PenLine, X, ListOrdered, Timer } from 'lucide-react';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { pttReservedCode, shortcutFor } from '../../hooks/useAnnotationShortcuts';
import { ANNOTATION_COLORS, ANNOTATION_WIDTHS, ANNOTATION_TEXT_SIZES, MASK_TOOL_DEF, availableToolDefs, type ToolDef } from './annotationPresets';
import { ColorPalettePopover } from './ColorPalettePopover';

/**
 * The sharer's annotation toolbar, rendered under the ScreenShareViewer
 * header. Collapsed: a single "Annotate" toggle. Expanded: tools, colors,
 * widths, undo/redo/clear. Masks get a visually separated group + privacy
 * tooltip — they are the only tool whose effect is enforced at the source.
 *
 * Tools and their keys come from annotationPresets (shared with the
 * shortcuts hook); v2 tools appear only when the server advertised wire
 * version 2 on our share claim.
 */

export function AnnotationToolbar() {
  const { t } = useTranslation();
  const isEditing = useAnnotationStore((s) => s.isEditing);
  const activeTool = useAnnotationStore((s) => s.activeTool);
  const color = useAnnotationStore((s) => s.color);
  const strokeWidth = useAnnotationStore((s) => s.strokeWidth);
  const setIsEditing = useAnnotationStore((s) => s.setIsEditing);
  const setActiveTool = useAnnotationStore((s) => s.setActiveTool);
  const setColor = useAnnotationStore((s) => s.setColor);
  const setStrokeWidth = useAnnotationStore((s) => s.setStrokeWidth);
  const undo = useAnnotationStore((s) => s.undo);
  const redo = useAnnotationStore((s) => s.redo);
  const canUndo = useAnnotationStore((s) => s.canUndo);
  const canRedo = useAnnotationStore((s) => s.canRedo);
  const clearAll = useAnnotationStore((s) => s.clearAll);
  const renumberCallouts = useAnnotationStore((s) => s.renumberCallouts);
  const inkMode = useAnnotationStore((s) => s.inkMode);
  const setInkMode = useAnnotationStore((s) => s.setInkMode);
  const textSize = useAnnotationStore((s) => s.textSize);
  const setTextSize = useAnnotationStore((s) => s.setTextSize);
  // The size segment shows while a caption/badge is being placed or is selected
  const sizeRelevant = useAnnotationStore((s) =>
    s.activeTool === 'text' || s.activeTool === 'callout'
    || (s.selectedObjectId !== null && s.scene.objects.some((o) => o.id === s.selectedObjectId && (o.kind === 'text' || o.kind === 'callout'))));
  const hasCallouts = useAnnotationStore((s) => s.scene.objects.some((o) => o.kind === 'callout'));
  const annotationsVersion = useVoiceStore((s) => s.screenShareAnnotationsVersion);
  const voiceMode = useSettingsStore((s) => s.voiceMode);
  const pushToTalkKey = useSettingsStore((s) => s.pushToTalkKey);

  if (!isEditing) {
    return (
      <div className="flex items-center border-b border-vox-border bg-vox-bg-secondary px-4 py-1" data-testid="annotation-toolbar-collapsed">
        <button
          onClick={() => setIsEditing(true)}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary"
        >
          <PenLine size={13} />
          {t('voice.annotations.annotate')}
        </button>
      </div>
    );
  }

  const reserved = pttReservedCode({ voiceMode, pushToTalkKey });
  const tools = availableToolDefs(annotationsVersion);

  const toolButton = (def: ToolDef, extraTitle?: string) => {
    const label = t(def.labelKey);
    const key = shortcutFor(def, reserved);
    const title = `${label}${key ? ` (${key})` : ''}${extraTitle ? ` — ${extraTitle}` : ''}`;
    return (
      <button
        key={def.tool}
        onClick={() => setActiveTool(def.tool)}
        className={`rounded p-1.5 transition-colors ${
          activeTool === def.tool
            ? 'bg-vox-accent-primary/20 text-vox-accent-primary'
            : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
        }`}
        title={title}
        aria-label={label}
        aria-keyshortcuts={key ?? undefined}
        aria-pressed={activeTool === def.tool}
        data-tool={def.tool}
      >
        <def.Icon size={15} />
      </button>
    );
  };

  const historyButton = (onClick: () => void, enabled: boolean, labelKey: string, keyLabel: string, Icon: typeof Undo2) => (
    <button
      onClick={onClick}
      disabled={!enabled}
      className="rounded p-1.5 text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      title={`${t(labelKey)} (${keyLabel})`}
      aria-label={t(labelKey)}
      aria-keyshortcuts={keyLabel}
    >
      <Icon size={15} />
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-vox-border bg-vox-bg-secondary px-3 py-1.5" data-testid="annotation-toolbar">
      <div className="flex items-center gap-0.5">
        {tools.map((def) => toolButton(def))}
      </div>

      {/* Privacy mask — separated: the one tool enforced at the source */}
      <div className="flex items-center gap-0.5 border-l border-vox-border pl-2">
        {toolButton(MASK_TOOL_DEF, t('voice.annotations.maskPrivacyHint'))}
      </div>

      <div className="flex items-center gap-1 border-l border-vox-border pl-2">
        {ANNOTATION_COLORS.map((c, i) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border transition-transform ${
              color === c ? 'scale-125 border-white' : 'border-vox-border hover:scale-110'
            }`}
            style={{ backgroundColor: c }}
            title={`${t('voice.annotations.color')} (${i + 1})`}
            aria-label={`${t('voice.annotations.color')} ${c}`}
            aria-keyshortcuts={String(i + 1)}
            aria-pressed={color === c}
          />
        ))}
        <ColorPalettePopover />
      </div>

      {sizeRelevant && (
        <div className="flex items-center gap-0.5 border-l border-vox-border pl-2" data-testid="text-size-picker">
          {ANNOTATION_TEXT_SIZES.map(({ key, value }) => (
            <button
              key={key}
              onClick={() => setTextSize(value)}
              className={`rounded px-1.5 py-0.5 text-xs font-semibold transition-colors ${
                textSize === value ? 'bg-vox-accent-primary/20 text-vox-accent-primary' : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
              }`}
              title={`${t('voice.annotations.textSize')} ${key}`}
              aria-label={`${t('voice.annotations.textSize')} ${key}`}
              aria-pressed={textSize === value}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {annotationsVersion >= 2 && (
        <div className="flex items-center gap-0.5 border-l border-vox-border pl-2">
          <button
            onClick={() => setInkMode(inkMode === 'vanishing' ? 'persistent' : 'vanishing')}
            className={`rounded p-1.5 transition-colors ${
              inkMode === 'vanishing'
                ? 'bg-vox-accent-primary/20 text-vox-accent-primary'
                : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
            }`}
            title={t('voice.annotations.vanishingInk')}
            aria-label={t('voice.annotations.vanishingInk')}
            aria-pressed={inkMode === 'vanishing'}
            data-testid="ink-mode-toggle"
          >
            <Timer size={15} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 border-l border-vox-border pl-2">
        {ANNOTATION_WIDTHS.map(({ key, value, dot }) => (
          <button
            key={key}
            onClick={() => setStrokeWidth(value)}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              strokeWidth === value ? 'bg-vox-accent-primary/20' : 'hover:bg-vox-bg-hover'
            }`}
            title={`${t('voice.annotations.width')} ([ ])`}
            aria-label={`${t('voice.annotations.width')} ${key}`}
            aria-pressed={strokeWidth === value}
          >
            <span className="rounded-full bg-vox-text-primary" style={{ width: dot, height: dot }} />
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        {hasCallouts && (
          <button
            onClick={renumberCallouts}
            className="rounded p-1.5 text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary"
            title={t('voice.annotations.renumber')}
            aria-label={t('voice.annotations.renumber')}
          >
            <ListOrdered size={15} />
          </button>
        )}
        {historyButton(undo, canUndo, 'voice.annotations.undo', 'Ctrl+Z', Undo2)}
        {historyButton(redo, canRedo, 'voice.annotations.redo', 'Ctrl+Shift+Z', Redo2)}
        <button
          onClick={clearAll}
          className="rounded p-1.5 text-vox-accent-danger transition-colors hover:bg-vox-accent-danger/20"
          title={t('voice.annotations.clearAll')}
          aria-label={t('voice.annotations.clearAll')}
        >
          <Trash2 size={15} />
        </button>
        <button
          onClick={() => setIsEditing(false)}
          className="rounded p-1.5 text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary"
          title={t('voice.annotations.done')}
          aria-label={t('voice.annotations.done')}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
