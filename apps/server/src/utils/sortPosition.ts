/**
 * The sidebar positions of a space's channels and categories.
 *
 * A reorder writes the positions its client sends (the stock client sends
 * indexes, 0 to n - 1). The bound keeps every written position far below
 * PostgreSQL's `integer` ceiling, the type of every `position` column.
 */
export const MAX_SORT_POSITION = 1_000_000;

/** A whole number from 0 to MAX_SORT_POSITION. */
export function isSortPosition(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SORT_POSITION;
}
