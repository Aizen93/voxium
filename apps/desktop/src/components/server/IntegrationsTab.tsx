import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Hash, Pencil, Plus, Power, PowerOff, RefreshCw, Trash2, Webhook as WebhookIcon, X } from 'lucide-react';
import type { ResourceLimits, Webhook, WebhookCreated, WebhookTarget, WebhookType } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { api } from '../../services/api';
import { getSocket, onSocketReconnect } from '../../services/socket';
import {
  createWebhook,
  deleteWebhook,
  fetchWebhookTargets,
  isWebhooksOff,
  listWebhooks,
  rotateWebhook,
  updateWebhook,
  webhookUrl,
  type CreateWebhookInput,
} from '../../services/webhooks';
import { getTranslatedError } from '../../utils/serverErrors';
import { WebhookCreateDialog } from './WebhookCreateDialog';
import { WebhookCreatedPanel } from './WebhookCreatedPanel';
import { WebhookDialog } from './WebhookDialog';
import { WebhookEditDialog, type WebhookEditPatch } from './WebhookEditDialog';

interface Props {
  serverId: string;
}

/** What the copy-once panel shows. The token is inside `url` and lives nowhere else. */
interface Reveal {
  name: string;
  url: string;
  secret?: string;
  rotated: boolean;
}

/** No row busy. Never mutated: every busy update copies (`markBusy` / `clearBusy`). */
const NO_BUSY: ReadonlySet<string> = new Set();

/**
 * The create and edit pickers' channels: the server's answer (what its
 * create/move check accepts for THIS caller), the store-derived fallback
 * after a failed fetch, or still loading.
 */
type Targets = { state: 'loading' } | { state: 'ready'; list: WebhookTarget[] } | { state: 'fallback' };

/**
 * Server settings → Integrations: the server's incoming webhooks (needs
 * MANAGE_WEBHOOKS). The list is the SERVER's: fetched on mount, on
 * `webhook:changed` for this server (a fellow moderator's change, or this
 * tab's own) and on `channel:deleted` (a cascade that emits no hint), and
 * refetched right after a create, rotate, enable/disable or delete; an edit
 * (rename, move) does not refetch, it waits for the `webhook:changed` its
 * PATCH emits. The cap reloads with the list. Mutation responses are never
 * written into it — the create and rotate answers are read ONCE, for the token
 * shown in the copy-once panel, and dropped with it. No store: nothing
 * outlives the tab. The create and edit pickers' channels are the server's
 * too (`/webhooks/targets`).
 */
