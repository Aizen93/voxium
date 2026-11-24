/**
 * Ages read on this device's clock. No imports: the E2E service and the
 * stores share the one rule without pulling each other into their graphs.
 */

/**
 * Whether `at`, a time this device's clock wrote, lies less than `maxAgeMs`
 * behind the clock now. An age below zero (the clock was set back since) or
 * one that is not a finite number never is: what `at` dates counts as
 * expired, never as fresh until the clock catches up with it.
 */
export function isYoungerThan(at: number | undefined, maxAgeMs: number): boolean {
  if (typeof at !== 'number') return false;
  const age = Date.now() - at;
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}
