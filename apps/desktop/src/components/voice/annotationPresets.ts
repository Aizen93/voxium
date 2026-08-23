import {
  MousePointer2, Pencil, Highlighter, Square, Circle, Type, ImagePlus, ShieldOff,
  MoveUpRight, Hash, Sun, Crosshair, Eraser,
} from 'lucide-react';
import type { AnnotationEditorTool } from '../../stores/annotationStore';

/**
 * Everything the toolbar and the keyboard shortcuts agree on: which tools
 * exist, their icon, i18n label, key, and whether they need wire v2 on the
 * server. One list so a tool cannot have a key without a button or a button
 * without a key.
 */

export const ANNOTATION_COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ffffff', '#111111'] as const;

export const ANNOTATION_WIDTHS: readonly { key: string; value: number; dot: number }[] = [
  { key: 'thin', value: 0.002, dot: 4 },
  { key: 'medium', value: 0.004, dot: 6 },
  { key: 'thick', value: 0.008, dot: 9 },
];

export interface ToolDef {
  tool: AnnotationEditorTool;
  labelKey: string;
  Icon: typeof Pencil;
  /** KeyboardEvent.code for the shortcut (letters: 'KeyX'). */
  code: string;
  /** What the tooltip shows for the key. */
  keyLabel: string;
  /** Needs `annotationsVersion >= 2` from the server (new wire kinds). */
  v2?: boolean;
}

/** Tools in toolbar order. The mask is listed separately (its own group). */
export const TOOL_DEFS: readonly ToolDef[] = [
  { tool: 'select', labelKey: 'voice.annotations.select', Icon: MousePointer2, code: 'KeyV', keyLabel: 'V' },
  { tool: 'pen', labelKey: 'voice.annotations.pen', Icon: Pencil, code: 'KeyP', keyLabel: 'P' },
  { tool: 'highlighter', labelKey: 'voice.annotations.highlighter', Icon: Highlighter, code: 'KeyH', keyLabel: 'H' },
  { tool: 'rect', labelKey: 'voice.annotations.rectangle', Icon: Square, code: 'KeyR', keyLabel: 'R' },
  { tool: 'ellipse', labelKey: 'voice.annotations.ellipse', Icon: Circle, code: 'KeyO', keyLabel: 'O' },
  { tool: 'arrow', labelKey: 'voice.annotations.arrow', Icon: MoveUpRight, code: 'KeyA', keyLabel: 'A', v2: true },
  { tool: 'callout', labelKey: 'voice.annotations.callout', Icon: Hash, code: 'KeyN', keyLabel: 'N', v2: true },
  { tool: 'spotlight', labelKey: 'voice.annotations.spotlight', Icon: Sun, code: 'KeyS', keyLabel: 'S', v2: true },
  { tool: 'text', labelKey: 'voice.annotations.text', Icon: Type, code: 'KeyT', keyLabel: 'T' },
  { tool: 'laser', labelKey: 'voice.annotations.laser', Icon: Crosshair, code: 'KeyL', keyLabel: 'L' },
  { tool: 'eraser', labelKey: 'voice.annotations.eraser', Icon: Eraser, code: 'KeyE', keyLabel: 'E' },
  { tool: 'image', labelKey: 'voice.annotations.image', Icon: ImagePlus, code: 'KeyI', keyLabel: 'I' },
];

export const MASK_TOOL_DEF: ToolDef = { tool: 'mask', labelKey: 'voice.annotations.mask', Icon: ShieldOff, code: 'KeyM', keyLabel: 'M' };

/**
 * Tools the toolbar may offer right now. Phase 1 lands the new tools one at
 * a time: a tool is offered only once it has an editor case AND the server
 * validates its wire kind (v2 tools hide below annotationsVersion 2, so a
 * sharer on an older server never draws something it will reject after the
 * local echo).
 */
export const IMPLEMENTED_TOOLS: ReadonlySet<AnnotationEditorTool> = new Set<AnnotationEditorTool>([
  'select', 'pen', 'highlighter', 'rect', 'ellipse', 'arrow', 'callout', 'text', 'image', 'mask',
]);

export function availableToolDefs(annotationsVersion: number): ToolDef[] {
  return TOOL_DEFS.filter((d) => IMPLEMENTED_TOOLS.has(d.tool) && (!d.v2 || annotationsVersion >= 2));
}

export function toolDefFor(tool: AnnotationEditorTool): ToolDef | undefined {
  return tool === 'mask' ? MASK_TOOL_DEF : TOOL_DEFS.find((d) => d.tool === tool);
}
