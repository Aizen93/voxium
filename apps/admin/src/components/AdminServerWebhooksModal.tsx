import { useEffect, useState } from 'react';
import { X, Trash2, Power, PowerOff, RotateCcw } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminConfirmModal } from './AdminConfirmModal';
import type { AdminWebhook, WebhookType } from '@voxium/shared';

/**
 * A server's incoming webhooks, for moderation: every one of them (platform
 * admins see past channel permissions), with Disable / Enable and Delete
 * (optionally with every message it posted). Every action goes through an
 * AdminConfirmModal first, like the server list's Feature and Block; each is
 * audited server-side and the list refetches after it. No token or secret appears
 * here: the API never sends one (only a hash and a sealed copy exist).
 *
 * An admin's Disable is a LOCK (`adminDisabledAt`): the owner's own enable
 * answers 403 until an admin enables the webhook again, so the row says so and
 * the Enable button says it lifts the lock. "URL holder removed" marks a
 * webhook a kick or ban disabled because the member who held its live URL (its
 * creator, or whoever rotated it last) is gone: the URL may have left with
 * them, which is why the Enable confirm points at a rotation.
 */

const TYPE_LABELS: Record<WebhookType, string> = { generic: 'Generic', github: 'GitHub' };

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

function RotatedNote({ webhook }: { webhook: AdminWebhook }) {
  if (!webhook.lastRotatedAt) return null;
  const when = formatDate(webhook.lastRotatedAt);
  // The rotator's account may be gone (SET NULL): the date alone still says
  // the URL changed since creation
  const who = webhook.lastRotatedBy ? webhook.lastRotatedBy.displayName || webhook.lastRotatedBy.username : null;
  return (
    <div className="text-[10px] text-vox-text-muted whitespace-normal" data-testid="webhook-rotated">
      {who ? `Rotated ${when} by ${who}` : `Rotated ${when}`}
    </div>
  );
}

