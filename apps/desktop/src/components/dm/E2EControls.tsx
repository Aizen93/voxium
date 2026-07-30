import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Lock, ShieldCheck, ShieldAlert, X, Laptop2, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useDMStore } from '../../stores/dmStore';
import { useE2EStore } from '../../stores/e2eStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import {
  getE2EService,
  type E2EAccountSafetyNumber,
  type E2EDeviceSafetyNumber,
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
  const [modal, setModal] = useState<'enable' | 'safety' | null>(null);

  const encrypted = !!conversation.encryptedAt;

  // Passively check for peer device-list changes while an encrypted
  // conversation is open — the only trigger besides an explicit send/decrypt.
  useEffect(() => {
    if (!e2eReady || !encrypted || !user?.id) return;
    void useE2EStore.getState().refreshDeviceList(user.id, peerId);
  }, [e2eReady, encrypted, user?.id, peerId]);

  if (!e2eReady) return null;

  const warning =
    identityWarning || newDeviceWarning || ownDeviceWarning || unsignedPeerWarning || ownUnsignedWarning;

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
        title={
          ownUnsignedWarning || unsignedPeerWarning
            ? t('e2e.unsignedDeviceBadgeTitle')
            : ownDeviceWarning
            ? t('e2e.ownDeviceBadgeTitle')
            : newDeviceWarning && !identityWarning
              ? t('e2e.newDeviceBadgeTitle')
              : encrypted
                ? t('e2e.badgeTitle')
                : t('e2e.enableTitle')
        }
        aria-label={encrypted ? t('e2e.badgeTitle') : t('e2e.enableTitle')}
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

function DeviceManagerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const ownDevices = useE2EStore((s) => s.ownDevices);
  const loading = useE2EStore((s) => s.ownDevicesLoading);
  const ownDeviceWarnings = useE2EStore((s) => s.ownDeviceWarnings);
  const canApprove = useE2EStore((s) => s.canApprove);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id) void useE2EStore.getState().loadOwnDevices(user.id);
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

  const hasUnsignedDevice = !!ownDevices?.devices.some((d) => !d.crossSigned);

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

        {hasUnsignedDevice && !canApprove && (
          <p className="mb-3 rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted">
            {t('e2e.cannotApproveExplainer')}
          </p>
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
