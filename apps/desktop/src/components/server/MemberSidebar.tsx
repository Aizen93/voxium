import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { MemberContextMenu } from './MemberContextMenu';
import { clsx } from 'clsx';
import type { ServerMember } from '@voxium/shared';

interface ContextMenuState {
  member: ServerMember;
  position: { x: number; y: number };
}

export function MemberSidebar() {
  const { members } = useServerStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const owners = members.filter((m) => m.role === 'owner');
  const admins = members.filter((m) => m.role === 'admin');
  const regularMembers = members.filter((m) => m.role === 'member');

  function handleContextMenu(e: React.MouseEvent, member: ServerMember) {
    e.preventDefault();
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } });
  }

  return (
    <div className="flex h-full w-60 flex-col border-l border-vox-border bg-vox-bg-secondary">
      <div className="flex-1 overflow-y-auto p-3">
        {owners.length > 0 && (
          <MemberGroup title="Owner" members={owners} onContextMenu={handleContextMenu} />
        )}
        {admins.length > 0 && (
          <MemberGroup title={`Admins - ${admins.length}`} members={admins} onContextMenu={handleContextMenu} />
        )}
        {regularMembers.length > 0 && (
          <MemberGroup title={`Members - ${regularMembers.length}`} members={regularMembers} onContextMenu={handleContextMenu} />
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

function MemberGroup({ title, members, onContextMenu }: { title: string; members: ServerMember[]; onContextMenu: (e: React.MouseEvent, member: ServerMember) => void }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-vox-text-muted">
        {title}
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
              <p className={clsx(
                'truncate text-sm font-medium',
                member.user.status === 'offline' ? 'text-vox-text-muted' : 'text-vox-text-primary'
              )}>
                {member.user.displayName}
              </p>
            </div>
          </button>
        </UserHoverTarget>
      ))}
    </div>
  );
}
