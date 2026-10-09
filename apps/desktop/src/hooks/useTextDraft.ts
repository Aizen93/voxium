import { useRef, useState, useCallback, useLayoutEffect } from 'react';
import { ANNOTATION_TEXT_MAX, ANNOTATION_TEXT_FORBIDDEN_RE } from '@voxium/shared';

/** What the text tool is allowed to ship: trimmed, capped, and free of the
 *  control/bidi/zero-width characters the server rejects the WHOLE batch for
 *  (the local echo would already show a caption the viewers never get). */
export function sanitizeAnnotationText(raw: string): string {
  return raw
    .replace(new RegExp(ANNOTATION_TEXT_FORBIDDEN_RE.source, 'g'), '')
    .trim()
    .slice(0, ANNOTATION_TEXT_MAX);
}

export interface TextDraft {
  x: number;
  y: number;
  value: string;
  /** Set when editing an existing caption (commit patches instead of adding). */
  editingId?: string;
}

/**
 * The caption editor's draft, for new captions AND (later) for editing an
 * existing one. The draft lives in state (it renders) AND in a ref (it
 * commits): the commit runs from pointer, key and blur handlers that can fire
 * back-to-back for one gesture (Enter unmounts the input, which blurs it), so
 * it must be idempotent — and it must never run inside a setState updater,
 * which StrictMode invokes twice and would add the caption twice.
 */
export function useTextDraft(onCommit: (draft: TextDraft, text: string) => void) {
  const [draft, setDraftState] = useState<TextDraft | null>(null);
  const draftRef = useRef<TextDraft | null>(null);
  const onCommitRef = useRef(onCommit);
  useLayoutEffect(() => {
    onCommitRef.current = onCommit;
  });

  const set = useCallback((next: TextDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const open = useCallback((x: number, y: number, initial = '', editingId?: string) => {
    set({ x, y, value: initial, ...(editingId ? { editingId } : {}) });
  }, [set]);

  const setValue = useCallback((value: string) => {
    const current = draftRef.current;
    if (current) set({ ...current, value });
  }, [set]);

  const commit = useCallback(() => {
    const current = draftRef.current;
    if (!current) return;
    set(null);
    onCommitRef.current(current, sanitizeAnnotationText(current.value));
  }, [set]);

  const cancel = useCallback(() => set(null), [set]);

  return { draft, draftRef, open, setValue, commit, cancel };
}
