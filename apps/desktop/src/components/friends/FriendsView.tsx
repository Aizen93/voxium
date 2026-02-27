import { useEffect } from 'react';
import { useFriendStore } from '../../stores/friendStore';
import { FriendListItem } from './FriendListItem';
import { AddFriendForm } from './AddFriendForm';
import { Users } from 'lucide-react';
import { clsx } from 'clsx';

const TABS = [
  { key: 'online' as const, label: 'Online' },
  { key: 'all' as const, label: 'All' },
  { key: 'pending' as const, label: 'Pending' },
  { key: 'add' as const, label: 'Add Friend' },
];

export function FriendsView() {
  const { friends, pendingIncoming, pendingOutgoing, activeTab, setActiveTab, fetchFriends } = useFriendStore();

  useEffect(() => {
    fetchFriends();
  }, [fetchFriends]);

  const onlineFriends = friends.filter((f) => f.user.status !== 'offline');

  return (
    <div className="flex h-full flex-col bg-vox-bg-primary">
      {/* Header */}
      <div className="flex h-12 items-center gap-4 border-b border-vox-border px-4 shadow-sm shrink-0">
        <div className="flex items-center gap-2 text-vox-text-primary">
          <Users size={16} />
          <span className="text-sm font-semibold">Friends</span>
        </div>
        <div className="h-5 w-px bg-vox-border" />
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                'relative rounded px-2.5 py-1 text-xs font-medium transition-colors',
                tab.key === 'add'
                  ? activeTab === 'add'
                    ? 'bg-transparent text-vox-accent-success'
                    : 'bg-vox-accent-success/10 text-vox-accent-success hover:bg-vox-accent-success/20'
                  : activeTab === tab.key
                    ? 'bg-vox-bg-active text-vox-text-primary'
                    : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
              )}
            >
              {tab.label}
              {tab.key === 'pending' && pendingIncoming.length > 0 && (
                <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-vox-accent-danger px-1 text-[10px] font-bold text-white">
                  {pendingIncoming.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'add' && <AddFriendForm />}

        {activeTab === 'online' && (
          <div className="p-3">
            <h4 className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wide text-vox-text-muted">
              Online — {onlineFriends.length}
            </h4>
            {onlineFriends.length === 0 ? (
              <EmptyState message="No friends are online right now." />
            ) : (
              onlineFriends.map((f) => (
                <FriendListItem key={f.id} friendship={f} variant="accepted" />
              ))
            )}
          </div>
        )}

        {activeTab === 'all' && (
          <div className="p-3">
            <h4 className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wide text-vox-text-muted">
              All Friends — {friends.length}
            </h4>
            {friends.length === 0 ? (
              <EmptyState message="You don't have any friends yet. Try sending a friend request!" />
            ) : (
              friends.map((f) => (
                <FriendListItem key={f.id} friendship={f} variant="accepted" />
              ))
            )}
          </div>
        )}

        {activeTab === 'pending' && (
          <div className="p-3 space-y-4">
            {pendingIncoming.length > 0 && (
              <div>
                <h4 className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wide text-vox-text-muted">
                  Incoming — {pendingIncoming.length}
                </h4>
                {pendingIncoming.map((f) => (
                  <FriendListItem key={f.id} friendship={f} variant="incoming" />
                ))}
              </div>
            )}
            {pendingOutgoing.length > 0 && (
              <div>
                <h4 className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wide text-vox-text-muted">
                  Outgoing — {pendingOutgoing.length}
                </h4>
                {pendingOutgoing.map((f) => (
                  <FriendListItem key={f.id} friendship={f} variant="outgoing" />
                ))}
              </div>
            )}
            {pendingIncoming.length === 0 && pendingOutgoing.length === 0 && (
              <EmptyState message="No pending friend requests." />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <Users size={32} className="text-vox-text-muted" />
      <p className="text-sm text-vox-text-muted">{message}</p>
    </div>
  );
}