export function AdminServerWebhooksModal({ serverId, serverName, onClose }: { serverId: string; serverName: string; onClose: () => void }) {
  const {
    serverWebhooks, serverWebhooksServerId, serverWebhooksLoading, serverWebhooksError,
    fetchServerWebhooks, setServerWebhookEnabled, deleteServerWebhook,
  } = useAdminStore();
  const [deleteTarget, setDeleteTarget] = useState<AdminWebhook | null>(null);
  const [toggleTarget, setToggleTarget] = useState<AdminWebhook | null>(null);
  const [purgeMessages, setPurgeMessages] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    fetchServerWebhooks(serverId);
  }, [serverId, fetchServerWebhooks]);

  // Rows of another server (a previous opening) never show under this title
  const webhooks = serverWebhooksServerId === serverId ? serverWebhooks : [];
  const firstLoad = serverWebhooksLoading && webhooks.length === 0;

  // Runs from the confirm: the state flips to the opposite of what the row
  // showed when the admin clicked
  const toggle = async (webhook: AdminWebhook) => {
    setBusyId(webhook.id);
    try {
      await setServerWebhookEnabled(webhook.id, !webhook.enabled);
    } finally {
      setBusyId(null);
      setToggleTarget(null);
    }
  };

  const openDelete = (webhook: AdminWebhook) => {
    setPurgeMessages(false);
    setDeleteTarget(webhook);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="server-webhooks-modal">
      <div className="bg-vox-bg-secondary border border-vox-border rounded-lg w-full max-w-5xl mx-4 shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-vox-border">
          <div>
            <h3 className="text-sm font-semibold text-vox-text-primary">Webhooks</h3>
            <p className="text-xs text-vox-text-muted">{serverName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-vox-bg-hover text-vox-text-muted hover:text-vox-text-primary" title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          <p className="text-xs text-vox-text-muted mb-3">
            Every incoming webhook of this server. A webhook you disable stops posting and stays locked: its owner cannot
            re-enable it until an admin enables it again (the owner can still delete it and create another one; to stop
            that, set the server&apos;s webhook limit to 0 in Limits). Delete is permanent and can take every message the
            webhook posted with it.
          </p>

          {firstLoad ? (
            <div className="flex justify-center py-8" data-testid="server-webhooks-loading">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
            </div>
          ) : serverWebhooksError && webhooks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-sm text-vox-text-muted" data-testid="server-webhooks-error">
              <span>Could not load the webhooks of this server.</span>
              <button
                onClick={() => fetchServerWebhooks(serverId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            </div>
          ) : webhooks.length === 0 ? (
            <div className="py-8 text-center text-sm text-vox-text-muted" data-testid="server-webhooks-empty">
              This server has no webhooks.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-vox-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-vox-border">
                    {['Name', 'Type', 'Channel', 'Creator', 'Created', 'Last used', 'Status', ''].map((label) => (
                      <th key={label} className="px-3 py-2 text-left text-xs font-medium text-vox-text-muted uppercase">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((webhook) => (
                    <tr key={webhook.id} className="border-b border-vox-border/50 last:border-b-0" data-testid="server-webhook-row">
                      <td className="px-3 py-2 text-vox-text-primary font-medium break-all">{webhook.name}</td>
                      <td className="px-3 py-2">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-vox-bg-hover text-vox-text-secondary">
                          {TYPE_LABELS[webhook.type] ?? webhook.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-vox-text-secondary">
                        {webhook.channelName !== null && <div>#{webhook.channelName}</div>}
                        <code className="text-[10px] text-vox-text-muted font-mono">{webhook.channelId}</code>
                      </td>
                      <td className="px-3 py-2 text-vox-text-secondary">
                        {webhook.createdBy
                          ? webhook.createdBy.username
                          : <span className="text-vox-text-muted italic">Deleted user</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-vox-text-secondary whitespace-nowrap">
                        <div>{formatDate(webhook.createdAt)}</div>
                        <RotatedNote webhook={webhook} />
                      </td>
                      <td className="px-3 py-2 text-xs text-vox-text-secondary whitespace-nowrap">{formatDate(webhook.lastUsedAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {webhook.enabled ? (
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-400" data-testid="webhook-status">Enabled</span>
                          ) : (
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-500/20 text-orange-400" data-testid="webhook-status">Disabled</span>
                          )}
                          {webhook.adminDisabledAt && (
                            <span
                              className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-400 whitespace-nowrap"
                              title={`Disabled by a platform admin on ${formatDate(webhook.adminDisabledAt)}; the owner cannot re-enable it`}
                              data-testid="webhook-admin-disabled"
                            >
                              Admin-disabled
                            </span>
                          )}
                          {webhook.creatorRemovedAt && (
                            <span
                              className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400 whitespace-nowrap"
                              title={`The member who held its URL was kicked or banned on ${formatDate(webhook.creatorRemovedAt)}, which disabled the webhook`}
                              data-testid="webhook-creator-removed"
                            >
                              URL holder removed
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => setToggleTarget(webhook)}
                            disabled={busyId === webhook.id}
                            className={`p-1 rounded text-vox-text-muted disabled:opacity-30 ${webhook.enabled ? 'hover:text-orange-400' : 'hover:text-green-400'}`}
                            title={webhook.enabled
                              ? 'Disable webhook'
                              : webhook.adminDisabledAt ? 'Enable webhook (lifts the admin lock)' : 'Enable webhook'}
                            data-testid={webhook.enabled ? 'webhook-disable' : 'webhook-enable'}
                          >
                            {webhook.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                          </button>
                          <button
                            onClick={() => openDelete(webhook)}
                            className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger"
                            title="Delete webhook"
                            data-testid="webhook-delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-vox-border">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-md text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors">
            Close
          </button>
        </div>
      </div>

      {toggleTarget && (
        <AdminConfirmModal
          title={toggleTarget.enabled ? 'Disable Webhook' : 'Enable Webhook'}
          message={toggleTarget.enabled ? (
            <p data-testid="webhook-toggle-confirm">
              Disable the webhook &quot;{toggleTarget.name}&quot;? Deliveries to its URL answer 403 until it is re-enabled;
              its messages stay. The server owner cannot re-enable it: only an admin&apos;s Enable lifts the lock.
            </p>
          ) : (
            <p data-testid="webhook-toggle-confirm">
              Enable the webhook &quot;{toggleTarget.name}&quot;? Deliveries to its URL are accepted and posted again.
              {toggleTarget.adminDisabledAt && ' This lifts the admin lock: the server owner can disable or enable it again.'}
              {toggleTarget.creatorRemovedAt && ' The member who held its URL was removed from the server and may still hold the URL; the owner can rotate it.'}
            </p>
          )}
          confirmLabel={toggleTarget.enabled ? 'Disable Webhook' : 'Enable Webhook'}
          variant={toggleTarget.enabled ? 'danger' : 'primary'}
          onConfirm={() => toggle(toggleTarget)}
          onCancel={() => setToggleTarget(null)}
        />
      )}

      {deleteTarget && (
        <AdminConfirmModal
          title="Delete Webhook"
          message={(
            <div className="space-y-3">
              <p>
                Permanently delete the webhook &quot;{deleteTarget.name}&quot;? Anything still sending to its URL is refused from now on.
                This cannot be undone.
              </p>
              <label className="flex items-center gap-2 text-vox-text-primary select-none">
                <input
                  type="checkbox"
                  checked={purgeMessages}
                  onChange={(e) => setPurgeMessages(e.target.checked)}
                  className="rounded"
                  data-testid="webhook-delete-purge"
                />
                Also delete its messages
              </label>
              <p className="text-xs text-vox-text-muted">
                {purgeMessages
                  ? 'Every message it posted, in every channel, is deleted with it.'
                  : 'Its messages stay, labelled with its name.'}
              </p>
            </div>
          )}
          confirmLabel="Delete Webhook"
          onConfirm={async () => {
            await deleteServerWebhook(deleteTarget.id, purgeMessages);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
