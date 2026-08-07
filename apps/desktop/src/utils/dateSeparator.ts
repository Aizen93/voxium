import { isSameDay, isToday, isYesterday, format } from 'date-fns';

/**
 * Date-separator helpers for the message list (2026 redesign): a hairline
 * "Today / Yesterday / July 14, 2026" divider between messages from different
 * calendar days.
 *
 * Kept as pure functions (no i18n, no React) so they are unit-testable; the
 * component maps the discriminant to a translated label.
 */

export type DaySeparator =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'date'; label: string };

/** True when `currIso` falls on a different calendar day than `prevIso`. */
export function isNewDay(prevIso: string | undefined, currIso: string): boolean {
  if (!prevIso) return true;
  const prev = new Date(prevIso);
  const curr = new Date(currIso);
  if (Number.isNaN(prev.getTime()) || Number.isNaN(curr.getTime())) return false;
  return !isSameDay(prev, curr);
}

/** Which separator to render above a message sent at `iso`. */
export function daySeparatorFor(iso: string): DaySeparator {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { kind: 'date', label: '' };
  if (isToday(date)) return { kind: 'today' };
  if (isYesterday(date)) return { kind: 'yesterday' };
  return { kind: 'date', label: format(date, 'MMMM d, yyyy') };
}
