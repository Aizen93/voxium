import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ShieldCheck, ShieldAlert, Laptop2, Trash2, KeyRound, Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { useE2EStore, E2ELinkingCodeUnknownError, type E2ELinkableDevice } from '../../stores/e2eStore';
import {
  E2ELinkingCodeAmbiguousError,
  E2ELinkingKeysChangedError,
} from '../../services/e2e/e2eService';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import {
  getE2EService,
  E2ERecoveryKeyFormatError,
  type E2EOwnDevices,
} from '../../services/e2e/e2eService';
import { shortDeviceId } from '../../utils/deviceId';
import { copyToClipboard } from '../../utils/clipboard';

/**
 * Account-level encryption management: this account's devices, linking,
 * recovery key and the identity reset (plan §4.5).
 *
 * All of this state has always been ACCOUNT-scoped — one device list, one
 * account key, one recovery key, one backup — but it used to be administered
 * from a modal reached through a single conversation's lock badge. That is the
 * main reason the whole feature READ as per-conversation even though the data
 * model never was, so it lives in Settings → Security now. Verifying a contact
 * is genuinely per contact and stayed on the DM badge.
 */


/**
 * Should this section offer to start a NEW account identity (spec §14.4)?
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
 * Should this section offer to RESTORE from a key backup (spec §15.4)?
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
  const [error, setError] = useState<'unknown' | 'ambiguous' | 'failed' | null>(null);
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
      } else if (err instanceof E2ELinkingCodeAmbiguousError) {
        // Two devices cannot collide on 80 bits by chance, so this is either
        // the server offering a decoy or a device deliberately built to match.
        // Either way the user must not be handed one of them to approve.
        setError('ambiguous');
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
      // Pass the code, not just the id: approveDevice recomputes it from the
      // device list it is about to seal the account key to, so the thing the
      // user compared is the thing that gets checked.
      await useE2EStore.getState().approveLinkedDevice(userId, pending.deviceId, pending.linkingCode);
      toast.success(t('e2e.approveDeviceSuccess'));
      setPending(null);
      setCode('');
    } catch (err) {
      console.warn('e2e: approving a linked device failed:', err instanceof Error ? err.message : err);
      if (err instanceof E2ELinkingKeysChangedError) {
        // The device answered to the code a moment ago and answers to a
        // different one now. That is not a hiccup to retry past: it is the
        // server having swapped the keys under the id the user confirmed.
        // Send them back to the new device for a fresh code rather than
        // letting them press the button again until it goes through.
        toast.error(t('e2e.linkKeysChanged'));
        setPending(null);
      } else {
        toast.error(t('e2e.approveDeviceFailed'));
      }
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
          {t(
            error === 'unknown'
              ? 'e2e.linkUnknownCode'
              : error === 'ambiguous'
                ? 'e2e.linkAmbiguousCode'
                : 'e2e.linkLookupFailed'
          )}
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

/**
 * Settings → Security → Your devices.
 *
 * A section, not a modal: it is one block of the Security tab, so it carries no
 * backdrop and no close button — the settings modal owns both.
 */
export function E2EDevicesSection() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const e2eReady = useE2EStore((s) => s.ready);
  const ownDevices = useE2EStore((s) => s.ownDevices);
  const loading = useE2EStore((s) => s.ownDevicesLoading);
  const ownDevicesError = useE2EStore((s) => s.ownDevicesError);
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

  const heading = (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Laptop2 size={16} className="text-vox-text-muted" />
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('e2e.deviceManagerTitle')}</h3>
      </div>
    </>
  );

  // This panel is reachable before encryption has finished setting up, which
  // the DM badge never was — it rendered nothing until the store was ready.
  // Without this the heading would sit over an empty device list, which reads
  // as "you have no devices" rather than "ask again in a moment".
  if (!e2eReady) {
    return (
      <div className="border-t border-vox-border pt-5" data-testid="e2e-devices-section">
        {heading}
        <p className="rounded-md bg-vox-bg-secondary p-2 text-xs text-vox-text-muted">
          {t('e2e.devicesNotReady')}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-vox-border pt-5" data-testid="e2e-devices-section">
      {heading}
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

      {ownDevicesError && (
        <div
          className="mb-3 flex items-start gap-2 rounded-md bg-vox-accent-danger/10 p-3 text-xs text-vox-accent-danger"
          role="alert"
          data-testid="e2e-devices-load-failed"
        >
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <p>{t('e2e.ownDevicesLoadFailed')}</p>
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
  );
}
