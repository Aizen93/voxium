/**
 * The sidebar positions of a space's channels and categories.
 *
 * A reorder writes the positions its client sends (the stock client sends
 * indexes, 0 to n - 1), and a creation places the new row after the highest
 * position of its kind in the space (positionAfter), read under the space row
 * lock so two concurrent creations never take the same one. The bound keeps
 * every written position, and so every later "highest + 1", far below
 * PostgreSQL's `integer` ceiling, the type of every `position` column:
 * without it, one reorder writing a huge position would make every later
 * creation in the space fail.
 */
export const MAX_SORT_POSITION = 1_000_000;

/** PostgreSQL's `integer` (int4) maximum. */
const PG_INT4_MAX = 2_147_483_647;

/** A whole number from 0 to MAX_SORT_POSITION. */
export function isSortPosition(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SORT_POSITION;
}

/**
 * The position after `highest`, the highest one held so far (null: none yet,
 * so 0). Clamped to the column's maximum, so a position written before
 * reorders were bounded costs a tie broken by id, never a failed creation.
 */
export function positionAfter(highest: number | null | undefined): number {
  return Math.min((highest ?? -1) + 1, PG_INT4_MAX);
}
