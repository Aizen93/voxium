import { useServerStore } from '../../stores/serverStore';
import { clsx } from 'clsx';

export function MemberSidebar() {
  const { members } = useServerStore();

  const owners = members.filter((m) => m.role === 'owner');
  const admins = members.filter((m) => m.role === 'admin');
  const regularMembers = members.filter((m) => m.role === 'member');

  return (
    <div className="flex h-full w-60 flex-col border-l border-vox-border bg-vox-bg-secondary">
      <div className="flex-1 overflow-y-auto p-3">
        {owners.length > 0 && (
          <MemberGroup title="Owner" members={owners} />
        )}
        {admins.length > 0 && (
          <MemberGroup title={`Admins - ${admins.length}`} members={admins} />
        )}
        {regularMembers.length > 0 && (
          <MemberGroup title={`Members - ${regularMembers.length}`} members={regularMembers} />
        )}
      </div>
    </div>
  );
}

function MemberGroup({ title, members }: { title: string; members: any[] }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-vox-text-muted">
        {title}
      </h3>
      {members.map((member) => (
        <button
          key={member.userId}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-vox-bg-hover transition-colors"
        >
          {/* Avatar */}
          <div className="relative">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-vox-accent-primary text-xs font-semibold text-white">
              {member.user.displayName?.[0]?.toUpperCase() || '?'}
            </div>
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
      ))}
    </div>
  );
}
