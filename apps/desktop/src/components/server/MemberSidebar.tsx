import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MicOff } from 'lucide-react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { MemberContextMenu } from './MemberContextMenu';
import { MembersDialog } from './MembersDialog';
import { clsx } from 'clsx';
import type { ServerMember, VoiceUser } from '@voxium/shared';
import { StaffBadge } from '../common/StaffBadge';
import { SupporterBadge } from '../common/SupporterBadge';
import { groupPeopleByPresence, presentCount, voicePresenceKind, withOwnPresence } from '../../utils/peopleGroups';

interface ContextMenuState {
  member: ServerMember;
  position: { x: number; y: number };
}

/**
 * The People panel (2026 redesign): presence-first sections — who is in voice,
 * who is active, who is away — instead of role sections. Role identity stays
 * on the rows themselves (name colors, badges); the section axis is what
 * people are doing right now.
 *
 * It is a PRESENCE view, not the member list (CLAUDE.md "Server Membership"):
 * on a small server every member is loaded and the Offline section lists
 * them; on a big one only the online members are, the Offline section
 * collapses to a count and a way into the directory (a plain "All members"
 * dialog, for every member — never Server settings, which is the
 * administration surface), and when the online members outnumber the slice
 * the panel says how many more are online.
 */
export function MemberSidebar() {
  const { t } = useTranslation();
  const { members: knownMembers, roles, channels, people, activeServerId } = useServerStore();
  const channelUsers = useVoiceStore((s) => s.channelUsers);
  const selfId = useAuthStore((s) => s.user?.id);
  const connected = useConnectionStatus() === 'connected';
  // Our own row reads online while the socket is up (nobody echoes our presence to us)
  const members = useMemo(() => withOwnPresence(knownMembers, selfId, connected), [knownMembers, selfId, connected]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showDirectory, setShowDirectory] = useState(false);

  // A voice participant with no row yet (a big server, someone outside the
  // slice): ask for it, so the In voice section can show them
  useEffect(() => {
    const missing: string[] = [];
    const known = new Set(members.map((m) => m.userId));
    for (const ch of channels) {
      if (ch.type !== 'voice') continue;
      for (const vu of channelUsers.get(ch.id) || []) if (!known.has(vu.id)) missing.push(vu.id);
    }
    if (missing.length) useServerStore.getState().ensureMembers(missing);
  }, [members, channels, channelUsers]);

  // Top-role color per member (unchanged from the role-grouped panel).
  const topRoleColorMap = useMemo(() => {
    const roleInfoMap = new Map(
      roles.filter((r) => !r.isDefault).map((r) => [r.id, { position: r.position, color: r.color }]),
    );
    const colorMap = new Map<string, string | null>();
    for (const m of members) {
      if (!m.roles?.length) continue;
      let topColor: string | null = null;
      let topPosition = -1;
      for (const r of m.roles) {
        const info = roleInfoMap.get(r.id);
        if (info && info.position > topPosition) {
          topPosition = info.position;
          topColor = info.color;
        }
      }
      colorMap.set(m.userId, topColor);
    }
    return colorMap;
  }, [members, roles]);

  const groups = useMemo(
    () => groupPeopleByPresence(members, channels, channelUsers, { includeOffline: people.full }),
    [members, channels, channelUsers, people.full],
  );

  function handleContextMenu(e: React.MouseEvent, member: ServerMember) {
    e.preventDefault();
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } });
  }

  // With everyone loaded the rows are the truth; otherwise the server's
  // figure, moved by the events since — never below what is on screen
  const present = presentCount(groups);
  const online = people.full ? present : Math.max(people.onlineCount, present);
  const moreOnline = people.truncated ? Math.max(0, people.onlineCount - present) : 0;
  const offlineHidden = people.loaded && !people.full ? Math.max(0, people.memberCount - online) : 0;

  return (
    <div className="panel flex h-full w-[272px] flex-none flex-col bg-vox-bg-secondary" data-testid="people-panel">
      {/* Header */}
      <div className="flex h-[54px] flex-none items-center gap-2 border-b border-vox-border px-4">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-vox-text-primary">{t('people.title')}</span>
        <span className="font-mono text-[11px] text-vox-text-muted" data-testid="people-online-count">{online}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {groups.voiceSections.map((section) => (
          <PeopleSection key={section.channelId} label={`${t('people.inVoice')} · ${section.channelName}`}>
            {section.entries.map(({ member, voice }) => (
              <PersonRow
                key={member.userId}
                member={member}
                roleColor={topRoleColorMap.get(member.userId) || undefined}
                voice={voice}
                onContextMenu={handleContextMenu}
              />
            ))}
          </PeopleSection>
        ))}

        {groups.active.length > 0 && (
          <PeopleSection label={`${t('people.active')} · ${groups.active.length}`}>
            {groups.active.map((member) => (
              <PersonRow
                key={member.userId}
                member={member}
                roleColor={topRoleColorMap.get(member.userId) || undefined}
                onContextMenu={handleContextMenu}
              />
            ))}
          </PeopleSection>
        )}

        {groups.away.length > 0 && (
          <PeopleSection label={`${t('people.away')} · ${groups.away.length}`}>
            {groups.away.map((member) => (
              <PersonRow
                key={member.userId}
                member={member}
                roleColor={topRoleColorMap.get(member.userId) || undefined}
                dimmed
                onContextMenu={handleContextMenu}
              />
            ))}
          </PeopleSection>
        )}

        {moreOnline > 0 && (
          <p className="mb-4 px-2 text-[11.5px] text-vox-text-muted" data-testid="people-more-online">
            {t('people.moreOnline', { count: moreOnline })}
          </p>
        )}

        {groups.offline.length > 0 && (
          <PeopleSection label={`${t('people.offline')} · ${groups.offline.length}`}>
            {groups.offline.map((member) => (
              <PersonRow
                key={member.userId}
                member={member}
                roleColor={topRoleColorMap.get(member.userId) || undefined}
                dimmed
                onContextMenu={handleContextMenu}
              />
            ))}
          </PeopleSection>
        )}

        {people.loaded && !people.full && (
          <PeopleSection label={`${t('people.offline')} · ${offlineHidden}`}>
            <button
              type="button"
              onClick={() => setShowDirectory(true)}
              className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[12.5px] font-medium text-vox-accent-primary transition-colors hover:bg-vox-bg-hover"
              data-testid="people-browse-all"
            >
              {t('people.browseAll')}
            </button>
          </PeopleSection>
        )}
      </div>

      {contextMenu && (
        <MemberContextMenu
          member={contextMenu.member}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}

      {showDirectory && activeServerId && (
        <MembersDialog serverId={activeServerId} onClose={() => setShowDirectory(false)} />
      )}
    </div>
  );
}

function PeopleSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="section-label px-2 pb-1.5">{label}</h3>
      {children}
    </div>
  );
}

function PersonRow({
  member,
  roleColor,
  voice,
  dimmed,
  onContextMenu,
}: {
  member: ServerMember;
  roleColor?: string;
  voice?: VoiceUser;
  dimmed?: boolean;
  onContextMenu: (e: React.MouseEvent, member: ServerMember) => void;
}) {
  const { t } = useTranslation();
  const name = member.nickname || member.user.displayName;
  const status = member.user.status || 'offline';

  // Rich presence line: voice state when in voice, otherwise status.
  let secondLine: string;
  let secondLineAccent = false;
  if (voice) {
    const kind = voicePresenceKind(voice);
    secondLine = kind === 'speaking' ? t('people.speaking') : kind === 'muted' ? t('people.mutedStatus') : t('people.inVoiceStatus');
    secondLineAccent = kind === 'speaking';
  } else if (status === 'dnd') {
    secondLine = t('people.dnd');
  } else if (status === 'idle') {
    secondLine = t('people.awayStatus');
  } else if (status === 'online') {
    secondLine = t('channel.online');
  } else {
    secondLine = t('people.offlineStatus');
  }

  return (
    <UserHoverTarget userId={member.userId}>
      <button
        className={clsx(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-all hover:bg-vox-bg-hover',
          dimmed && 'opacity-55 hover:opacity-90',
        )}
        onContextMenu={(e) => onContextMenu(e, member)}
      >
        <Avatar
          avatarUrl={member.user.avatarUrl}
          displayName={member.user.displayName}
          size="sm"
          status={voice ? undefined : status}
          speaking={voice?.speaking}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={clsx('truncate text-[13px] font-semibold leading-tight', !roleColor && 'text-vox-text-primary')}
              style={roleColor ? { color: roleColor } : undefined}
            >
              {name}
            </span>
            {(member.user.role === 'admin' || member.user.role === 'superadmin') && <StaffBadge />}
            {member.user.isSupporter && <SupporterBadge tier={member.user.supporterTier} />}
          </div>
          <div
            className={clsx(
              'truncate text-[11.5px] leading-tight',
              secondLineAccent ? 'text-vox-accent-primary' : 'text-vox-text-muted',
            )}
          >
            {secondLine}
          </div>
        </div>
        {voice && (voice.selfMute || voice.serverMuted) && (
          <MicOff size={13} className="shrink-0 text-vox-voice-muted" />
        )}
      </button>
    </UserHoverTarget>
  );
}
