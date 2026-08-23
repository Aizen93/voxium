import { useTranslation } from 'react-i18next';
import {
  MousePointer2, Pencil, Highlighter, Square, Circle, Type, ImagePlus,
  ShieldOff, Undo2, Redo2, Trash2, PenLine, X,
} from 'lucide-react';
import { useAnnotationStore, type AnnotationEditorTool } from '../../stores/annotationStore';

/**
 * The sharer's annotation toolbar, rendered under the ScreenShareViewer
 * header. Collapsed: a single "Annotate" toggle. Expanded: tools, colors,
 * widths, undo/clear. Masks get a visually separated group + privacy tooltip —
 * they are the only tool whose effect is enforced at the source.
 */

const COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ffffff', '#111111'];
const WIDTHS: { key: string; value: number; dot: number }[] = [
  { key: 'thin', value: 0.002, dot: 4 },
  { key: 'medium', value: 0.004, dot: 6 },
  { key: 'thick', value: 0.008, dot: 9 },
];

const TOOLS: { tool: AnnotationEditorTool; labelKey: string; Icon: typeof Pencil }[] = [
  { tool: 'select', labelKey: 'voice.annotations.select', Icon: MousePointer2 },
  { tool: 'pen', labelKey: 'voice.annotations.pen', Icon: Pencil },
  { tool: 'highlighter', labelKey: 'voice.annotations.highlighter', Icon: Highlighter },
  { tool: 'rect', labelKey: 'voice.annotations.rectangle', Icon: Square },
  { tool: 'ellipse', labelKey: 'voice.annotations.ellipse', Icon: Circle },
  { tool: 'text', labelKey: 'voice.annotations.text', Icon: Type },
  { tool: 'image', labelKey: 'voice.annotations.image', Icon: ImagePlus },
];

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

  const toolButton = (tool: AnnotationEditorTool, label: string, Icon: typeof Pencil, extraTitle?: string) => (
    <button
      key={tool}
      onClick={() => setActiveTool(tool)}
      className={`rounded p-1.5 transition-colors ${
        activeTool === tool
          ? 'bg-vox-accent-primary/20 text-vox-accent-primary'
          : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
      }`}
      title={extraTitle ? `${label} — ${extraTitle}` : label}
      aria-label={label}
      aria-pressed={activeTool === tool}
    >
      <Icon size={15} />
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-vox-border bg-vox-bg-secondary px-3 py-1.5" data-testid="annotation-toolbar">
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ tool, labelKey, Icon }) => toolButton(tool, t(labelKey), Icon))}
      </div>

      {/* Privacy mask — separated: the one tool enforced at the source */}
      <div className="flex items-center gap-0.5 border-l border-vox-border pl-2">
        {toolButton('mask', t('voice.annotations.mask'), ShieldOff, t('voice.annotations.maskPrivacyHint'))}
      </div>

      <div className="flex items-center gap-1 border-l border-vox-border pl-2">
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border transition-transform ${
              color === c ? 'scale-125 border-white' : 'border-vox-border hover:scale-110'
            }`}
            style={{ backgroundColor: c }}
            title={t('voice.annotations.color')}
            aria-label={`${t('voice.annotations.color')} ${c}`}
            aria-pressed={color === c}
          />
        ))}
      </div>

      <div className="flex items-center gap-1 border-l border-vox-border pl-2">
        {WIDTHS.map(({ key, value, dot }) => (
          <button
            key={key}
            onClick={() => setStrokeWidth(value)}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              strokeWidth === value ? 'bg-vox-accent-primary/20' : 'hover:bg-vox-bg-hover'
            }`}
            title={t('voice.annotations.width')}
            aria-label={`${t('voice.annotations.width')} ${key}`}
            aria-pressed={strokeWidth === value}
          >
            <span className="rounded-full bg-vox-text-primary" style={{ width: dot, height: dot }} />
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <button
          onClick={undo}
          disabled={!canUndo}
          className="rounded p-1.5 text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          title={t('voice.annotations.undo')}
          aria-label={t('voice.annotations.undo')}
        >
          <Undo2 size={15} />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className="rounded p-1.5 text-vox-text-muted transition-colors hover:bg-vox-bg-hover hover:text-vox-text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          title={t('voice.annotations.redo')}
          aria-label={t('voice.annotations.redo')}
        >
          <Redo2 size={15} />
        </button>
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
