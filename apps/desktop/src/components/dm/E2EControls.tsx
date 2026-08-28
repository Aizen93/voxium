import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Lock, ShieldCheck, ShieldAlert, X, Laptop2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../stores/toastStore';
import {
  getE2EService,
  type E2EAccountSafetyNumber,
  type E2EDeviceSafetyNumber,
} from '../../services/e2e/e2eService';
import { shortDeviceId } from '../../utils/deviceId';
import type { Conversation } from '@voxium/shared';

/**
 * The DM lock badge and the per-contact safety number — and nothing else.
 *
 * Everything account-scoped (devices, linking, recovery key, identity reset)
 * moved to Settings → Security in `settings/E2EDevicesSection.tsx`: one device
 * list, one account key, one backup, so administering them from inside a
 * single conversation was what made the whole feature read as per-conversation
 * (plan §4.5). Verifying a CONTACT genuinely is per contact, so it stayed here.
 */

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
 * Every DM is encrypted now, so there is no "off" state to describe — the
 * badge either says nothing or names the one thing worth acting on.
 */
export function badgeState(flags: {
  identityWarning: boolean;
  masterKeyConflict: boolean;
  thisDeviceUnsigned: boolean;
  unsignedWarning: boolean;
  ownDeviceWarning: boolean;
  newDeviceWarning: boolean;
}): { titleKey: string; warning: boolean } {
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
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);

  // Every DM is encrypted (spec §14–§18). The flag survives on the wire as the
  // timestamp of when this conversation started being encrypted; it is no
  // longer a state the UI branches on.
  //
  // Passively check for peer device-list changes while the conversation is
  // open — the only trigger besides an explicit send/decrypt.
  useEffect(() => {
    if (!e2eReady || !user?.id) return;
    void useE2EStore.getState().refreshDeviceList(user.id, peerId);
  }, [e2eReady, user?.id, peerId]);

  if (!e2eReady) return null;

  const { titleKey, warning } = badgeState({
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
        onClick={() => setShowSafetyNumber(true)}
        className={clsx(
          'rounded-md p-1.5 transition-colors',
          warning
            ? 'text-vox-accent-warning hover:bg-vox-accent-warning/10'
            : 'text-vox-accent-success hover:bg-vox-accent-success/10'
        )}
        title={title}
        // Same string as the tooltip: an alert nobody can hover is not an alert.
        aria-label={title}
      >
        {warning ? <ShieldAlert size={18} /> : <Lock size={18} />}
      </button>
      {showSafetyNumber && (
        <SafetyNumberModal conversation={conversation} onClose={() => setShowSafetyNumber(false)} />
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
      toast.error(t('e2e.identityAcceptFailed'));
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
          {/* A shortcut, not a second home: the device list lives in Settings →
              Security now, so this hands the user off there and gets out of the
              way rather than stacking a third modal on top of this one. */}
          <button
            onClick={() => {
              onClose();
              useSettingsStore.getState().openSettings('security');
            }}
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
    </ModalShell>
  );
}
