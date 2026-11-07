/**
 * Secure-channel pins: "once secure, always secure" on THIS device.
 *
 * Every client decision that treats a channel as end-to-end encrypted used to
 * read the server's `secure` flag on the channel list. A server that answers
 * `secure: false` for a channel the device has already seen as secure would
 * downgrade the client: forged plaintext rows would render without the lock,
 * and the user's next message would leave the device unencrypted. The server
 * marks `secure` immutable at creation, so a flip can only be a lie or a bug —
 * either way the client must not follow it. Once a channel id is pinned here,
 * it stays secure for this account on this device.
 *
 * DEVICE-LOCAL AND PER USER, NEVER NETWORKED. Pins live in localStorage under
 * `vox:securePins:{userId}` (the `utils/maskLayouts.ts` pattern: validated on
 * load, write-through, an in-memory Set per user for synchronous reads).
 *
 * NEVER UN-PINNED except by `forgetSecurePins` on self-service account
 * deletion: not on `channel:deleted` (delete-then-recreate under the same id
 * is the obvious bypass), not on leave or kick, not on logout (the E2E vault
 * survives logout too). Growth is a handful of short ids per account.
 *
 * Pure module: no store import. authStore → resetStores → serverStore is an
 * import chain already, so the active account is pushed in by authStore
 * (`activateSecurePins` / `deactivateSecurePins`) rather than read from it.
 */

const STORAGE_PREFIX = 'vox:securePins:';

/** A channel id as the server mints them. Anything else in the stored blob is
 *  dropped on load — a corrupted entry must not throw or match by accident. */
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function securePinStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

const isChannelId = (v: unknown): v is string => typeof v === 'string' && CHANNEL_ID_RE.test(v);

/** Pins remembered in memory per user, kept across deactivate/activate so a
 *  pin whose localStorage write failed (quota, blocked storage) still holds
 *  for the rest of the process when the same account logs back in. */
const memory = new Map<string, Set<string>>();

let activeUserId: string | null = null;
let activePins: Set<string> | null = null;

/** Channels this session has already warned about, so a refetch storm does
 *  not stack toasts. Cleared on every activation (a new login is a new
 *  session). */
let warnedDowngrades = new Set<string>();

function loadPins(userId: string): Set<string> {
  const pins = new Set<string>();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(securePinStorageKey(userId)) : null;
    if (!raw) return pins;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn('[SecurePins] Ignoring a stored pin set that is not a list');
      return pins;
    }
    for (const id of parsed) if (isChannelId(id)) pins.add(id);
  } catch (err) {
    console.warn('[SecurePins] Could not read stored pins:', err instanceof Error ? err.message : err);
  }
  return pins;
}

function savePins(userId: string, pins: Set<string>): void {
  try {
    localStorage.setItem(securePinStorageKey(userId), JSON.stringify([...pins]));
  } catch (err) {
    console.warn('[SecurePins] Could not save pins:', err instanceof Error ? err.message : err);
  }
}

/** The account whose pins every read and write now addresses. */
export function activateSecurePins(userId: string): void {
  const pins = loadPins(userId);
  const remembered = memory.get(userId);
  if (remembered) for (const id of remembered) pins.add(id);
  memory.set(userId, pins);
  activeUserId = userId;
  activePins = pins;
  warnedDowngrades = new Set<string>();
}

/** Logout: forget WHICH account is active. The pins themselves stay — the same
 *  account gets them back on its next login. */
export function deactivateSecurePins(): void {
  activeUserId = null;
  activePins = null;
}

/** Pin a channel the device has seen as secure. Returns true when the pin is
 *  new. A no-op before activation (there is no account to pin it to). */
export function pinSecure(channelId: string): boolean {
  if (!activeUserId || !activePins || !isChannelId(channelId)) return false;
  if (activePins.has(channelId)) return false;
  activePins.add(channelId);
  savePins(activeUserId, activePins);
  return true;
}

/** Whether this account has seen the channel as secure on this device.
 *  Answers false before activation. */
export function isPinnedSecure(channelId: string | null | undefined): boolean {
  if (!activePins || typeof channelId !== 'string') return false;
  return activePins.has(channelId);
}

/** True the FIRST time per session a downgrade of `channelId` is reported, so
 *  the caller warns once instead of on every refetch. */
export function claimDowngradeWarning(channelId: string): boolean {
  if (warnedDowngrades.has(channelId)) return false;
  warnedDowngrades.add(channelId);
  return true;
}

/** Self-service account deletion only: every key the pins pair with is gone. */
export function forgetSecurePins(userId: string): void {
  memory.delete(userId);
  if (activeUserId === userId && activePins) activePins = new Set<string>();
  try {
    localStorage.removeItem(securePinStorageKey(userId));
  } catch (err) {
    console.warn('[SecurePins] Could not remove stored pins:', err instanceof Error ? err.message : err);
  }
}
