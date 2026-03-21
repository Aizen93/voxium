import { useState, useMemo } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { MemberContextMenu } from './MemberContextMenu';
import { clsx } from 'clsx';
import type { ServerMember } from '@voxium/shared';
import { StaffBadge } from '../common/StaffBadge';
import { SupporterBadge } from '../common/SupporterBadge';

interface ContextMenuState {
  member: ServerMember;
  position: { x: number; y: number };
}

interface MemberGroup {
  key: string;
  title: string;
  color: string | null;
  members: ServerMember[];
}

export function MemberSidebar() {
  const { members, roles } = useServerStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Group members by their highest custom role, with fallback groups
  const groups = useMemo(() => {
    const sortedRoles = [...roles]
      .filter((r) => !r.isDefault)
      .sort((a, b) => b.position - a.position);

    const result: MemberGroup[] = [];
    const assigned = new Set<string>();

    // Owner group first
    const owners = members.filter((m) => m.role === 'owner');
    if (owners.length > 0) {
      result.push({ key: '_owner', title: 'Owner', color: null, members: owners });
      owners.forEach((m) => assigned.add(m.userId));
    }

    // Admin group (legacy role = 'admin', shown before custom roles)
    const admins = members.filter((m) => !assigned.has(m.userId) && m.role === 'admin');
    if (admins.length > 0) {
      result.push({ key: '_admin', title: `Admins - ${admins.length}`, color: null, members: admins });
      admins.forEach((m) => assigned.add(m.userId));
    }

    // Groups by custom role (highest position first)
    for (const role of sortedRoles) {
      const roleMembers = members.filter(
        (m) => !assigned.has(m.userId) && m.roles?.some((r) => r.id === role.id)
      );
      if (roleMembers.length > 0) {
        result.push({
          key: role.id,
          title: `${role.name} - ${roleMembers.length}`,
          color: role.color,
          members: roleMembers,
        });
        roleMembers.forEach((m) => assigned.add(m.userId));
      }
    }

    // Online members without custom roles
    const onlineNoRole = members.filter(
      (m) => !assigned.has(m.userId) && m.user.status !== 'offline'
    );
    if (onlineNoRole.length > 0) {
      result.push({
        key: '_online',
        title: `Online - ${onlineNoRole.length}`,
        color: null,
        members: onlineNoRole,
      });
      onlineNoRole.forEach((m) => assigned.add(m.userId));
    }

    // Offline members
    const offline = members.filter((m) => !assigned.has(m.userId));
    if (offline.length > 0) {
      result.push({
        key: '_offline',
        title: `Offline - ${offline.length}`,
        color: null,
        members: offline,
      });
    }

    return result;
  }, [members, roles]);

  function handleContextMenu(e: React.MouseEvent, member: ServerMember) {
    e.preventDefault();
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } });
  }

  return (
    <div className="flex h-full w-60 flex-col border-l border-vox-border bg-vox-bg-secondary">
      <div className="flex-1 overflow-y-auto p-3">
        {groups.map((group) => (
          <MemberGroupSection
            key={group.key}
            title={group.title}
            color={group.color}
            members={group.members}
            onContextMenu={handleContextMenu}
          />
        ))}
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

function MemberGroupSection({
  title,
  color,
  members,
  onContextMenu,
}: {
  title: string;
  color: string | null;
  members: ServerMember[];
  onContextMenu: (e: React.MouseEvent, member: ServerMember) => void;
}) {
  return (
    <div className="mb-4">
      <h3
        className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide"
        style={color ? { color } : undefined}
      >
        <span className={color ? undefined : 'text-vox-text-muted'}>{title}</span>
      </h3>
      {members.map((member) => (
        <UserHoverTarget key={member.userId} userId={member.userId}>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-vox-bg-hover transition-colors"
            onContextMenu={(e) => onContextMenu(e, member)}
          >
            {/* Avatar */}
            <div className="relative">
              <Avatar avatarUrl={member.user.avatarUrl} displayName={member.user.displayName} size="sm" />
              <div
                className={clsx(
                  'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-vox-bg-secondary',
                  member.user.status === 'online' ? 'bg-vox-accent-success' :
                  member.user.status === 'idle' ? 'bg-vox-accent-warning' :
                  member.user.status === 'dnd' ? 'bg-vox-accent-danger' :
                  'bg-vox-text-muted'
                )}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <p
                  className={clsx(
                    'truncate text-sm font-medium',
                    member.user.status === 'offline' ? 'text-vox-text-muted' : 'text-vox-text-primary'
                  )}
                  style={
                    member.roles?.length
                      ? { color: [...member.roles].sort((a, b) => b.position - a.position)[0]?.color || undefined }
                      : undefined
                  }
                >
                  {member.nickname || member.user.displayName}
                </p>
                {(member.user.role === 'admin' || member.user.role === 'superadmin') && <StaffBadge />}
              </div>
              {member.user.isSupporter && <SupporterBadge tier={member.user.supporterTier} />}
            </div>
          </button>
        </UserHoverTarget>
      ))}
    </div>
  );
}
