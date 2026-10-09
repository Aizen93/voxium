import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import { DISCOVERY_TAGS, LIMITS, validateServerDescription, validateDiscoveryTags } from '@voxium/shared';
import type { DiscoveryServer, ServerDiscoveryInfo, ServerJoinMode } from '@voxium/shared';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { getTranslatedError, translateServerError } from '../../utils/serverErrors';
import { DiscoveryCard } from '../discovery/DiscoveryCard';

interface Props {
  serverId: string;
  /** "Hidden while invites are locked" links to the General tab. */
  onGoToGeneral: () => void;
}

/**
 * Server settings → Discovery: the owner's side of the directory. Every
 * server is listed by default with approval-first joining; this is where the
 * owner hides it, opens it, and fills in the card. The preview IS the card
 * newcomers see (same component). Store updates come from server:updated,
 * never from the PATCH response.
 */
export function DiscoveryTab({ serverId, onGoToGeneral }: Props) {
  const { t } = useTranslation();
  const server = useServerStore((s) => s.servers.find((x) => x.id === serverId));
  const updateDiscovery = useServerStore((s) => s.updateDiscovery);
  const fetchDiscoveryInfo = useServerStore((s) => s.fetchDiscoveryInfo);

  const [discoverable, setDiscoverable] = useState(server?.discoverable ?? true);
  const [joinMode, setJoinMode] = useState<ServerJoinMode>(server?.joinMode ?? 'approval');
  const [description, setDescription] = useState(server?.description ?? '');
  const [tags, setTags] = useState<string[]>(server?.tags ?? []);
  const [info, setInfo] = useState<ServerDiscoveryInfo | null>(null);
  const [saving, setSaving] = useState(false);

  // Which fields the owner has touched since the last save. A server:updated
  // (another moderator saved, or our own save echoing back) resyncs the
  // UNTOUCHED drafts to the store and leaves the touched ones alone — the
  // draft neither fights the store nor silently discards typing.
  const dirty = useRef<{ discoverable: boolean; joinMode: boolean; description: boolean; tags: boolean }>({
    discoverable: false, joinMode: false, description: false, tags: false,
  });
  const serverDiscoverable = server?.discoverable ?? true;
  const serverJoinMode = server?.joinMode ?? 'approval';
  const serverDescription = server?.description ?? '';
  const serverTagsKey = (server?.tags ?? []).join(',');
  useEffect(() => {
    if (!dirty.current.discoverable) setDiscoverable(serverDiscoverable);
    if (!dirty.current.joinMode) setJoinMode(serverJoinMode);
    if (!dirty.current.description) setDescription(serverDescription);
    if (!dirty.current.tags) setTags(serverTagsKey ? serverTagsKey.split(',') : []);
  }, [serverDiscoverable, serverJoinMode, serverDescription, serverTagsKey]);

  useEffect(() => {
    let cancelled = false;
    fetchDiscoveryInfo(serverId)
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch((err) => {
        console.warn('[Discovery] Failed to load discovery info:', err);
        if (!cancelled) toast.error(t('discovery.settings.failedToLoad'));
      });
    return () => { cancelled = true; };
  }, [serverId, fetchDiscoveryInfo, t]);

  const blocked = !!info?.discoveryBlockedAt;

  const preview = useMemo<DiscoveryServer | null>(() => {
    if (!server) return null;
    return {
      id: server.id,
      name: server.name,
      iconUrl: server.iconUrl,
      description: description.trim() || null,
      tags,
      memberCount: info?.memberCount ?? 0,
      onlineCount: info?.onlineCount ?? 0,
      weeklyMessages: info?.weeklyMessages ?? 0,
      joinMode,
      featured: !!info?.featuredAt,
      isMember: false,
      requestPending: false,
      createdAt: server.createdAt,
      statsRefreshedAt: info?.statsRefreshedAt ?? null,
    };
  }, [server, description, tags, joinMode, info]);

  if (!server || !preview) return null;

  const changes: { discoverable?: boolean; joinMode?: ServerJoinMode; description?: string | null; tags?: string[] } = {};
  if (discoverable !== server.discoverable) changes.discoverable = discoverable;
  if (joinMode !== server.joinMode) changes.joinMode = joinMode;
  if ((description.trim() || null) !== (server.description ?? null)) changes.description = description.trim() || null;
  if (tags.join(',') !== (server.tags ?? []).join(',')) changes.tags = tags;
  const hasChanges = Object.keys(changes).length > 0;

  const toggleTag = (tag: string) => {
    dirty.current.tags = true;
    setTags((prev) => {
      if (prev.includes(tag)) return prev.filter((x) => x !== tag);
      if (prev.length >= LIMITS.DISCOVERY_MAX_TAGS) return prev;
      return [...prev, tag];
    });
  };

  const handleSave = async () => {
    if (!hasChanges || saving) return;
    if (changes.description !== undefined && changes.description !== null) {
      const err = validateServerDescription(changes.description);
      if (err) { toast.error(translateServerError(err, t)); return; }
    }
    if (changes.tags !== undefined) {
      const err = validateDiscoveryTags(changes.tags);
      if (err) { toast.error(translateServerError(err, t)); return; }
    }
    setSaving(true);
    try {
      await updateDiscovery(serverId, changes);
      // Saved: the drafts are the store's values now (server:updated carries
      // them back), so nothing is dirty any more.
      dirty.current = { discoverable: false, joinMode: false, description: false, tags: false };
      toast.success(t('discovery.settings.saved'));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'discovery.settings.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const lastCheck = info?.statsRefreshedAt ? new Date(info.statsRefreshedAt).toLocaleString() : null;

  return (
    <div className="space-y-6" data-testid="discovery-tab">
      {/* Listed in Explore */}
      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-vox-text-primary">
              {discoverable ? <Eye size={14} /> : <EyeOff size={14} />}
              {t('discovery.settings.title')}
            </h3>
            <p className="mt-0.5 text-xs text-vox-text-muted">{t('discovery.settings.listedHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={discoverable}
            disabled={blocked}
            onClick={() => { dirty.current.discoverable = true; setDiscoverable((v) => !v); }}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${discoverable ? 'bg-vox-accent-primary' : 'bg-vox-bg-hover border border-vox-border'}`}
            data-testid="discovery-listed-toggle"
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${discoverable ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="mt-2 text-xs text-vox-text-muted">{t('discovery.settings.audience')}</p>
        {blocked && (
          <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 px-3 py-2 text-xs text-vox-accent-danger" data-testid="discovery-blocked-notice">
            <ShieldAlert size={14} />
            {t('discovery.settings.blockedByAdmin')}
          </p>
        )}
        {!blocked && discoverable && server.invitesLocked && (
          <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/5 px-3 py-2 text-xs text-vox-accent-warning" data-testid="discovery-locked-notice">
            <Lock size={14} />
            <span>{t('discovery.settings.hiddenInvitesLocked')}</span>
            <button type="button" onClick={onGoToGeneral} className="ml-auto underline underline-offset-2 hover:text-vox-text-primary">
              {t('discovery.settings.goToGeneral')}
            </button>
          </p>
        )}
      </section>

      {/* Who can join */}
      <section>
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('discovery.settings.whoCanJoin')}</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('discovery.settings.whoCanJoin')}>
          {(['approval', 'open'] as const).map((mode) => (
            <label
              key={mode}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                joinMode === mode ? 'border-vox-accent-primary bg-vox-accent-primary/5' : 'border-vox-border hover:bg-vox-bg-hover'
              }`}
            >
              <input
                type="radio"
                name="joinMode"
                value={mode}
                checked={joinMode === mode}
                onChange={() => { dirty.current.joinMode = true; setJoinMode(mode); }}
                className="mt-0.5"
                data-testid={`discovery-join-${mode}`}
              />
              <span>
                <span className="block font-medium text-vox-text-primary">
                  {mode === 'approval' ? t('discovery.settings.joinApproval') : t('discovery.settings.joinOpen')}
                </span>
                <span className="block text-vox-text-muted">
                  {mode === 'approval' ? t('discovery.settings.joinApprovalHint') : t('discovery.settings.joinOpenHint')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Description */}
      <section>
        <div className="flex items-baseline justify-between">
          <label htmlFor="discovery-description" className="text-sm font-semibold text-vox-text-primary">{t('discovery.settings.description')}</label>
          <span className={`text-[11px] ${description.length > LIMITS.SERVER_DESCRIPTION_MAX ? 'text-vox-accent-danger' : 'text-vox-text-muted'}`} data-testid="discovery-description-count">
            {description.length}/{LIMITS.SERVER_DESCRIPTION_MAX}
          </span>
        </div>
        <textarea
          id="discovery-description"
          value={description}
          onChange={(e) => { dirty.current.description = true; setDescription(e.target.value); }}
          maxLength={LIMITS.SERVER_DESCRIPTION_MAX}
          rows={3}
          placeholder={t('discovery.settings.descriptionPlaceholder')}
          className="mt-1.5 w-full resize-none rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none"
          data-testid="discovery-description"
        />
        {!description.trim() && <p className="mt-1 text-xs text-vox-text-muted">{t('discovery.settings.descriptionNudge')}</p>}
      </section>

      {/* Tags */}
      <section>
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('discovery.settings.tags')}</h3>
        <p className="mt-0.5 text-xs text-vox-text-muted">{t('discovery.settings.tagsHint', { max: LIMITS.DISCOVERY_MAX_TAGS })}</p>
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="discovery-tags">
          {DISCOVERY_TAGS.map((tag) => {
            const selected = tags.includes(tag);
            const full = !selected && tags.length >= LIMITS.DISCOVERY_MAX_TAGS;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                disabled={full}
                aria-pressed={selected}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? 'border-vox-accent-primary bg-vox-accent-primary/15 text-vox-text-primary'
                    : 'border-vox-border text-vox-text-secondary hover:border-vox-text-muted'
                }`}
                data-testid={`discovery-tag-${tag}`}
              >
                {t(`discovery.tags.${tag}`)}
              </button>
            );
          })}
        </div>
      </section>

      {/* Preview */}
      <section>
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('discovery.settings.preview')}</h3>
        <div className="mt-2 max-w-md">
          <DiscoveryCard server={preview} preview />
        </div>
      </section>

      {/* Activity */}
      <section className="rounded-lg border border-vox-border bg-vox-bg-secondary px-4 py-3 text-xs text-vox-text-secondary" data-testid="discovery-stats">
        <h3 className="text-sm font-semibold text-vox-text-primary">{t('discovery.settings.stats')}</h3>
        <ul className="mt-1 space-y-0.5">
          <li>{t('discovery.settings.statsMembers', { count: info?.memberCount ?? 0 })}</li>
          <li>{t('discovery.settings.statsMessages', { count: info?.weeklyMessages ?? 0 })}</li>
          <li>{t('discovery.settings.statsOnline', { count: info?.onlineCount ?? 0 })}</li>
        </ul>
        <p className="mt-1.5 text-vox-text-muted">
          {lastCheck ? `${t('discovery.settings.statsRefreshedAt', { when: lastCheck })} · ${t('discovery.settings.statsDaily')}` : t('discovery.settings.statsNever')}
        </p>
      </section>

      <button
        type="button"
        onClick={handleSave}
        disabled={!hasChanges || saving}
        className="btn-primary w-full disabled:opacity-50"
        data-testid="discovery-save"
      >
        {saving ? t('common.saving') : t('discovery.settings.save')}
      </button>
    </div>
  );
}
