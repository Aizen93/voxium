import { useEffect } from 'react';
import { useAnnotationStore, type AnnotationEditorTool } from '../stores/annotationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ANNOTATION_COLORS, ANNOTATION_WIDTHS, MASK_TOOL_DEF, type ToolDef } from '../components/voice/annotationPresets';

/**
 * Keyboard control of the annotation editor, active only while the sharer is
 * editing. Tool keys come from TOOL_DEFS (one list with the toolbar), plus:
 *   Ctrl/⌘ Z undo · Ctrl/⌘ Shift Z or Ctrl/⌘ Y redo
 *   [ / ]   previous / next stroke width
 *   1–6     quick colours (the six swatches)
 *   Delete / Backspace  remove the selection (mask or object)
 *   Escape  drop the selection (the editor's caption input handles its own)
 *
 * Rules that matter more than the map:
 * - Never while typing: any INPUT / TEXTAREA / contentEditable target is left
 *   alone, so the chat composer keeps its Ctrl+Z and a caption keeps its P.
 * - Push-to-talk wins: while PTT is the voice mode, the shortcut whose code
 *   equals the PTT key is disabled (the tooltip hides it). The PTT hook
 *   listens on window too, and a key that both unmutes and switches tools is
 *   a surprise nobody wants.
 * - Tool keys are plain presses (no Ctrl/⌘/Alt) — modified letters belong to
 *   the app (Ctrl+K search) and the OS.
 */

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** The code push-to-talk currently owns, or null when PTT is not the voice mode. */
export function pttReservedCode(settings: { voiceMode: string; pushToTalkKey: string }): string | null {
  return settings.voiceMode === 'push_to_talk' ? settings.pushToTalkKey : null;
}

export function shortcutFor(def: ToolDef, reserved: string | null): string | null {
  return def.code === reserved ? null : def.keyLabel;
}

export function useAnnotationShortcuts(available: readonly ToolDef[]): void {
  const isEditing = useAnnotationStore((s) => s.isEditing);
  const voiceMode = useSettingsStore((s) => s.voiceMode);
  const pushToTalkKey = useSettingsStore((s) => s.pushToTalkKey);

  useEffect(() => {
    if (!isEditing) return;
    const reserved = pttReservedCode({ voiceMode, pushToTalkKey });
    const byCode = new Map<string, AnnotationEditorTool>();
    // The mask key rides along only while any tool is offered at all — an
    // empty list means this client has no editor, and no key should act
    for (const def of available.length > 0 ? [...available, MASK_TOOL_DEF] : []) {
      if (def.code !== reserved) byCode.set(def.code, def.tool);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;
      const store = useAnnotationStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      // History — the one place a modifier is expected
      if (mod && !e.altKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (e.shiftKey) store.redo(); else store.undo();
          return;
        }
        if (e.code === 'KeyY' && !e.shiftKey) {
          e.preventDefault();
          store.redo();
          return;
        }
        return; // every other modified key is not ours
      }
      if (e.altKey) return;
      if (e.code === reserved) return;

      if (e.key === 'Escape') {
        store.setSelectedObjectId(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedObjectId) {
        e.preventDefault();
        const id = store.selectedObjectId;
        if (store.masks.some((m) => m.id === id)) {
          store.removeMask(id);
        } else {
          store.localApply([{ t: 'remove', id }]);
          store.flushOps();
        }
        store.setSelectedObjectId(null);
        return;
      }

      const tool = byCode.get(e.code);
      if (tool) {
        e.preventDefault();
        store.setActiveTool(tool);
        return;
      }

      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        e.preventDefault();
        const i = ANNOTATION_WIDTHS.findIndex((w) => w.value === store.strokeWidth);
        const next = e.code === 'BracketLeft' ? Math.max(0, i - 1) : Math.min(ANNOTATION_WIDTHS.length - 1, i + 1);
        if (i === -1) store.setStrokeWidth(ANNOTATION_WIDTHS[1].value);
        else if (next !== i) store.setStrokeWidth(ANNOTATION_WIDTHS[next].value);
        return;
      }

      if (/^Digit[1-6]$/.test(e.code) && !e.shiftKey) {
        e.preventDefault();
        store.setColor(ANNOTATION_COLORS[Number(e.code.slice(5)) - 1]);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEditing, voiceMode, pushToTalkKey, available]);
}
