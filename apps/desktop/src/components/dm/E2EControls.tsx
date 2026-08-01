import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Lock, ShieldCheck, ShieldAlert, X, Laptop2, Trash2, KeyRound, Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { useDMStore } from '../../stores/dmStore';
import { useE2EStore, E2ELinkingCodeUnknownError, type E2ELinkableDevice } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import {
  getE2EService,
  E2ERecoveryKeyFormatError,
  type E2EAccountSafetyNumber,
  type E2EDeviceSafetyNumber,
  type E2EOwnDevices,
} from '../../services/e2e/e2eService';
import type { Conversation } from '@voxium/shared';

/**
 * Stable empty array for selectors. Defaulting INSIDE a zustand selector
 * (`?? []`) allocates a new reference on every read, so useSyncExternalStore
 * never sees an equal snapshot and React re-renders forever — it took down the
 * whole chat area behind the error boundary.
 */
const NO_DEVICES: string[] = [];

interface Props {
  conversation: Conversation;
}

/**
 * What the header lock is trying to say, as ONE decision.
 *
 * The tooltip and the alert icon used to be two independent expressions over
 * the same seven flags, in different orders — which is how an identity change,
 * the strongest MITM signal in the design, ended up showing the amber icon
 * above the tooltip "End-to-end encrypted", i.e. an alarm captioned with
 * reassurance. Deriving both from one ordered list makes that class of bug
 * impossible: a state that raises the icon necessarily names itself.
 *
 * Account-wide states are reported only on an ENCRYPTED conversation. On a
 * plaintext one this control is the "turn encryption on" button, so warning
 * about a device you have not approved would caption a button that does
 * something else entirely.
 */
export function badgeState(flags: {
  encrypted: boolean;
  identityWarning: boolean;
  masterKeyConflict: boolean;
  thisDeviceUnsigned: boolean;
  unsignedWarning: boolean;
  ownDeviceWarning: boolean;
  newDeviceWarning: boolean;
}): { titleKey: string; warning: boolean } {
  if (!flags.encrypted) return { titleKey: 'e2e.enableTitle', warning: false };
  // Most alarming first, and every entry names the problem it stands for.
  const states: Array<[boolean, string]> = [
    [flags.identityWarning, 'e2e.identityChangedBadgeTitle'],
    [flags.masterKeyConflict, 'e2e.masterConflictBadgeTitle'],
    [flags.thisDeviceUnsigned, 'e2e.thisDeviceUnsignedBadgeTitle'],
    [flags.unsignedWarning, 'e2e.unsignedDeviceBadgeTitle'],
    [flags.ownDeviceWarning, 'e2e.ownDeviceBadgeTitle'],
    [flags.newDeviceWarning, 'e2e.newDeviceBadgeTitle'],
  ];
  const hit = states.find(([on]) => on);
  return hit ? { titleKey: hit[1], warning: true } : { titleKey: 'e2e.badgeTitle', warning: false };
}

/**
 * Header control for DM encryption: an enable button for plaintext
 * conversations, a lock badge (→ safety-number modal) for encrypted ones.
 */
