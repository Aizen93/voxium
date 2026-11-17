/**
 * Closing the profile popups of one person from outside the component that
 * opened them. A popup lives in the state of its hover target (UserHoverTarget),
 * wherever that target is rendered; when that person's account turns out to
 * be deleted (`dm:conversation:read_only`, services/dmReadOnly.ts), every
 * popup still open on them closes at once. No store: a popup is transient UI.
 */

type Listener = (userId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe to "close the popups of this user"; returns the unsubscribe. */
export function onCloseProfilePopups(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Close every open profile popup of `userId`. A listener that throws is logged and the rest still run. */
export function closeProfilePopupsOf(userId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(userId);
    } catch (err) {
      console.warn('[ProfilePopup] A close listener threw:', err instanceof Error ? err.message : err);
    }
  }
}
