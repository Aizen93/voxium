import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { Hash, Volume2, Plus, ChevronDown, Mic, MicOff, Headphones, HeadphoneOff, UserPlus, Trash2 } from 'lucide-react';
import { InviteModal } from '../server/InviteModal';
import { ServerSettingsModal } from '../server/ServerSettingsModal';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { toast } from '../../stores/toastStore';
import { clsx } from 'clsx';

export function ChannelSidebar() {
  const { channels, activeChannelId, setActiveChannel, activeServerId, servers, createChannel, deleteChannel, members, unreadCounts } = useServerStore();
  const { joinChannel, activeChannelId: voiceChannelId, channelUsers, selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoiceStore();
  const { clearMessages, fetchMessages } = useChatStore();
  const { user } = useAuthStore();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text');

  const activeServer = servers.find((s) => s.id === activeServerId);
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  const handleSelectTextChannel = (channelId: string) => {
    setActiveChannel(channelId);
    clearMessages();
    fetchMessages(channelId);
  };

  const handleJoinVoice = (channelId: string) => {
    joinChannel(channelId);
  };

  const handleCreateChannel = async () => {
    if (!activeServerId || !newChannelName.trim()) return;
    try {
      await createChannel(activeServerId, newChannelName.trim(), newChannelType);
      toast.success('Channel created');
      setNewChannelName('');
      setShowCreateChannel(false);
    } catch {
      toast.error('Failed to create channel');
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    if (!activeServerId) return;
    try {
      await deleteChannel(activeServerId, channelId);
      toast.success('Channel deleted');
    } catch {
      toast.error('Failed to delete channel');
    }
  };

  return (
    <div className="flex h-full w-60 flex-col bg-vox-channel">
      {/* Server name header */}
      <div className="flex h-12 items-center justify-between border-b border-vox-border px-4 shadow-sm">
        <h2 className="truncate text-sm font-semibold text-vox-text-primary">
          {activeServer?.name || 'Server'}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowInviteModal(true)}
            className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title="Invite People"
          >
            <UserPlus size={16} />
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowServerSettings(true)}
              className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
              title="Server Settings"
            >
              <ChevronDown size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Channels list */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* Text Channels */}
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-vox-text-muted">
              Text Channels
            </span>
            {isAdmin && (
              <button
                onClick={() => { setShowCreateChannel(true); setNewChannelType('text'); }}
                className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
              >
                <Plus size={14} />
              </button>
            )}
          </div>

          {textChannels.map((channel) => {
            const unread = activeChannelId !== channel.id ? (unreadCounts[channel.id] || 0) : 0;
            return (
              <div
                key={channel.id}
                className={clsx(
                  'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  activeChannelId === channel.id
                    ? 'bg-vox-bg-active text-vox-text-primary font-medium'
                    : unread > 0
                      ? 'text-vox-text-primary font-semibold hover:bg-vox-bg-hover'
                      : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
                )}
              >
                <button
                  onClick={() => handleSelectTextChannel(channel.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                >
                  <Hash size={16} className="shrink-0 opacity-60" />
                  <span className="truncate">{channel.name}</span>
                </button>
                {unread > 0 && (
                  <span className="bg-vox-accent-primary text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shrink-0">
                    {unread}
                  </span>
                )}
                {isAdmin && (
                  <button
                    onClick={() => handleDeleteChannel(channel.id)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-vox-text-muted hover:text-vox-accent-danger transition-all"
                    title="Delete channel"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Voice Channels */}
        <div>
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-vox-text-muted">
              Voice Channels
            </span>
            {isAdmin && (
              <button
                onClick={() => { setShowCreateChannel(true); setNewChannelType('voice'); }}
                className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
              >
                <Plus size={14} />
              </button>
            )}
          </div>

          {voiceChannels.map((channel) => {
            const usersInChannel = channelUsers.get(channel.id) || [];

            return (
              <div key={channel.id}>
                <div
                  className={clsx(
                    'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                    voiceChannelId === channel.id
                      ? 'bg-vox-bg-active text-vox-voice-connected font-medium'
                      : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
                  )}
                >
                  <button
                    onClick={() => handleJoinVoice(channel.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                  >
                    <Volume2 size={16} className="shrink-0 opacity-60" />
                    <span className="truncate">{channel.name}</span>
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => handleDeleteChannel(channel.id)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-vox-text-muted hover:text-vox-accent-danger transition-all"
                      title="Delete channel"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {/* Show ALL connected voice users (visible to everyone) */}
                {usersInChannel.length > 0 && (
                  <div className="ml-4 mt-0.5 space-y-0.5">
                    {usersInChannel.map((vu) => (
                      <UserHoverTarget key={vu.id} userId={vu.id}>
                        <div className="flex items-center gap-1.5 rounded px-2 py-1">
                          <Avatar
                            avatarUrl={vu.avatarUrl}
                            displayName={vu.displayName}
                            size="xs"
                            speaking={vu.speaking}
                          />
                          <span className={clsx(
                            'text-xs truncate',
                            vu.id === user?.id ? 'text-vox-text-primary font-medium' : 'text-vox-text-secondary'
                          )}>
                            {vu.displayName}
                            {vu.id === user?.id && ' (you)'}
                          </span>
                          {vu.selfMute && <MicOff size={10} className="text-vox-voice-muted shrink-0" />}
                        </div>
                      </UserHoverTarget>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Create Channel Inline */}
        {showCreateChannel && (
          <div className="mt-2 rounded-lg border border-vox-border bg-vox-bg-floating p-3">
            <input
              type="text"
              className="input mb-2 text-sm"
              placeholder={`New ${newChannelType} channel`}
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={handleCreateChannel} className="btn-primary flex-1 py-1 text-xs">
                Create
              </button>
              <button onClick={() => setShowCreateChannel(false)} className="btn-ghost flex-1 py-1 text-xs">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* User area at bottom */}
      <div className="flex items-center gap-2 border-t border-vox-border bg-vox-sidebar px-2 py-2">
        <Avatar avatarUrl={user?.avatarUrl} displayName={user?.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-vox-text-primary">{user?.displayName || 'User'}</p>
          <p className="truncate text-[10px] text-vox-text-muted">Online</p>
        </div>
        <button
          onClick={toggleMute}
          className={clsx(
            'rounded p-1 transition-colors',
            selfMute
              ? 'text-vox-accent-danger hover:bg-vox-accent-danger/20'
              : 'text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover'
          )}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff size={14} /> : <Mic size={14} />}
        </button>
        <button
          onClick={toggleDeaf}
          className={clsx(
            'rounded p-1 transition-colors',
            selfDeaf
              ? 'text-vox-accent-danger hover:bg-vox-accent-danger/20'
              : 'text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover'
          )}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff size={14} /> : <Headphones size={14} />}
        </button>
      </div>

      {showInviteModal && activeServerId && (
        <InviteModal serverId={activeServerId} onClose={() => setShowInviteModal(false)} />
      )}
      {showServerSettings && activeServerId && (
        <ServerSettingsModal serverId={activeServerId} onClose={() => setShowServerSettings(false)} />
      )}
    </div>
  );
}