export function E2EControls({ conversation }: Props) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const e2eReady = useE2EStore((s) => s.ready);
  const peerId = conversation.participant.id;
  const identityWarning = useE2EStore((s) => !!s.identityWarnings[peerId]);
  const newDeviceWarning = useE2EStore((s) => (s.newDeviceWarnings[peerId]?.length ?? 0) > 0);
  // A device added to OUR account that we did not add is as dangerous as an
  // injected peer device: it receives every session key we fan out (§12.5).
  const ownDeviceWarning = useE2EStore((s) => s.ownDeviceWarnings.length > 0);
  // A device the account key does not vouch for is exactly what cross-signing
  // exists to expose — it must reach the badge, not just the advanced panel.
  const unsignedPeerWarning = useE2EStore((s) => (s.unsignedDeviceWarnings[peerId]?.length ?? 0) > 0);
  const ownUnsignedWarning = useE2EStore((s) => s.ownUnsignedDevices.length > 0);
  // This device itself unapproved, or an account key we can neither prove nor
  // replace: both are states the user can only learn about from us.
  const thisDeviceUnsigned = useE2EStore((s) => s.thisDeviceUnsigned);
  const masterKeyConflict = useE2EStore((s) => s.masterKeyConflict);
  const [modal, setModal] = useState<'enable' | 'safety' | null>(null);

  const encrypted = !!conversation.encryptedAt;

  // Passively check for peer device-list changes while an encrypted
  // conversation is open — the only trigger besides an explicit send/decrypt.
  useEffect(() => {
    if (!e2eReady || !encrypted || !user?.id) return;
    void useE2EStore.getState().refreshDeviceList(user.id, peerId);
  }, [e2eReady, encrypted, user?.id, peerId]);

  if (!e2eReady) return null;

  const { titleKey, warning } = badgeState({
    encrypted,
    identityWarning,
    masterKeyConflict,
    thisDeviceUnsigned,
    unsignedWarning: ownUnsignedWarning || unsignedPeerWarning,
    ownDeviceWarning,
    newDeviceWarning,
  });
  const title = t(titleKey);

  return (
    <>
      <button
        onClick={() => setModal(encrypted ? 'safety' : 'enable')}
        className={clsx(
          'rounded-md p-1.5 transition-colors',
          warning
            ? 'text-vox-accent-warning hover:bg-vox-accent-warning/10'
            : encrypted
              ? 'text-vox-accent-success hover:bg-vox-accent-success/10'
              : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
        )}
        title={title}
        // Same string as the tooltip: an alert nobody can hover is not an alert.
        aria-label={title}
      >
        {warning ? <ShieldAlert size={18} /> : <Lock size={18} />}
      </button>
      {modal === 'enable' && (
        <EnableEncryptionModal conversation={conversation} onClose={() => setModal(null)} />
      )}
      {modal === 'safety' && (
        <SafetyNumberModal conversation={conversation} onClose={() => setModal(null)} />
      )}
    </>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg bg-vox-bg-primary p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function EnableEncryptionModal({ conversation, onClose }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const handleEnable = async () => {
    setBusy(true);
    try {
      await useDMStore.getState().enableEncryption(conversation.id);
      toast.success(t('e2e.enabled'));
      onClose();
    } catch (err) {
      const apiError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(apiError ?? t('e2e.enableFailed'));
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-vox-text-primary">
          <Lock size={16} className="text-vox-accent-success" />
          {t('e2e.enableTitle')}
        </h3>
        <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>
      <p className="mb-2 text-sm text-vox-text-secondary">{t('e2e.enableExplainer')}</p>
      <ul className="mb-4 list-inside list-disc space-y-1 text-xs text-vox-text-muted">
        <li>{t('e2e.enablePointIrreversible')}</li>
        <li>{t('e2e.enablePointServer')}</li>
      </ul>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-vox-text-secondary hover:bg-vox-bg-hover"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={handleEnable}
          disabled={busy}
          className="rounded-md bg-vox-accent-success px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('common.loading') : t('e2e.enableConfirm')}
        </button>
      </div>
    </ModalShell>
  );
}

function shortDeviceId(deviceId: string): string {
  return deviceId.length > 10 ? `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}` : deviceId;
}

/**
 * Clipboard write that still works where the async API is not available: the
 * Tauri webview and plain `http://localhost` both fall out of
 * `window.isSecureContext` and would otherwise silently do nothing.
 *
 * Throws instead of reporting its own failure, so each caller can name what
 * did not get copied. Both of the strings this handles — a recovery key that
 * is shown once, a linking code the user is about to carry to another device —
 * are ones where "copy quietly did nothing" is the worst outcome.
 */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  field.focus();
  field.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(field);
  if (!ok) throw new Error('copy rejected');
}

function SafetyNumberModal({ conversation, onClose }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const peerId = conversation.participant.id;
  const peerName = conversation.participant.displayName;
  const identityWarning = useE2EStore((s) => !!s.identityWarnings[peerId]);
  const newDeviceIds = useE2EStore((s) => s.newDeviceWarnings[peerId]) ?? NO_DEVICES;
  // Surfaced at the top of the modal, not only inside the collapsed advanced
  // panel: "this device is not signed by their account key" is the headline.
  const unsignedDeviceIds = useE2EStore((s) => s.unsignedDeviceWarnings[peerId]) ?? NO_DEVICES;
  const accountVerified = useE2EStore((s) => !!s.accountVerified[peerId]);
  const [account, setAccount] = useState<E2EAccountSafetyNumber | null>(null);
  const [accountError, setAccountError] = useState(false);
  const [devices, setDevices] = useState<E2EDeviceSafetyNumber[] | null>(null);
  const [error, setError] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDeviceManager, setShowDeviceManager] = useState(false);

  const load = () => {
    if (!user?.id) return;
    const service = getE2EService(user.id);
    service
      .accountSafetyNumber(peerId)
      .then((result) => {
        if (result) setAccount(result);
        else setAccountError(true);
      })
      .catch((err) => {
        console.warn('e2e: account safety number unavailable:', err instanceof Error ? err.message : err);
        setAccountError(true);
      });
    service
      .perDeviceSafetyNumbers(peerId)
      .then((result) => {
        if (result.length > 0) setDevices(result);
        else setError(true);
      })
      .catch((err) => {
        console.warn('e2e: safety numbers unavailable:', err instanceof Error ? err.message : err);
        setError(true);
      });
  };

  // `load` is re-created every render; keying on the ids it closes over is
  // intentional (this project's ESLint has no react-hooks plugin, so there is
  // no exhaustive-deps rule to disable here).
  useEffect(() => {
    load();
  }, [user?.id, peerId]);

  const handleMarkAccountVerified = async () => {
    if (!user?.id) return;
    await useE2EStore.getState().markAccountVerified(user.id, peerId);
    setAccount((prev) => (prev ? { ...prev, verified: true } : prev));
  };

  const handleMarkVerified = async (deviceId: string) => {
    if (!user?.id) return;
    await getE2EService(user.id).markDeviceVerified(peerId, deviceId);
    setDevices((prev) => prev?.map((d) => (d.deviceId === deviceId ? { ...d, verified: true } : d)) ?? prev);
  };

  const handleAcceptNewIdentity = async () => {
    if (!user?.id) return;
    try {
      await useE2EStore.getState().acceptNewIdentity(user.id, peerId);
      setAccount(null);
      setAccountError(false);
      setDevices(null);
      load();
      toast.success(t('e2e.identityAccepted'));
    } catch (err) {
      console.warn('e2e: accepting new identity failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.enableFailed'));
    }
  };

  const handleReviewDevices = async () => {
    if (!user?.id) return;
    try {
      // Acknowledge exactly the devices this modal rendered — anything that
      // appeared since must keep warning.
      await useE2EStore.getState().acknowledgeDeviceList(user.id, peerId, (devices ?? []).map((d) => d.deviceId));
      toast.success(t('e2e.devicesReviewed'));
    } catch (err) {
      console.warn('e2e: acknowledging device list failed:', err instanceof Error ? err.message : err);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold text-vox-text-primary">
          {accountVerified ? <ShieldCheck size={16} className="text-vox-accent-success" /> : <Lock size={16} className="text-vox-accent-success" />}
          {t('e2e.safetyNumberTitle')}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowDeviceManager(true)}
            className="rounded-md p-1 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary"
            title={t('e2e.manageDevices')}
            aria-label={t('e2e.manageDevices')}
          >
            <Laptop2 size={16} />
          </button>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
      </div>

      {identityWarning && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-warning/10 p-3 text-xs text-vox-accent-warning">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="mb-2">{t('e2e.identityChangedWarning', { name: peerName })}</p>
            <button
              onClick={handleAcceptNewIdentity}
              className="rounded bg-vox-accent-warning px-2 py-1 font-medium text-black hover:opacity-90"
            >
              {t('e2e.acceptNewIdentity')}
            </button>
          </div>
        </div>
      )}

      {unsignedDeviceIds.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-warning/10 p-3 text-xs text-vox-accent-warning">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <p>
            {t('e2e.unsignedDevicesWarning', { name: peerName, count: unsignedDeviceIds.length })}
          </p>
        </div>
      )}

      {!identityWarning && newDeviceIds.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-warning/10 p-3 text-xs text-vox-accent-warning">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="mb-2">{t('e2e.newDeviceWarning', { name: peerName })}</p>
            <button
              onClick={handleReviewDevices}
              className="rounded bg-vox-accent-warning px-2 py-1 font-medium text-black hover:opacity-90"
            >
              {t('e2e.reviewDevices')}
            </button>
          </div>
        </div>
      )}

      {/* Account-level safety number: the primary UX (spec §14, D3). One
          60-digit number covers every device either side has or ever adds,
          as long as neither account's key is reset. */}
      <p className="mb-3 text-xs text-vox-text-muted">{t('e2e.accountSafetyExplainer', { name: peerName })}</p>

      {account ? (
        <div className="mb-4 rounded-md bg-vox-bg-secondary p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className={clsx('text-xs', account.verified ? 'text-vox-accent-success' : 'text-vox-text-muted')}>
              {account.verified ? t('e2e.verified') : t('e2e.notVerified')}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-center font-mono text-sm text-vox-text-primary select-all">
            {(account.digits.match(/.{5}/g) ?? []).map((group, i) => (
              <span key={i}>{group}</span>
            ))}
          </div>
          {!account.verified && (
            <div className="mt-2 flex justify-end">
              <button
                onClick={handleMarkAccountVerified}
                className="rounded-md bg-vox-accent-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
              >
                {t('e2e.markAccountVerified')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-sm text-vox-text-muted">
          {accountError ? t('e2e.accountSafetyNumberUnavailable') : t('common.loading')}
        </p>
      )}

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="mb-2 text-xs font-medium text-vox-text-muted hover:text-vox-text-primary"
      >
        {showAdvanced ? '▾ ' : '▸ '}
        {t('e2e.advancedDevices')}
      </button>

      {showAdvanced && (
        <>
          <p className="mb-3 text-xs text-vox-text-muted">{t('e2e.perDeviceSafetyExplainer', { name: peerName })}</p>

          {devices ? (
            <div className="mb-4 max-h-80 space-y-3 overflow-y-auto">
              {devices.map((device) => (
                <div key={device.deviceId} className="rounded-md bg-vox-bg-secondary p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span
                      className={clsx(
                        'font-mono text-[11px]',
                        newDeviceIds.includes(device.deviceId) ? 'text-vox-accent-warning' : 'text-vox-text-muted'
                      )}
                    >
                      {shortDeviceId(device.deviceId)}
                    </span>
                    <div className="flex items-center gap-1">
                      <span
                        className={clsx(
                          'rounded px-1.5 py-0.5 text-[10px] font-medium',
                          device.crossSigned
                            ? 'bg-vox-accent-success/15 text-vox-accent-success'
                            : 'bg-vox-accent-warning/15 text-vox-accent-warning'
                        )}
                      >
                        {device.crossSigned ? t('e2e.crossSignedChip') : t('e2e.unsignedChip', { name: peerName })}
                      </span>
                      <span className={clsx('text-xs', device.verified ? 'text-vox-accent-success' : 'text-vox-text-muted')}>
                        {device.verified ? t('e2e.verified') : t('e2e.notVerified')}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-center font-mono text-sm text-vox-text-primary select-all">
                    {(device.digits.match(/.{5}/g) ?? []).map((group, i) => (
                      <span key={i}>{group}</span>
                    ))}
                  </div>
                  {!device.verified && (
                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => handleMarkVerified(device.deviceId)}
                        className="rounded-md bg-vox-accent-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                      >
                        {t('e2e.markVerified')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-4 text-sm text-vox-text-muted">
              {error ? t('e2e.safetyNumberUnavailable') : t('common.loading')}
            </p>
          )}
        </>
      )}

      {showDeviceManager && <DeviceManagerModal onClose={() => setShowDeviceManager(false)} />}
    </ModalShell>
  );
}

/**
 * Should the device manager offer to start a NEW account identity (spec §14.4)?
 *
 * Only when nothing else can rescue this device. If any OTHER device of the
 * account is cross-signed, it may still hold the account key, so the answer is
 * "approve this device from that one" — not a reset. Without that condition the
 * destructive action appears during ordinary second-device setup, the most
 * common state in the whole flow, and taking it strips the approval from the
 * device that was about to help.
 */
export function shouldOfferIdentityReset({
  ownDevices,
  canApprove,
  masterKeyConflict,
}: {
  ownDevices: E2EOwnDevices | null;
  canApprove: boolean;
  masterKeyConflict: boolean;
}): boolean {
  if (!ownDevices) return false;
  // A node that does not understand cross-signing cannot report a signature, so
  // its answer makes every device look unsigned. Reading that as "nothing can
  // approve me" would put the destructive action on screen during an ordinary
  // rolling deploy — the exact window the capability flag exists to survive.
  if (!ownDevices.capabilityServed) return false;
  // An account key this device can neither prove nor replace has no other exit.
  // (When this device HOLDS the key, the service re-publishes it instead of
  // minting a new one, so no safety number changes.)
  if (masterKeyConflict) return true;
  if (canApprove) return false;
  if (!ownDevices.devices.some((d) => !d.crossSigned)) return false;
  return !ownDevices.devices.some(
    (d) => d.deviceId !== ownDevices.currentDeviceId && d.crossSigned
  );
}

/**
 * Should the device manager offer to RESTORE from a key backup (spec §15.4)?
 *
 * Only when this device cannot approve — a device that already holds the
 * account key has nothing to recover — and only when a backup is KNOWN to
 * exist. `null` is "not read yet", not "no backup": rendering the box on that
 * guess sends a user hunting for a recovery key that was never created, on the
 * one screen they reached precisely because they had lost access to everything
 * else.
 */
export function shouldOfferKeyBackupRestore({
  keyBackup,
  canApprove,
}: {
  keyBackup: { exists: boolean } | null;
  canApprove: boolean;
}): boolean {
  return !canApprove && keyBackup?.exists === true;
}

/**
 * The recovery key, shown ONCE (spec §15.2).
 *
 * No close button, and the backdrop is inert on purpose: every exit other than
 * the acknowledgement is one stray click away from losing a key that cannot be
 * shown again and cannot be re-derived — not by us, not by the server, not by
 * the engine that minted it. A dialog dismissed by accident leaves the user
 * believing they have a recovery key, which is worse than having none.
 */
function RecoveryKeyDialog({
  recoveryKey,
  onAcknowledge,
}: {
  recoveryKey: string;
  onAcknowledge: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('e2e: copying the recovery key failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.backupCopyFailed'));
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70"
      onClick={(e) => e.stopPropagation()}
      data-testid="e2e-recovery-key-dialog"
    >
      <div className="w-full max-w-md rounded-lg bg-vox-bg-primary p-5 shadow-xl">
        <h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-vox-text-primary">
          <KeyRound size={16} className="text-vox-accent-primary" />
          {t('e2e.backupKeyTitle')}
        </h3>

        <div className="mb-3 rounded-md border border-vox-accent-warning/20 bg-vox-accent-warning/10 px-3 py-2">
          <p className="text-xs font-medium text-vox-accent-warning">{t('e2e.backupKeyWarning')}</p>
          <p className="mt-1 text-[11px] text-vox-accent-warning/80">{t('e2e.backupKeyLoss')}</p>
        </div>

        {/* select-all so a triple-click or ⌘A grabs the whole key and nothing
            else — a half-selected recovery key restores nothing. */}
        <code
          className="mb-3 block rounded-md border border-vox-border bg-vox-bg-secondary px-3 py-3 text-center font-mono text-sm leading-relaxed break-all text-vox-text-primary select-all"
          data-testid="e2e-recovery-key"
        >
          {recoveryKey}
        </code>

        <button
          onClick={handleCopy}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-md border border-vox-border px-3 py-2 text-xs text-vox-text-secondary hover:bg-vox-bg-hover"
        >
          {copied ? <Check size={14} className="text-vox-accent-success" /> : <Copy size={14} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>

        <label className="mb-3 flex cursor-pointer items-start gap-2 text-xs text-vox-text-secondary">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 accent-vox-accent-primary"
          />
          <span>{t('e2e.backupKeyAcknowledge')}</span>
        </label>

        <button
          onClick={onAcknowledge}
          disabled={!saved}
          className="w-full rounded-md bg-vox-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('e2e.backupKeyDone')}
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * Which half of the linking flow (plan §4.3) this device is on, if either.
 *
 * `enter` wins a hypothetical tie: a device that holds the account key can
 * already act, so showing it a code to be approved WITH would be asking it to
 * wait for permission it does not need. `show` is the state a fresh install
 * lands in — unsigned, unable to decrypt anything — and there the code is the
 * only thing on this screen that leads anywhere.
 */
export function deviceLinkingMode({
  thisDeviceUnsigned,
  canApprove,
}: {
  thisDeviceUnsigned: boolean;
  canApprove: boolean;
}): 'show' | 'enter' | null {
  if (canApprove) return 'enter';
  if (thisDeviceUnsigned) return 'show';
  return null;
}

/**
 * The code THIS device shows so an already-approved one can approve it.
 *
 * It is derived from keys the server already publishes for this device, so it
 * carries no secret and is worth nothing to whoever reads it over the user's
 * shoulder: approving still requires the other device to hold the account key
 * and its user to confirm. That is why it can be rendered plainly, copied, and
 * read aloud — the value only ever travels from the new device to the old one.
 */
function LinkingCodeBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('e2e: copying the linking code failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.linkCopyFailed'));
    }
  };

  return (
    <>
      <p className="mb-2">{t('e2e.linkCodeExplainer')}</p>
      {/* select-all so a triple-click grabs the whole code and nothing else —
          half a linking code matches no device and reads as "wrong code". */}
      <code
        className="mb-2 block rounded-md border border-vox-border bg-vox-bg-primary px-3 py-3 text-center font-mono text-lg tracking-[0.3em] text-vox-text-primary select-all"
        data-testid="e2e-linking-code"
      >
        {code}
      </code>
      <button
        onClick={handleCopy}
        className="flex items-center justify-center gap-1.5 rounded border border-vox-border px-2 py-1 font-medium text-vox-text-secondary hover:bg-vox-bg-hover"
      >
        {copied ? <Check size={12} className="text-vox-accent-success" /> : <Copy size={12} />}
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </>
  );
}

/**
 * Enter the code the OTHER device is showing (plan §4.3, steps 3-6).
 *
 * Two steps, never one. Looking a code up proves nothing about who typed it:
 * the residual risk this flow carries is phishing — a user talked into
 * entering an attacker's code — and the mitigation is that this device names
 * what it is about to approve, from the server's own record, before anything
 * happens. So the lookup only ever fills in the confirmation, and the button
 * that approves is a different button, next to the device id and the date the
 * user can check against the machine in front of them. Collapsing the two
 * would remove the only thing standing between a phished code and the account
 * key, so it must not be skippable — not by Enter, not by a code that happens
 * to look complete.
 */
function LinkDeviceForm({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<E2ELinkableDevice | null>(null);
  const [error, setError] = useState<'unknown' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);

  const handleLookup = async () => {
    setBusy(true);
    setError(null);
    try {
      setPending(await useE2EStore.getState().linkDevice(userId, code));
    } catch (err) {
      // "Nothing is showing that code" and "the lookup never got an answer"
      // send the user to different places — retype vs retry — so they are told
      // apart here rather than collapsed into one apology.
      if (err instanceof E2ELinkingCodeUnknownError) {
        setError('unknown');
      } else {
        console.warn('e2e: looking up a linking code failed:', err instanceof Error ? err.message : err);
        setError('failed');
      }
      // The code stays in the box either way: a user who mistyped one
      // character should fix that character, not retype the whole thing off a
      // screen that is in another room.
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await useE2EStore.getState().approveLinkedDevice(userId, pending.deviceId);
      toast.success(t('e2e.approveDeviceSuccess'));
      setPending(null);
      setCode('');
    } catch (err) {
      console.warn('e2e: approving a linked device failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.approveDeviceFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <div data-testid="e2e-link-confirm">
        <p className="mb-1 font-medium text-vox-text-secondary">{t('e2e.linkConfirmTitle')}</p>
        {/* What the user can actually check: the id the new device shows in its
            own device list, and when it registered. */}
        <p className="mb-2 font-mono text-[11px] text-vox-text-primary">
          {t('e2e.linkConfirmDevice', {
            id: shortDeviceId(pending.deviceId),
            date: new Date(pending.createdAt).toLocaleString(),
          })}
        </p>
        <p className="mb-2 text-vox-accent-warning">{t('e2e.linkConfirmExplainer')}</p>
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            disabled={busy}
            className="rounded bg-vox-accent-primary px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('common.loading') : t('e2e.linkConfirmAction')}
          </button>
          <button
            onClick={() => setPending(null)}
            className="rounded px-2 py-1 hover:text-vox-text-primary"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="mb-2">{t('e2e.linkExplainer')}</p>
      <input
        type="text"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
        // Enter runs the LOOKUP and nothing else. It is safe precisely because
        // the lookup is inert: it reaches the confirmation, which is a separate
        // control the user still has to press. Nothing here may ever be wired
        // to approve — a key that both submits and confirms is the same
        // one-step flow this design exists to avoid.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy && code.trim().length > 0) void handleLookup();
        }}
        placeholder={t('e2e.linkPlaceholder')}
        aria-label={t('e2e.linkTitle')}
        spellCheck={false}
        autoComplete="off"
        data-testid="e2e-link-code-input"
        className="mb-2 w-full rounded-md border border-vox-border bg-vox-bg-primary px-2 py-1.5 font-mono text-xs tracking-wide text-vox-text-primary uppercase focus:border-vox-accent-primary focus:outline-none"
      />
      {error && (
        <p className="mb-2 text-vox-accent-danger" role="alert">
          {t(error === 'unknown' ? 'e2e.linkUnknownCode' : 'e2e.linkLookupFailed')}
        </p>
      )}
      <button
        onClick={handleLookup}
        disabled={busy || code.trim().length === 0}
        className="rounded bg-vox-accent-primary px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? t('common.loading') : t('e2e.linkAction')}
      </button>
    </>
  );
}

/**
 * Device linking (plan §4.3): "type the code your new device is showing",
 * replacing "find the unfamiliar device in a list and press Approve".
 *
 * It is the same approval underneath — no new cryptography — but a safer
 * trigger for it: this device recomputes the code from the keys the SERVER
 * served, so a device the server injected produces a different code and cannot
 * be reached by a user typing what their own new device displays. The list
 * flow, where the user picks a row with nothing to compare it against, stays
 * available below as the fallback.
 */
function DeviceLinkingSection({
  userId,
  mode,
  code,
}: {
  userId: string;
  mode: 'show' | 'enter';
  /** This device's own code — `null` while the account keys are not loaded. */
  code: string | null;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="mb-3 rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted"
      data-testid="e2e-device-linking"
    >
      <p className="mb-1.5 font-medium text-vox-text-secondary">
        {t(mode === 'show' ? 'e2e.linkCodeTitle' : 'e2e.linkTitle')}
      </p>
      {mode === 'show' && code ? <LinkingCodeBlock code={code} /> : null}
      {mode === 'enter' ? <LinkDeviceForm userId={userId} /> : null}
    </div>
  );
}

/**
 * Account recovery (spec §15): the only thing standing between "lost every
 * device" and the identity reset below, which costs every contact a
 * re-verification. Restoring keeps the account key, so nobody is prompted —
 * which is why this section is rendered ABOVE the reset affordance and the
 * reset is framed as the last resort it is.
 */
function KeyBackupSection({
  userId,
  noBackupNotice,
}: {
  userId: string;
  /** Is the identity reset on screen? Then "there is no backup" is the reason for it. */
  noBackupNotice: boolean;
}) {
  const { t } = useTranslation();
  const keyBackup = useE2EStore((s) => s.keyBackup);
  const canApprove = useE2EStore((s) => s.canApprove);
  const [confirming, setConfirming] = useState<'replace' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The recovery key lives HERE and nowhere else: component state dies with the
   * dialog, whereas the store survives the modal, the route and any state dump
   * a devtools extension or a bug report might take with it (§15.2).
   */
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [restoreInput, setRestoreInput] = useState('');
  const [restoreError, setRestoreError] = useState<'malformed' | 'failed' | null>(null);

  const handleCreate = async () => {
    setBusy(true);
    try {
      setRecoveryKey(await useE2EStore.getState().createKeyBackup(userId));
      setConfirming(null);
    } catch (err) {
      console.warn('e2e: creating the key backup failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.backupCreateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await useE2EStore.getState().deleteKeyBackup(userId);
      toast.success(t('e2e.backupDeleted'));
      setConfirming(null);
    } catch (err) {
      console.warn('e2e: deleting the key backup failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.backupDeleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    setBusy(true);
    setRestoreError(null);
    try {
      await useE2EStore.getState().restoreKeyBackup(userId, restoreInput);
      // Only now: the store has re-read this device's status, so the panel
      // below is already showing that it can approve others again.
      setRestoreInput('');
      setRestoreError(null);
      toast.success(t('e2e.backupRestoreSuccess'));
    } catch (err) {
      // A mistyped key and an unreachable server both land here. The message
      // says "try again" rather than guessing which, and the detail goes to the
      // log — a restore that failed must never read as one that worked.
      // A key that fails its own checksum never left the device, and saying
      // "check it for typos" is only honest for that case: everything else
      // means this key does not open what the account actually has.
      console.warn('e2e: restoring from the key backup failed:', err instanceof Error ? err.message : err);
      setRestoreError(err instanceof E2ERecoveryKeyFormatError ? 'malformed' : 'failed');
    } finally {
      setBusy(false);
    }
  };

  // Unknown state: say nothing rather than offer an action that is wrong in one
  // direction or the other (see shouldOfferKeyBackupRestore).
  if (!keyBackup) return null;
  const canRestore = shouldOfferKeyBackupRestore({ keyBackup, canApprove });
  // Nothing to offer and nothing worth saying: a second device waiting for an
  // ordinary approval — the most common state in the whole flow — does not need
  // to be told about a backup that does not exist. That line earns its place
  // only next to the reset, where it is the reason the reset is the way out.
  if (!canApprove && !canRestore && !noBackupNotice) return null;

  const body = () => {
    if (!canApprove) {
      if (!canRestore) {
        // Named explicitly: it is the reason the reset below is the only way
        // out, and a user who thinks they might have a key deserves the answer.
        return <p>{t('e2e.backupNone')}</p>;
      }
      return (
        <>
          <p className="mb-2">{t('e2e.backupRestoreExplainer')}</p>
          <input
            type="text"
            value={restoreInput}
            onChange={(e) => {
              setRestoreInput(e.target.value);
              setRestoreError(null);
            }}
            placeholder={t('e2e.backupRestorePlaceholder')}
            aria-label={t('e2e.backupRestoreTitle')}
            spellCheck={false}
            autoComplete="off"
            data-testid="e2e-restore-key-input"
            className="mb-2 w-full rounded-md border border-vox-border bg-vox-bg-primary px-2 py-1.5 font-mono text-xs tracking-wide text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
          />
          {restoreError && (
            <p className="mb-2 text-vox-accent-danger" role="alert">
              {t(restoreError === 'malformed' ? 'e2e.backupRestoreMalformed' : 'e2e.backupRestoreFailed')}
            </p>
          )}
          <button
            onClick={handleRestore}
            disabled={busy || restoreInput.trim().length === 0}
            className="rounded bg-vox-accent-primary px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('common.loading') : t('e2e.backupRestoreAction')}
          </button>
        </>
      );
    }

    if (confirming === 'replace') {
      return (
        <>
          <p className="mb-2 text-vox-accent-warning">{t('e2e.backupReplaceConfirm')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={busy}
              className="rounded bg-vox-accent-warning px-2 py-1 font-medium text-black hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('common.loading') : t('e2e.backupReplaceAction')}
            </button>
            <button onClick={() => setConfirming(null)} className="rounded px-2 py-1 hover:text-vox-text-primary">
              {t('common.cancel')}
            </button>
          </div>
        </>
      );
    }

    if (confirming === 'delete') {
      return (
        <>
          <p className="mb-2 text-vox-accent-danger">{t('e2e.backupDeleteConfirm')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={busy}
              className="rounded bg-vox-accent-danger px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('common.loading') : t('common.confirm')}
            </button>
            <button onClick={() => setConfirming(null)} className="rounded px-2 py-1 hover:text-vox-text-primary">
              {t('common.cancel')}
            </button>
          </div>
        </>
      );
    }

    if (keyBackup.exists) {
      return (
        <>
          <p className="mb-1 flex items-center gap-1.5 font-medium text-vox-accent-success">
            <ShieldCheck size={14} />
            {t('e2e.backupSetUp')}
          </p>
          {keyBackup.updatedAt && (
            <p className="mb-2">
              {t('e2e.backupUpdatedAt', { date: new Date(keyBackup.updatedAt).toLocaleDateString() })}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setConfirming('replace')}
              className="rounded border border-vox-border px-2 py-1 font-medium text-vox-text-secondary hover:bg-vox-bg-hover"
            >
              {t('e2e.backupReplaceAction')}
            </button>
            <button
              onClick={() => setConfirming('delete')}
              className="rounded px-2 py-1 font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10"
            >
              {t('e2e.backupDeleteAction')}
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <p className="mb-2">{t('e2e.backupExplainer')}</p>
        <button
          onClick={handleCreate}
          disabled={busy}
          className="rounded bg-vox-accent-primary px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('common.loading') : t('e2e.backupCreateAction')}
        </button>
      </>
    );
  };

  return (
    <div
      className="mb-3 rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted"
      data-testid="e2e-key-backup"
    >
      <p className="mb-1.5 font-medium text-vox-text-secondary">
        {canRestore ? t('e2e.backupRestoreTitle') : t('e2e.backupTitle')}
      </p>
      {body()}
      {recoveryKey && (
        <RecoveryKeyDialog recoveryKey={recoveryKey} onAcknowledge={() => setRecoveryKey(null)} />
      )}
    </div>
  );
}

// Exported for tests: the account-recovery flows below it are reachable in the
// app only through two nested modals, and driving them from the badge would
// pull the real crypto service (and its IndexedDB vault) into a render test.
export function DeviceManagerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const ownDevices = useE2EStore((s) => s.ownDevices);
  const loading = useE2EStore((s) => s.ownDevicesLoading);
  const ownDeviceWarnings = useE2EStore((s) => s.ownDeviceWarnings);
  const canApprove = useE2EStore((s) => s.canApprove);
  const thisDeviceUnsigned = useE2EStore((s) => s.thisDeviceUnsigned);
  const masterKeyConflict = useE2EStore((s) => s.masterKeyConflict);
  const keyBackup = useE2EStore((s) => s.keyBackup);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [linkingCode, setLinkingCode] = useState<string | null>(null);

  const linkingMode = deviceLinkingMode({ thisDeviceUnsigned, canApprove });

  // Read here rather than inside the section so the fallback below knows
  // whether a code actually made it on screen: when the account keys are not
  // loaded there is nothing honest to render, and the user still has to be
  // told how this device gets approved.
  useEffect(() => {
    if (!user?.id || linkingMode !== 'show') {
      setLinkingCode(null);
      return;
    }
    try {
      setLinkingCode(getE2EService(user.id).linkingCode());
    } catch (err) {
      // Never a placeholder: a code that names no device is one the user reads
      // out, is told is wrong, and blames themselves for.
      console.warn('e2e: linking code unavailable:', err instanceof Error ? err.message : err);
      setLinkingCode(null);
    }
  }, [user?.id, linkingMode]);

  useEffect(() => {
    if (!user?.id) return;
    void useE2EStore.getState().loadOwnDevices(user.id);
    // Read once per open rather than folded into loadOwnDevices: that runs
    // again after every approve/revoke, and GET /e2e/backup shares the 30/hour
    // approval bucket — spending it on a row that device actions cannot change
    // is how a multi-device setup ends in a 429 mid-approval.
    void useE2EStore.getState().loadKeyBackup(user.id);
  }, [user?.id]);

  const handleAcknowledge = async () => {
    if (!user?.id || !ownDevices) return;
    try {
      await useE2EStore
        .getState()
        .acknowledgeOwnDevices(user.id, ownDevices.devices.map((d) => d.deviceId));
      toast.success(t('e2e.devicesReviewed'));
    } catch (err) {
      console.warn('e2e: acknowledging own devices failed:', err instanceof Error ? err.message : err);
    }
  };

  const handleRevoke = async (deviceId: string) => {
    if (!user?.id) return;
    setBusyId(deviceId);
    try {
      await useE2EStore.getState().revokeDevice(user.id, deviceId);
      toast.success(t('e2e.revoked'));
      setConfirmingId(null);
    } catch (err) {
      console.warn('e2e: revoking device failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.revokeFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleApprove = async (deviceId: string) => {
    if (!user?.id) return;
    setBusyId(deviceId);
    try {
      await useE2EStore.getState().approveDevice(user.id, deviceId);
      toast.success(t('e2e.approveDeviceSuccess'));
    } catch (err) {
      console.warn('e2e: approving device failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.approveDeviceFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleReset = async () => {
    if (!user?.id) return;
    setResetting(true);
    try {
      await useE2EStore.getState().resetAccountIdentity(user.id);
      toast.success(t('e2e.resetIdentitySuccess'));
      setConfirmingReset(false);
    } catch (err) {
      console.warn('e2e: resetting account identity failed:', err instanceof Error ? err.message : err);
      toast.error(t('e2e.resetIdentityFailed'));
    } finally {
      setResetting(false);
    }
  };

  const hasUnsignedDevice = !!ownDevices?.devices.some((d) => !d.crossSigned);
  const canReset = shouldOfferIdentityReset({ ownDevices, canApprove, masterKeyConflict });
  // 'show' with no code renders nothing, so it must not silence the fallback.
  const showLinking = linkingMode === 'enter' || (linkingMode === 'show' && !!linkingCode);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg bg-vox-bg-primary p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-vox-text-primary">
            <Laptop2 size={16} className="text-vox-accent-primary" />
            {t('e2e.deviceManagerTitle')}
          </h3>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <p className="mb-3 text-xs text-vox-text-muted">{t('e2e.deviceManagerExplainer')}</p>

        {masterKeyConflict && (
          <p className="mb-3 rounded-md bg-vox-accent-warning/10 p-2 text-xs text-vox-accent-warning">
            {t('e2e.masterConflictExplainer')}
          </p>
        )}

        {/* First, and above BOTH recovery boxes below: on a device that is not
            approved yet this is the whole reason the user opened this screen,
            and it is the only exit that costs nothing — the restore needs a
            recovery key they may not have, and the reset costs every contact a
            re-verification. Ordering is asserted by a test, not by hoping the
            file keeps this shape. */}
        {user?.id && showLinking && (
          <DeviceLinkingSection userId={user.id} mode={linkingMode!} code={linkingCode} />
        )}

        {/* Said only when there is no linking code on screen: with one, "approve
            it from a device that already has access" is the same sentence
            twice, and the second copy is the one without an action attached. */}
        {hasUnsignedDevice && !canApprove && !showLinking && (
          <p className="mb-3 rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted">
            {t('e2e.cannotApproveExplainer')}
          </p>
        )}

        {/* Above the reset, always: recovery restores the SAME account key, so
            no peer sees a safety-number change and nobody re-verifies. Offering
            the destructive exit first would have users take it while a backup
            they own sits unused. */}
        {user?.id && <KeyBackupSection userId={user.id} noBackupNotice={canReset} />}

        {canReset && (
          <div
            className="mb-3 rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted"
            data-testid="e2e-reset-identity"
          >
            {confirmingReset ? (
              <>
                <p className="mb-2 text-vox-accent-warning">{t('e2e.resetIdentityConfirm')}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleReset}
                    disabled={resetting}
                    className="rounded bg-vox-accent-danger px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {resetting ? t('common.loading') : t('e2e.resetIdentityAction')}
                  </button>
                  <button
                    onClick={() => setConfirmingReset(false)}
                    className="rounded px-2 py-1 hover:text-vox-text-primary"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {keyBackup?.exists && (
                  <p className="mb-2 text-vox-text-secondary">{t('e2e.backupPreferRestore')}</p>
                )}
                <p className="mb-2">{t('e2e.resetIdentityExplainer')}</p>
                <button
                  onClick={() => setConfirmingReset(true)}
                  className="rounded border border-vox-accent-danger px-2 py-1 font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10"
                >
                  {t('e2e.resetIdentityAction')}
                </button>
              </>
            )}
          </div>
        )}

        {ownDeviceWarnings.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-warning/10 p-3 text-xs text-vox-accent-warning">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="mb-2">{t('e2e.ownDeviceWarning', { count: ownDeviceWarnings.length })}</p>
              <button
                onClick={handleAcknowledge}
                className="rounded bg-vox-accent-warning px-2 py-1 font-medium text-black hover:opacity-90"
              >
                {t('e2e.ownDevicesReviewed')}
              </button>
            </div>
          </div>
        )}

        {loading && !ownDevices ? (
          <p className="text-sm text-vox-text-muted">{t('common.loading')}</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {ownDevices?.devices.map((device) => {
              const isCurrent = device.deviceId === ownDevices.currentDeviceId;
              const unrecognised = ownDeviceWarnings.includes(device.deviceId);
              return (
                <div
                  key={device.deviceId}
                  className={clsx(
                    'rounded-md p-3',
                    unrecognised ? 'bg-vox-accent-warning/10 ring-1 ring-vox-accent-warning/40' : 'bg-vox-bg-secondary'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs text-vox-text-primary">
                          {shortDeviceId(device.deviceId)}
                        </span>
                        {unrecognised && (
                          <span className="rounded bg-vox-accent-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-vox-accent-warning">
                            {t('e2e.unrecognisedDevice')}
                          </span>
                        )}
                        {isCurrent && (
                          <span className="shrink-0 rounded bg-vox-accent-success/15 px-1.5 py-0.5 text-[10px] font-medium text-vox-accent-success">
                            {t('e2e.thisDevice')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-vox-text-muted">
                        {t('e2e.deviceAdded', { date: new Date(device.createdAt).toLocaleDateString() })}
                      </p>
                      <span
                        className={clsx(
                          'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                          device.crossSigned
                            ? 'bg-vox-accent-success/15 text-vox-accent-success'
                            : 'bg-vox-accent-warning/15 text-vox-accent-warning'
                        )}
                      >
                        {device.crossSigned ? t('e2e.crossSignedChip') : t('e2e.unsignedChipOwn')}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!device.crossSigned && !isCurrent && canApprove && confirmingId !== device.deviceId && (
                        <button
                          onClick={() => handleApprove(device.deviceId)}
                          disabled={busyId === device.deviceId}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-vox-accent-primary hover:bg-vox-accent-primary/10 disabled:opacity-50"
                        >
                          {busyId === device.deviceId ? t('common.loading') : t('e2e.approveDevice')}
                        </button>
                      )}
                      {!isCurrent && confirmingId !== device.deviceId && (
                        <button
                          onClick={() => setConfirmingId(device.deviceId)}
                          className="shrink-0 rounded-md p-1.5 text-vox-accent-danger hover:bg-vox-accent-danger/10"
                          title={t('e2e.revokeDevice')}
                          aria-label={t('e2e.revokeDevice')}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmingId === device.deviceId && (
                    <div className="mt-2 rounded-md bg-vox-accent-danger/10 p-2 text-xs text-vox-accent-danger">
                      <p className="mb-2">{t('e2e.revokeConfirm')}</p>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setConfirmingId(null)}
                          className="rounded px-2 py-1 text-vox-text-secondary hover:bg-vox-bg-hover"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={() => handleRevoke(device.deviceId)}
                          disabled={busyId === device.deviceId}
                          className="rounded bg-vox-accent-danger px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                          {busyId === device.deviceId ? t('common.loading') : t('common.confirm')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
