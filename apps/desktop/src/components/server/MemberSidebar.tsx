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

  // Group members by their highest custom role in a single O(M + R log R) pass.
  // Also precomputes each member's top role color to avoid per-render sorting.
  const { groups, topRoleColorMap } = useMemo(() => {
    const sortedRoles = [...roles]
      .filter((r) => !r.isDefault)
      .sort((a, b) => b.position - a.position);

    // Fast lookup: roleId → { position, color }
    const roleInfoMap = new Map(sortedRoles.map((r) => [r.id, { position: r.position, color: r.color }]));

    // Single pass: classify each member and compute top role color
    const buckets = new Map<string, ServerMember[]>();
    const colorMap = new Map<string, string | null>();

    for (const m of members) {
      // Compute top role once (used for both grouping and color)
      let topRoleId: string | null = null;
      let topRoleColor: string | null = null;
      let topPosition = -1;
      if (m.roles?.length) {
        for (const r of m.roles) {
          const info = roleInfoMap.get(r.id);
          if (info && info.position > topPosition) {
            topPosition = info.position;
            topRoleId = r.id;
            topRoleColor = info.color;
          }
        }
        colorMap.set(m.userId, topRoleColor);
      }

      let groupKey: string;
      if (m.role === 'owner') {
        groupKey = '_owner';
      } else if (m.role === 'admin') {
        groupKey = '_admin';
      } else {
        groupKey = topRoleId ?? (m.user.status !== 'offline' ? '_online' : '_offline');
      }

      let bucket = buckets.get(groupKey);
      if (!bucket) {
        bucket = [];
        buckets.set(groupKey, bucket);
      }
      bucket.push(m);
    }

    // Build result in display order: owner, admin, custom roles (position desc), online, offline
    const result: MemberGroup[] = [];
    const addGroup = (key: string, title: string, color: string | null) => {
      const groupMembers = buckets.get(key);
      if (groupMembers?.length) {
        result.push({ key, title, color, members: groupMembers });
      }
    };

    addGroup('_owner', 'Owner', null);
    const adminCount = buckets.get('_admin')?.length ?? 0;
    if (adminCount > 0) addGroup('_admin', `Admins - ${adminCount}`, null);

    for (const role of sortedRoles) {
      const count = buckets.get(role.id)?.length ?? 0;
      if (count > 0) addGroup(role.id, `${role.name} - ${count}`, role.color);
    }

    const onlineCount = buckets.get('_online')?.length ?? 0;
    if (onlineCount > 0) addGroup('_online', `Online - ${onlineCount}`, null);
    const offlineCount = buckets.get('_offline')?.length ?? 0;
    if (offlineCount > 0) addGroup('_offline', `Offline - ${offlineCount}`, null);

    return { groups: result, topRoleColorMap: colorMap };
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
            topRoleColorMap={topRoleColorMap}
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
  topRoleColorMap,
  onContextMenu,
}: {
  title: string;
  color: string | null;
  members: ServerMember[];
  topRoleColorMap: Map<string, string | null>;
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
      {members.map((member) => {
        const roleColor = topRoleColorMap.get(member.userId) || undefined;
        return (
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
                    style={roleColor ? { color: roleColor } : undefined}
                  >
                    {member.nickname || member.user.displayName}
                  </p>
                  {(member.user.role === 'admin' || member.user.role === 'superadmin') && <StaffBadge />}
                </div>
                {member.user.isSupporter && <SupporterBadge tier={member.user.supporterTier} />}
              </div>
            </button>
          </UserHoverTarget>
        );
      })}
    </div>
  );
}
