import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MicOff } from 'lucide-react';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { MemberContextMenu } from './MemberContextMenu';
import { clsx } from 'clsx';
import type { ServerMember, VoiceUser } from '@voxium/shared';
import { StaffBadge } from '../common/StaffBadge';
import { SupporterBadge } from '../common/SupporterBadge';
import { groupPeopleByPresence, voicePresenceKind } from '../../utils/peopleGroups';

interface ContextMenuState {
  member: ServerMember;
  position: { x: number; y: number };
}

/**
 * The People panel (2026 redesign): presence-first sections — who is in voice,
 * who is active, who is away — instead of role sections. Role identity stays
 * on the rows themselves (name colors, badges); the section axis is what
 * people are doing right now.
 */
export function MemberSidebar() {
  const { t } = useTranslation();
  const { members, roles, channels } = useServerStore();
  const channelUsers = useVoiceStore((s) => s.channelUsers);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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
    () => groupPeopleByPresence(members, channels, channelUsers),
    [members, channels, channelUsers],
  );

  function handleContextMenu(e: React.MouseEvent, member: ServerMember) {
    e.preventDefault();
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } });
  }

  const online = members.length - groups.offline.length;

  return (
    <div className="panel flex h-full w-[272px] flex-none flex-col bg-vox-bg-secondary">
      {/* Header */}
      <div className="flex h-[54px] flex-none items-center gap-2 border-b border-vox-border px-4">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-vox-text-primary">{t('people.title')}</span>
        <span className="font-mono text-[11px] text-vox-text-muted">{online}</span>
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
      </div>

      {contextMenu && (
        <MemberContextMenu
          member={contextMenu.member}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
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
