import { useTranslation } from 'react-i18next';
import { Star, Users, Radio } from 'lucide-react';
import type { DiscoveryServer } from '@voxium/shared';
import { ServerIcon } from '../server/ServerIcon';

/**
 * One directory card — the SAME component in Explore and in the owner's
 * Discovery tab preview, so what the owner sees is what newcomers get.
 *
 * The numbers on the card are the whole ranking (online × 10 + messages in
 * 7 days + members): nothing is personalised, so every input is printed.
 * Online and messages are a daily snapshot; the member count is live.
 *
 * The one button depends on the server's join mode and the viewer's state:
 * Join (open), Request to join (approval), Requested with a cancel action
 * (pending), Open (already a member). In `preview` mode the button is shown
 * but inert, and no menu is rendered.
 */
export interface DiscoveryCardProps {
  server: DiscoveryServer;
  /** Render as the owner's preview: no handlers, the button is inert. */
  preview?: boolean;
  busy?: boolean;
  onJoin?: (server: DiscoveryServer) => void;
  onRequest?: (server: DiscoveryServer) => void;
  onCancelRequest?: (server: DiscoveryServer) => void;
  onOpen?: (server: DiscoveryServer) => void;
  onReport?: (server: DiscoveryServer) => void;
}

export function DiscoveryCard({ server, preview = false, busy = false, onJoin, onRequest, onCancelRequest, onOpen, onReport }: DiscoveryCardProps) {
  const { t } = useTranslation();
  const inert = preview || busy;

  let action: { label: string; onClick?: () => void; primary: boolean; testid: string };
  if (server.isMember) {
    action = { label: t('discovery.card.open'), onClick: () => onOpen?.(server), primary: false, testid: 'discovery-open' };
  } else if (server.requestPending) {
    action = { label: t('discovery.card.requested'), primary: false, testid: 'discovery-requested' };
  } else if (server.joinMode === 'open') {
    action = { label: t('discovery.card.join'), onClick: () => onJoin?.(server), primary: true, testid: 'discovery-join' };
  } else {
    action = { label: t('discovery.card.requestToJoin'), onClick: () => onRequest?.(server), primary: true, testid: 'discovery-join' };
  }

  return (
    <article
      className="flex flex-col gap-3 rounded-xl border border-vox-border bg-vox-bg-secondary p-4 transition-colors hover:border-vox-text-muted/40"
      data-testid="discovery-card"
      data-server-id={server.id}
    >
      <div className="flex items-start gap-3">
        <ServerIcon id={server.id} name={server.name} iconUrl={server.iconUrl} size={44} rounded="rounded-xl" className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-vox-text-primary" data-testid="discovery-card-name">{server.name}</h3>
            {server.featured && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-vox-accent-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-vox-accent-warning"
                data-testid="discovery-featured"
              >
                <Star size={10} />
                {t('discovery.card.featured')}
              </span>
            )}
          </div>
          <p
            className={`mt-1 text-xs leading-relaxed ${server.description ? 'text-vox-text-secondary' : 'italic text-vox-text-muted'}`}
            style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            data-testid="discovery-card-description"
          >
            {server.description || t('discovery.card.noDescription')}
          </p>
        </div>
        {!preview && onReport && (
          <button
            type="button"
            onClick={() => onReport(server)}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary"
            aria-label={t('discovery.card.report')}
            data-testid="discovery-report"
          >
            …
          </button>
        )}
      </div>

      {server.tags.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="discovery-card-tags">
          {server.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="rounded-full border border-vox-border px-2 py-0.5 text-[11px] text-vox-text-secondary">
              {t(`discovery.tags.${tag}`)}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-vox-text-muted" title={t('discovery.card.onlineHint')}>
          <span className="inline-flex items-center gap-1" data-testid="discovery-card-online">
            <Radio size={12} className="text-vox-accent-success" />
            {t('discovery.card.online', { count: server.onlineCount })}
          </span>
          <span className="inline-flex items-center gap-1" data-testid="discovery-card-members">
            <Users size={12} />
            {t('discovery.card.members', { count: server.memberCount })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={inert ? undefined : action.onClick}
            disabled={inert || !action.onClick}
            aria-disabled={inert || !action.onClick}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
              action.primary
                ? 'bg-vox-accent-primary text-vox-on-accent hover:bg-vox-accent-hover'
                : 'border border-vox-border text-vox-text-secondary hover:bg-vox-bg-hover'
            }`}
            data-testid={action.testid}
          >
            {action.label}
          </button>
          {server.requestPending && !server.isMember && (
            <button
              type="button"
              onClick={inert ? undefined : () => onCancelRequest?.(server)}
              disabled={inert}
              className="rounded-lg px-2 py-1.5 text-xs text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary disabled:opacity-60"
              data-testid="discovery-cancel-request"
            >
              {t('discovery.card.cancelRequest')}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