export function IntegrationsTab({ serverId }: Props) {
  const { t, i18n } = useTranslation();
  // The raw store value (a default inside the selector would allocate per read)
  const allChannels = useServerStore((s) => s.channels);

  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  // Every webhook of the server, the ones on channels this viewer cannot see
  // included: what the cap counts (`webhooks` is only the visible part)
  const [total, setTotal] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [off, setOff] = useState(false);
  const [max, setMax] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [targets, setTargets] = useState<Targets>({ state: 'loading' });
  // The webhook whose edit dialog is open, by id: the dialog shows the row as
  // the list has it NOW (a fellow moderator's change reaches it) and closes
  // when the row leaves the list
  const [editingId, setEditingId] = useState<string | null>(null);
  // The same id, current between commits: a save's answer can land after a
  // refetch closed the dialog but before React committed it, and must then
  // see it closed. Written ONLY through `setEditing`, never apart from the state.
  const editingIdRef = useRef<string | null>(null);
  const setEditing = useCallback((id: string | null) => {
    editingIdRef.current = id;
    setEditingId(id);
  }, []);
  // A refusal of a save, for the dialog of THAT webhook only
  const [editError, setEditError] = useState<{ id: string; message: string } | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<Webhook | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Webhook | null>(null);
  const [purge, setPurge] = useState(false);
  // One entry per row with a request in flight: a toggle on one row and a
  // rotate on another are busy at the SAME time, and the first to finish must
  // not re-enable the other's confirm (a second click = a second rotation)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(NO_BUSY);
  const markBusy = (id: string) => setBusyIds((prev) => new Set(prev).add(id));
  const clearBusy = (id: string) => setBusyIds((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Monotonic id of the latest list fetch: a slow earlier answer (the
  // mutation's own refetch racing the socket hint) never lands on a newer one.
  const fetchSeq = useRef(0);
  // The cap, from the member-facing limits route (same source as the Limits
  // tab). Reloaded with every list fetch, so an admin's change (0 ↔ 10)
  // shows on the next hint or reconnect; numbered like the list.
  const capSeq = useRef(0);
  const loadCap = useCallback(async () => {
    const seq = ++capSeq.current;
    try {
      const { data } = await api.get<{ success: boolean; data: ResourceLimits }>(`/servers/${serverId}/limits`);
      if (!mounted.current || seq !== capSeq.current) return;
      setMax(data.data.maxWebhooksPerServer);
    } catch (err) {
      console.warn('[Integrations] Failed to load limits:', err instanceof Error ? err.message : String(err));
    }
  }, [serverId]);

  const refetch = useCallback(async () => {
    void loadCap();
    const seq = ++fetchSeq.current;
    try {
      const list = await listWebhooks(serverId);
      if (!mounted.current || seq !== fetchSeq.current) return;
      setWebhooks(list.webhooks);
      // The edited webhook left the list (deleted, or moved into a channel
      // this viewer cannot see): its dialog goes with it
      const editedId = editingIdRef.current;
      if (editedId !== null && !list.webhooks.some((w) => w.id === editedId)) setEditing(null);
      setTotal(list.total);
      setLoadFailed(false);
      setOff(false);
    } catch (err) {
      if (!mounted.current || seq !== fetchSeq.current) return;
      // The edit dialog does not wait behind the OFF view to reopen when the feature is back
      if (isWebhooksOff(err)) { setOff(true); setEditing(null); return; }
      console.warn('[Integrations] Failed to load webhooks:', err instanceof Error ? err.message : String(err));
      toast.error(getTranslatedError(err, t, 'webhooks.failedToLoad'));
      setLoadFailed(true);
    }
  }, [serverId, t, loadCap, setEditing]);

  useEffect(() => { void refetch(); }, [refetch]);

  // The create and edit pickers' list, from the server: only the channels
  // this caller can VIEW and SEND in, which no client-side filter can know
  // (role and channel overrides). Fetched each time a dialog opens; numbered
  // like the list. A failure falls back to the visible text channels: the
  // server's check on the create or move stays the authority, and its
  // refusal is shown.
  const targetsSeq = useRef(0);
  const loadTargets = useCallback(async () => {
    const seq = ++targetsSeq.current;
    try {
      const list = await fetchWebhookTargets(serverId);
      if (!mounted.current || seq !== targetsSeq.current) return;
      setTargets({ state: 'ready', list });
    } catch (err) {
      if (!mounted.current || seq !== targetsSeq.current) return;
      // The flag went off: the tab shows its off state, and the dialog must
      // not stay open on a spinner that nothing will ever resolve
      if (isWebhooksOff(err)) { setOff(true); setCreating(false); setEditing(null); return; }
      console.warn('[Integrations] Failed to load webhook targets, offering the visible text channels:', err instanceof Error ? err.message : String(err));
      setTargets({ state: 'fallback' });
    }
  }, [serverId, setEditing]);

  const openCreate = () => {
    setTargets({ state: 'loading' });
    setCreating(true);
    void loadTargets();
  };

  // The same loader as the create picker: a move is asked exactly what a
  // create is (text, not secure, VIEW and SEND_MESSAGES on the target)
  const openEdit = (webhook: Webhook) => {
    setTargets({ state: 'loading' });
    setEditError(null);
    setEditing(webhook.id);
    void loadTargets();
  };

  // Read by the socket handlers below without re-subscribing on every open:
  // whether a picker (create or edit) is on screen
  const pickerOpenRef = useRef(false);
  useEffect(() => { pickerOpenRef.current = creating || editingId !== null; }, [creating, editingId]);

  // `webhook:changed` is the refetch hint; it reaches the whole server room,
  // so it is filtered to THIS server. Deleting a channel deletes its webhooks
  // by cascade and emits no `webhook:changed`: `channel:deleted` for this
  // server refetches too. A reconnect may have missed some (and may hand us
  // a new socket): re-attach and refetch.
  useEffect(() => {
    const onChanged = (data: { serverId: string }) => {
      if (data && data.serverId === serverId) void refetch();
    };
    const onChannelDeleted = (data: { channelId: string; serverId: string }) => {
      if (!data || data.serverId !== serverId) return;
      void refetch();
      // The open picker's list is the server's: ask again rather than offer a
      // dead channel (the dialog keeps the current list until the answer)
      if (pickerOpenRef.current) void loadTargets();
    };
    let attached: ReturnType<typeof getSocket> = null;
    const attach = () => {
      const socket = getSocket();
      if (socket === attached) return;
      attached?.off('webhook:changed', onChanged);
      attached?.off('channel:deleted', onChannelDeleted);
      socket?.on('webhook:changed', onChanged);
      socket?.on('channel:deleted', onChannelDeleted);
      attached = socket;
    };
    attach();
    const unsubscribe = onSocketReconnect(() => {
      attach();
      void refetch();
      if (pickerOpenRef.current) void loadTargets();
    });
    return () => {
      attached?.off('webhook:changed', onChanged);
      attached?.off('channel:deleted', onChannelDeleted);
      unsubscribe();
    };
  }, [serverId, refetch, loadTargets]);

  const serverChannels = useMemo(() => allChannels.filter((c) => c.serverId === serverId), [allChannels, serverId]);
  // A webhook posts to a plaintext text channel only (the server answers
  // "Channel not found" for a secure one, by design). The picker's fallback
  // when the targets fetch fails: it cannot know SEND_MESSAGES, the server's
  // check does.
  const eligibleChannels = useMemo(
    () => serverChannels.filter((c) => c.type === 'text' && c.secure !== true),
    [serverChannels],
  );
  const channelName = (id: string) => serverChannels.find((c) => c.id === id)?.name ?? null;
  // What either picker offers: the server's answer, the fallback, or `null` while it loads
  const pickerChannels = targets.state === 'ready' ? targets.list : targets.state === 'fallback' ? eligibleChannels : null;
  // The edited webhook as the list has it NOW
  const editing = editingId !== null && webhooks !== null ? webhooks.find((w) => w.id === editingId) ?? null : null;

  // The server's count, not the visible rows: the cap counts webhooks on
  // channels this viewer cannot see too (listWebhooks falls back to the
  // visible rows for a server that sends no total)
  const used = total;
  const atCap = max !== null && used >= max;
  const capReason = !atCap ? undefined : max === 0 ? t('webhooks.frozen') : t('webhooks.atCap', { max });

  /**
   * One relative phrase ("3 days ago") in the UI language, no extra keys.
   * `null` for an unparsable date: Intl.RelativeTimeFormat THROWS on NaN, and
   * one bad row must not take the whole tab down mid-render.
   */
  const relative = (iso: string): string | null => {
    const at = new Date(iso).getTime();
    if (!Number.isFinite(at)) return null;
    const diff = (at - Date.now()) / 1000;
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60],
    ];
    const fmt = new Intl.RelativeTimeFormat(i18n?.language, { numeric: 'auto' });
    for (const [unit, seconds] of units) {
      if (Math.abs(diff) >= seconds) return fmt.format(Math.round(diff / seconds), unit);
    }
    return fmt.format(Math.round(diff), 'second');
  };

  /**
   * A calendar date in the UI language. `null` for an unparsable one:
   * Intl.DateTimeFormat throws on NaN too.
   */
  const day = (iso: string): string | null => {
    const at = new Date(iso).getTime();
    if (!Number.isFinite(at)) return null;
    return new Intl.DateTimeFormat(i18n?.language, { dateStyle: 'medium' }).format(at);
  };

  const typeLabel = (type: WebhookType) => (type === 'github' ? t('webhooks.typeGithub') : t('webhooks.typeGeneric'));

  /** A refusal: the flag-off answer flips the tab to its OFF state, anything else is logged and toasted. */
  const fail = (err: unknown, fallbackKey: string) => {
    if (isWebhooksOff(err)) { setOff(true); return; }
    // An axios message ("Request failed with status code 404") never carries the
    // token; the error object itself would (its config holds the Authorization header)
    console.warn('[Integrations] Webhook action failed:', err instanceof Error ? err.message : String(err));
    toast.error(getTranslatedError(err, t, fallbackKey));
  };

  // Token requests (create, rotate) are numbered when SENT, and the panel only
  // moves forward: an answer older than the one on screen never replaces it.
  // Two rotations of one webhook answering out of order would otherwise show
  // the OLDER token, which the newer rotation has already killed.
  const tokenSeq = useRef(0);
  const shownTokenSeq = useRef(0);
  const showToken = (seq: number, created: WebhookCreated, rotated: boolean) => {
    if (seq < shownTokenSeq.current) return;
    // Moves forward even for an answer it cannot show: an OLDER answer
    // landing after this one would carry a token this request already killed
    shownTokenSeq.current = seq;
    const url = webhookUrl(created.id, created.token);
    if (url === null) {
      // An id or token that is not a plain URL segment: no panel, no URL that
      // points somewhere else. Logged without either value (the token is a credential).
      console.warn('[Integrations] The server answered a malformed webhook id or token; the URL is not shown');
      toast.error(t('webhooks.reveal.invalidUrl'));
      return;
    }
    setReveal({
      name: created.name,
      url,
      ...(created.secret ? { secret: created.secret } : {}),
      rotated,
    });
  };

  const handleCreate = async (input: CreateWebhookInput) => {
    const seq = ++tokenSeq.current;
    setCreateBusy(true);
    try {
      const created = await createWebhook(serverId, input);
      if (!mounted.current) return;
      setCreating(false);
      showToken(seq, created, false);
    } catch (err) {
      if (!mounted.current) return;
      if (isWebhooksOff(err)) setCreating(false);
      fail(err, 'webhooks.create.failed');
    } finally {
      if (mounted.current) {
        setCreateBusy(false);
        void refetch();
      }
    }
  };

  const handleRotate = async (webhook: Webhook) => {
    const seq = ++tokenSeq.current;
    markBusy(webhook.id);
    try {
      const rotated = await rotateWebhook(serverId, webhook.id);
      if (!mounted.current) return;
      setConfirmRotate(null);
      showToken(seq, rotated, true);
    } catch (err) {
      if (!mounted.current) return;
      setConfirmRotate(null);
      fail(err, 'webhooks.rotate.failed');
    } finally {
      if (mounted.current) {
        clearBusy(webhook.id);
        void refetch();
      }
    }
  };

  const handleToggle = async (webhook: Webhook) => {
    // An administrator's disable is sticky: the server refuses the owner's
    // enable (403), so the control is disabled and this never sends it
    if (webhook.adminDisabledAt && !webhook.enabled) return;
    markBusy(webhook.id);
    try {
      await updateWebhook(serverId, webhook.id, { enabled: !webhook.enabled });
    } catch (err) {
      if (mounted.current) fail(err, 'webhooks.toggleFailed');
    } finally {
      if (mounted.current) {
        clearBusy(webhook.id);
        void refetch();
      }
    }
  };

  // A rename and/or a move, the changed fields only. The list is NOT refetched
  // here and the answer is not written into it: the PATCH emits
  // `webhook:changed`, whose refetch shows the server's row. A refusal stays
  // in the dialog, next to the values it refused.
  const handleEdit = async (webhook: Webhook, patch: WebhookEditPatch) => {
    markBusy(webhook.id);
    setEditError(null);
    try {
      await updateWebhook(serverId, webhook.id, patch);
      if (!mounted.current) return;
      // Only THIS webhook's dialog: the row may have left the list meanwhile
      // and the user opened another one, which this answer must not close
      if (editingIdRef.current === webhook.id) setEditing(null);
      toast.success(t('webhooks.edit.saved', { name: patch.name ?? webhook.name }));
    } catch (err) {
      if (!mounted.current) return;
      if (isWebhooksOff(err)) { setEditing(null); setOff(true); return; }
      // The message only (never the token); never the error object (its config holds the Authorization header)
      console.warn('[Integrations] Webhook action failed:', err instanceof Error ? err.message : String(err));
      const message = getTranslatedError(err, t, 'webhooks.edit.failed');
      // The dialog may be gone meanwhile (the row left the list): toasted then, never lost
      if (editingIdRef.current === webhook.id) setEditError({ id: webhook.id, message });
      else toast.error(message);
    } finally {
      if (mounted.current) clearBusy(webhook.id);
    }
  };

  const handleDelete = async (webhook: Webhook) => {
    markBusy(webhook.id);
    const withMessages = purge;
    try {
      const { deletedMessages } = await deleteWebhook(serverId, webhook.id, withMessages);
      if (!mounted.current) return;
      setConfirmDelete(null);
      toast.success(withMessages
        ? t('webhooks.delete.deletedMessages', { count: deletedMessages, name: webhook.name })
        : t('webhooks.delete.deleted', { name: webhook.name }));
    } catch (err) {
      if (!mounted.current) return;
      setConfirmDelete(null);
      fail(err, 'webhooks.delete.failed');
    } finally {
      if (mounted.current) {
        clearBusy(webhook.id);
        void refetch();
      }
    }
  };

  // Rendered in BOTH states, at the same place in the tree: a refetch that
  // answers the flag-off 403 while the panel is open (a reconnect, a fellow
  // moderator's edit) must not unmount it. Its token is still the webhook's
  // credential (it works again once the feature is back on) and may not be
  // copied yet; the panel is portaled, so it shows over either view.
  const revealPanel = reveal && (
    <WebhookCreatedPanel
      name={reveal.name}
      url={reveal.url}
      secret={reveal.secret}
      rotated={reveal.rotated}
      onClose={() => setReveal(null)}
    />
  );

  if (off) {
    return (
      <>
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-center" data-testid="integrations-off">
          <PowerOff size={22} className="text-vox-text-muted" />
          <p className="text-sm text-vox-text-secondary">{t('webhooks.off.title')}</p>
          <p className="text-xs text-vox-text-muted">{t('webhooks.off.hint')}</p>
        </div>
        {revealPanel}
      </>
    );
  }

  return (
    <>
      <div className="space-y-4" data-testid="integrations-tab">
        {/* Header: the count against the cap, and the way to add one */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-text-primary">
              <WebhookIcon size={14} />
              <span>{t('webhooks.title')}</span>
              {webhooks !== null && (
                <span className="font-normal text-vox-text-muted" data-testid="integrations-count">
                  · {max !== null ? t('webhooks.usage', { used, max }) : used}
                </span>
              )}
            </h3>
            <p className="mt-0.5 text-xs text-vox-text-muted">{t('webhooks.hint')}</p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            disabled={webhooks === null || atCap}
            title={capReason}
            className="btn-primary flex shrink-0 items-center gap-1.5 text-sm disabled:opacity-50"
            data-testid="webhook-new"
          >
            <Plus size={14} />
            {t('webhooks.newWebhook')}
          </button>
        </div>
        {atCap && <p className="text-xs text-vox-text-muted" data-testid="integrations-cap">{capReason}</p>}

        {/* The list */}
        {webhooks === null ? (
          loadFailed ? (
            <div className="flex h-32 flex-col items-center justify-center gap-3 text-center" data-testid="integrations-error">
              <p className="text-sm text-vox-text-secondary">{t('webhooks.failedToLoad')}</p>
              <button type="button" onClick={() => void refetch()} className="rounded-lg border border-vox-border px-3 py-1.5 text-xs text-vox-text-secondary hover:bg-vox-bg-hover">
                {t('webhooks.retry')}
              </button>
            </div>
          ) : (
            <div className="flex justify-center py-8" data-testid="integrations-loading">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
            </div>
          )
        ) : webhooks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-vox-border px-4 py-6 text-center" data-testid="integrations-empty">
            <p className="text-sm text-vox-text-secondary">{t('webhooks.empty')}</p>
            <p className="mt-1 text-xs text-vox-text-muted">{t('webhooks.emptyHint')}</p>
          </div>
        ) : (
          <ul className="space-y-2" aria-label={t('webhooks.title')} data-testid="webhook-list">
            {webhooks.map((w) => {
              const channel = channelName(w.channelId);
              const busy = busyIds.has(w.id);
              const lastUsed = w.lastUsedAt ? relative(w.lastUsedAt) : null;
              const rotatedWhen = w.lastRotatedAt ? relative(w.lastRotatedAt) : null;
              // Truthiness, not `!== null`: an older server sends neither field
              const adminDisabled = Boolean(w.adminDisabledAt);
              // An administrator's disable says more than the creator's removal:
              // enabling is not the owner's call then, so the rotate-then-enable
              // advice would be wrong
              const creatorRemoved = !adminDisabled && Boolean(w.creatorRemovedAt);
              const removedOn = creatorRemoved && w.creatorRemovedAt ? day(w.creatorRemovedAt) : null;
              const enableLocked = adminDisabled && !w.enabled;
              return (
                <li
                  key={w.id}
                  className={`rounded-lg border border-vox-border bg-vox-bg-secondary px-4 py-3 transition-opacity ${w.enabled ? '' : 'opacity-60'}`}
                  data-testid={`webhook-row-${w.id}`}
                  data-enabled={w.enabled ? 'true' : 'false'}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-vox-text-primary" data-testid="webhook-name">{w.name}</span>
                        <span className="rounded-full border border-vox-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-vox-text-secondary" data-testid="webhook-type">
                          {typeLabel(w.type)}
                        </span>
                        {adminDisabled ? (
                          <span
                            className="rounded-full bg-vox-accent-danger/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-vox-accent-danger"
                            title={t('webhooks.adminDisabledHint')}
                            data-testid="webhook-admin-disabled"
                          >
                            {t('webhooks.adminDisabledChip')}
                          </span>
                        ) : !w.enabled && (
                          <span className="rounded-full bg-vox-accent-danger/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-vox-accent-danger" data-testid="webhook-disabled">
                            {t('webhooks.disabledChip')}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-vox-text-muted">
                        {channel !== null ? (
                          <span className="inline-flex items-center gap-0.5 text-vox-text-secondary" data-testid="webhook-channel">
                            <Hash size={12} />{channel}
                          </span>
                        ) : (
                          <span className="italic" data-testid="webhook-channel-missing">{t('webhooks.channelMissing')}</span>
                        )}
                        <span aria-hidden="true">·</span>
                        {w.createdBy ? (
                          <span data-testid="webhook-creator">{t('webhooks.createdBy', { name: w.createdBy.displayName })}</span>
                        ) : (
                          <span className="italic" data-testid="webhook-creator">{t('webhooks.createdByUnknown')}</span>
                        )}
                        <span aria-hidden="true">·</span>
                        <span data-testid="webhook-last-used">
                          {lastUsed !== null ? t('webhooks.lastUsed', { when: lastUsed }) : t('webhooks.neverUsed')}
                        </span>
                        {rotatedWhen !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            {/* The rotator's account may be gone: the time alone then */}
                            <span data-testid="webhook-rotated">
                              {w.lastRotatedBy
                                ? t('webhooks.rotatedBy', { when: rotatedWhen, name: w.lastRotatedBy.displayName })
                                : t('webhooks.rotated', { when: rotatedWhen })}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Offered on an administrator's lock too: a rename or a move is not an enable */}
                      <RowAction label={t('webhooks.actions.edit')} disabled={busy} onClick={() => openEdit(w)} testId="webhook-edit">
                        <Pencil size={14} />
                      </RowAction>
                      <RowAction label={t('webhooks.actions.rotate')} disabled={busy} onClick={() => setConfirmRotate(w)} testId="webhook-rotate">
                        <RefreshCw size={14} />
                      </RowAction>
                      <RowAction
                        label={w.enabled ? t('webhooks.actions.disable') : t('webhooks.actions.enable')}
                        // Shown, not hidden: the tooltip says why it cannot be enabled
                        title={enableLocked ? t('webhooks.adminDisabledHint') : undefined}
                        disabled={busy || enableLocked}
                        onClick={() => void handleToggle(w)}
                        testId="webhook-toggle"
                      >
                        {w.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                      </RowAction>
                      <RowAction label={t('webhooks.actions.delete')} disabled={busy} danger onClick={() => { setPurge(false); setConfirmDelete(w); }} testId="webhook-delete">
                        <Trash2 size={14} />
                      </RowAction>
                    </div>
                  </div>
                  {creatorRemoved && (
                    // The URL may have left with the removed creator: rotate first.
                    // Enabling stays allowed (it clears the mark server-side).
                    <div
                      className="mt-2 flex flex-wrap items-start justify-between gap-2 rounded-md border border-vox-accent-warning/30 bg-vox-accent-warning/10 px-3 py-2 text-xs text-vox-text-secondary"
                      role="note"
                      data-testid="webhook-creator-removed"
                    >
                      <p className="flex min-w-0 flex-1 items-start gap-1.5">
                        <AlertTriangle size={14} className="mt-px shrink-0 text-vox-accent-warning" aria-hidden="true" />
                        <span data-testid="webhook-creator-removed-text">
                          {removedOn !== null ? t('webhooks.creatorRemoved', { date: removedOn }) : t('webhooks.creatorRemovedUndated')}
                        </span>
                      </p>
                      <button
                        type="button"
                        onClick={() => setConfirmRotate(w)}
                        disabled={busy}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-vox-border px-2 py-1 text-xs text-vox-text-primary transition-colors hover:bg-vox-bg-hover disabled:opacity-50"
                        data-testid="webhook-creator-removed-rotate"
                      >
                        <RefreshCw size={12} aria-hidden="true" />
                        {t('webhooks.actions.rotate')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {creating && (
          <WebhookCreateDialog
            channels={pickerChannels}
            busy={createBusy}
            onCreate={(input) => void handleCreate(input)}
            onClose={() => setCreating(false)}
          />
        )}

        {editing && (
          <WebhookEditDialog
            // One draft per webhook: nothing typed for one ever shows on another
            key={editing.id}
            webhook={editing}
            channels={pickerChannels}
            busy={busyIds.has(editing.id)}
            error={editError?.id === editing.id ? editError.message : null}
            onDismissError={() => setEditError(null)}
            onSave={(patch) => void handleEdit(editing, patch)}
            onClose={() => setEditing(null)}
          />
        )}

        {confirmRotate && (
          <ConfirmDialog
            id="webhook-rotate-title"
            title={t('webhooks.rotate.title')}
            // a GitHub webhook's rotation also replaces its signing secret
            body={confirmRotate.type === 'github'
              ? t('webhooks.rotate.bodyGithub', { name: confirmRotate.name })
              : t('webhooks.rotate.body', { name: confirmRotate.name })}
            confirmLabel={busyIds.has(confirmRotate.id) ? t('webhooks.rotate.rotating') : t('webhooks.rotate.confirm')}
            busy={busyIds.has(confirmRotate.id)}
            onConfirm={() => void handleRotate(confirmRotate)}
            onClose={() => setConfirmRotate(null)}
            testId="webhook-rotate-dialog"
          />
        )}

        {confirmDelete && (
          <ConfirmDialog
            id="webhook-delete-title"
            title={t('webhooks.delete.title')}
            body={t('webhooks.delete.body', { name: confirmDelete.name })}
            confirmLabel={busyIds.has(confirmDelete.id) ? t('common.deleting') : t('common.delete')}
            busy={busyIds.has(confirmDelete.id)}
            danger
            onConfirm={() => void handleDelete(confirmDelete)}
            onClose={() => setConfirmDelete(null)}
            testId="webhook-delete-dialog"
          >
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-vox-text-secondary">
              <input
                type="checkbox"
                checked={purge}
                onChange={(e) => setPurge(e.target.checked)}
                className="mt-0.5"
                data-testid="webhook-delete-purge"
              />
              <span>{t('webhooks.delete.alsoDeleteMessages')}</span>
            </label>
          </ConfirmDialog>
        )}
      </div>
      {revealPanel}
    </>
  );
}

function RowAction({ label, title, disabled, danger = false, onClick, testId, children }: {
  label: string;
  /** The tooltip, when it must say more than the label (why the action is disabled). */
  title?: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-50 ${
        danger
          ? 'text-vox-text-muted hover:bg-vox-accent-danger/10 hover:text-vox-accent-danger'
          : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function ConfirmDialog({ id, title, body, confirmLabel, busy, danger = false, onConfirm, onClose, testId, children }: {
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <WebhookDialog labelledBy={id} onClose={onClose} busy={busy} testId={testId}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 id={id} className="text-base font-bold text-vox-text-primary">{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50" aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </div>
      <p className="text-sm text-vox-text-secondary">{body}</p>
      {children}
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className={danger ? 'btn-danger' : 'btn-primary'} data-testid={`${testId}-confirm`}>
          {confirmLabel}
        </button>
      </div>
    </WebhookDialog>
  );
}
