/**
 * Device ids as a human can read them back to someone.
 *
 * Shared because the same id is shown in two places that now live in different
 * features: the per-contact safety-number modal (a DM concern) and the
 * account-level device list (a Settings concern). Duplicating the formatter
 * would let the two drift, and the one thing a user does with a shortened id
 * is compare it against another screen.
 */
export function shortDeviceId(deviceId: string): string {
  return deviceId.length > 10 ? `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}` : deviceId;
}
