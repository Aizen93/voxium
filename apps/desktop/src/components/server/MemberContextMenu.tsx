import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import type { ServerMember, MemberRole, VoiceUser } from '@voxium/shared';
import { Shield, ChevronRight, Mic, MicOff, Headphones, HeadphoneOff, ArrowRightLeft, Pencil } from 'lucide-react';

interface Props {
  member: ServerMember;
  position: { x: number; y: number };
  onClose: () => void;
}

export function MemberContextMenu({ member, position, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const { members, activeServerId, roles, channels } = useServerStore();
  const { channelUsers, serverMuteUser, serverDeafenUser, forceMoveUser } = useVoiceStore();
  const [confirmAction, setConfirmAction] = useState<'kick' | null>(null);
  const [showRoles, setShowRoles] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [savingRoles, setSavingRoles] = useState(false);
  const [showNicknameInput, setShowNicknameInput] = useState(false);
  const [nicknameInput, setNicknameInput] = useState(member.nickname || '');

  const currentMember = members.find((m) => m.userId === currentUser?.id);

  const isOwner = currentMember?.role === 'owner';
  const isAdmin = currentMember?.role === 'admin';
  const isSelf = member.userId === currentUser?.id;

  // Assignable roles (non-default, sorted by position descending)
  const assignableRoles = roles
    .filter((r) => !r.isDefault)
    .sort((a, b) => b.position - a.position);

  // Current member's role IDs
  const memberRoleIds = new Set(member.roles?.map((r) => r.id) || []);

  // Find if this member is in a voice channel
  let targetVoiceUser: VoiceUser | null = null;
  let targetVoiceChannelId: string | null = null;
  for (const [chId, users] of channelUsers) {
    const found = users.find((u) => u.id === member.userId);
    if (found) {
      targetVoiceUser = found;
      targetVoiceChannelId = chId;
      break;
    }
  }

  const voiceChannels = channels.filter((c) => c.type === 'voice' && c.id !== targetVoiceChannelId);
  const isTargetInVoice = !!targetVoiceUser;
  // Check if the actor is in the same voice channel as the target
  const actorVoiceChannelId = useVoiceStore.getState().activeChannelId;
  const isActorInSameChannel = isTargetInVoice && actorVoiceChannelId === targetVoiceChannelId;

  // Close on outside click or Escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const [adjustedPos, setAdjustedPos] = useState(position);
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let x = position.x;
      let y = position.y;
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
      if (x < 0) x = 8;
      if (y < 0) y = 8;
      setAdjustedPos({ x, y });
    }
  }, [position]);

  if (!currentMember || !activeServerId) return null;

  const canPromote = !isSelf && isOwner && member.role === 'member';
  const canDemote = !isSelf && isOwner && member.role === 'admin';
  const canKick = !isSelf && (isOwner || isAdmin) && outranksRole(currentMember.role, member.role);
  const canManageRoles = !isSelf && (isOwner || isAdmin) && assignableRoles.length > 0 && member.role !== 'owner';
  // Voice moderation — mute/deafen require same channel; move works cross-channel
  const canVoiceModerate = !isSelf && isActorInSameChannel && (isOwner || isAdmin) && member.role !== 'owner';
  const canMoveUser = !isSelf && isTargetInVoice && (isOwner || isAdmin) && member.role !== 'owner';
  const canManageNicknames = (isOwner || isAdmin) && member.role !== 'owner';
  const isTargetNotOwner = member.role !== 'owner';

  if (!canPromote && !canDemote && !canKick && !canManageRoles && !canVoiceModerate && !canMoveUser && !canManageNicknames && !(isSelf && isTargetNotOwner)) return null;

  async function handlePromote() {
    try {
      await useServerStore.getState().updateMemberRole(activeServerId!, member.userId, 'admin');
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to promote member' : 'Failed to promote member');
    }
  }

  async function handleDemote() {
    try {
      await useServerStore.getState().updateMemberRole(activeServerId!, member.userId, 'member');
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to demote member' : 'Failed to demote member');
    }
  }

  async function handleKick() {
    if (confirmAction !== 'kick') {
      setConfirmAction('kick');
      return;
    }
    try {
      await useServerStore.getState().kickMember(activeServerId!, member.userId);
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to kick member' : 'Failed to kick member');
    }
  }

  async function toggleRole(roleId: string) {
    setSavingRoles(true);
    try {
      const newRoleIds = memberRoleIds.has(roleId)
        ? [...memberRoleIds].filter((id) => id !== roleId)
        : [...memberRoleIds, roleId];
      await useServerStore.getState().assignMemberRoles(activeServerId!, member.userId, newRoleIds);
      toast.success('Roles updated');
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to update roles' : 'Failed to update roles');
    } finally {
      setSavingRoles(false);
    }
  }

  function handleServerMute() {
    serverMuteUser(member.userId, !targetVoiceUser?.serverMuted);
    toast.success(targetVoiceUser?.serverMuted ? 'User unmuted' : 'User muted');
  }

  function handleServerDeafen() {
    serverDeafenUser(member.userId, !targetVoiceUser?.serverDeafened);
    toast.success(targetVoiceUser?.serverDeafened ? 'User undeafened' : 'User deafened');
  }

  function handleMoveToChannel(targetChannelId: string) {
    forceMoveUser(member.userId, targetChannelId);
    toast.success('User moved');
    setShowMoveMenu(false);
    onClose();
  }

  async function handleSetNickname() {
    try {
      if (isSelf) {
        await useServerStore.getState().setNickname(activeServerId!, nicknameInput.trim() || null);
      } else {
        await useServerStore.getState().setMemberNickname(activeServerId!, member.userId, nicknameInput.trim() || null);
      }
      toast.success(nicknameInput.trim() ? 'Nickname set' : 'Nickname cleared');
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to set nickname' : 'Failed to set nickname');
    }
  }

  async function handleClearNickname() {
    try {
      if (isSelf) {
        await useServerStore.getState().setNickname(activeServerId!, null);
      } else {
        await useServerStore.getState().setMemberNickname(activeServerId!, member.userId, null);
      }
      toast.success('Nickname cleared');
      setNicknameInput('');
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to clear nickname' : 'Failed to clear nickname');
    }
  }

  return <>{createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-52 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      <div className="px-2 py-1.5 text-xs font-semibold text-vox-text-muted uppercase tracking-wide">
        {member.nickname || member.user.displayName}
      </div>

      {/* Role assignment submenu */}
      {canManageRoles && (
        <div>
          <button
            onClick={() => { setShowRoles(!showRoles); setShowMoveMenu(false); }}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-vox-accent-primary" />
              Roles
            </div>
            <ChevronRight size={14} className={`text-vox-text-muted transition-transform ${showRoles ? 'rotate-180' : ''}`} />
          </button>
        </div>
      )}

      {/* Voice moderation section */}
      {canVoiceModerate && (
        <>
          <div className="my-1 border-t border-vox-border" />
          <div className="px-2 py-1 text-[10px] font-semibold text-vox-text-muted uppercase tracking-wider">
            Voice
          </div>

          {/* Server Mute */}
          <button
            onClick={handleServerMute}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            {targetVoiceUser?.serverMuted ? (
              <>
                <Mic size={16} className="text-vox-accent-success" />
                Unmute (Server)
              </>
            ) : (
              <>
                <MicOff size={16} className="text-vox-accent-danger" />
                Mute (Server)
              </>
            )}
          </button>

          {/* Server Deafen */}
          <button
            onClick={handleServerDeafen}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            {targetVoiceUser?.serverDeafened ? (
              <>
                <Headphones size={16} className="text-vox-accent-success" />
                Undeafen (Server)
              </>
            ) : (
              <>
                <HeadphoneOff size={16} className="text-vox-accent-danger" />
                Deafen (Server)
              </>
            )}
          </button>

        </>
      )}

      {/* Move to Channel — separate from mute/deafen, works cross-channel */}
      {canMoveUser && voiceChannels.length > 0 && (
        <>
          {!canVoiceModerate && <div className="my-1 border-t border-vox-border" />}
          <div>
            <button
              onClick={() => { setShowMoveMenu(!showMoveMenu); setShowRoles(false); }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            >
              <div className="flex items-center gap-2">
                <ArrowRightLeft size={16} className="text-vox-text-secondary" />
                Move to Channel
              </div>
              <ChevronRight size={14} className={`text-vox-text-muted transition-transform ${showMoveMenu ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </>
      )}

      {/* Nickname management — admins/owners can set for others; any user can set their own */}
      {((canManageNicknames && isTargetNotOwner) || (isSelf && isTargetNotOwner)) && (
        <>
          <div className="my-1 border-t border-vox-border" />
          <button
            onClick={() => setShowNicknameInput(!showNicknameInput)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <Pencil size={16} className="text-vox-text-secondary" />
            {isSelf ? 'Edit Nickname' : 'Set Nickname'}
          </button>
          {showNicknameInput && (
            <div className="px-2 pb-1">
              <input
                type="text"
                value={nicknameInput}
                onChange={(e) => setNicknameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSetNickname(); }}
                placeholder="Enter nickname..."
                className="w-full rounded border border-vox-border bg-vox-bg-secondary px-2 py-1 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
                autoFocus
              />
              <div className="flex gap-1 mt-1">
                <button
                  onClick={handleSetNickname}
                  className="flex-1 rounded px-2 py-1 text-xs font-medium bg-vox-accent-primary text-white hover:bg-vox-accent-primary/80 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={handleClearNickname}
                  className="flex-1 rounded px-2 py-1 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {canPromote && (
        <button
          onClick={handlePromote}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
        >
          <svg className="h-4 w-4 text-vox-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Promote to Admin
        </button>
      )}

      {canDemote && (
        <button
          onClick={handleDemote}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
        >
          <svg className="h-4 w-4 text-vox-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          Demote to Member
        </button>
      )}

      {canKick && (
        <>
          <div className="my-1 border-t border-vox-border" />
          <button
            onClick={handleKick}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6" />
            </svg>
            {confirmAction === 'kick' ? 'Click again to confirm' : 'Kick'}
          </button>
        </>
      )}

    </div>,
    document.body
  )}

  {/* ─── Portaled submenus (to the left of the main menu) ───────────── */}
  {(showRoles || showMoveMenu) && menuRef.current && createPortal(
    <div
      className="fixed z-[10000] min-w-44 max-w-56 max-h-64 overflow-y-auto rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
      style={(() => {
        const rect = menuRef.current!.getBoundingClientRect();
        const panelWidth = 220;
        // Position to the left; if not enough space, go right
        let x = rect.left - panelWidth - 4;
        if (x < 8) x = rect.right + 4;
        let y = rect.top;
        // Clamp to viewport
        if (y + 256 > window.innerHeight) y = window.innerHeight - 264;
        if (y < 8) y = 8;
        return { left: x, top: y };
      })()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {showRoles && (
        <>
          <div className="px-2 py-1 text-[10px] font-semibold text-vox-text-muted uppercase tracking-wider">
            Assign Roles
          </div>
          {assignableRoles.map((role) => (
            <button
              key={role.id}
              onClick={() => toggleRole(role.id)}
              disabled={savingRoles}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
            >
              <div
                className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${
                  memberRoleIds.has(role.id)
                    ? 'bg-vox-accent-primary border-vox-accent-primary'
                    : 'border-vox-text-muted'
                }`}
              >
                {memberRoleIds.has(role.id) && (
                  <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span
                className="truncate"
                style={role.color ? { color: role.color } : undefined}
              >
                {role.name}
              </span>
            </button>
          ))}
          {assignableRoles.length === 0 && (
            <p className="px-2 py-1 text-xs text-vox-text-muted">No roles created</p>
          )}
        </>
      )}
      {showMoveMenu && (
        <>
          <div className="px-2 py-1 text-[10px] font-semibold text-vox-text-muted uppercase tracking-wider">
            Move to Channel
          </div>
          {voiceChannels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => handleMoveToChannel(ch.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            >
              <svg className="h-3.5 w-3.5 text-vox-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M12 6v12m0 0l-3-3m3 3l3-3" />
              </svg>
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
        </>
      )}
    </div>,
    document.body
  )}
  </>;
}


function outranksRole(actor: MemberRole, target: MemberRole): boolean {
  const levels: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };
  return levels[actor] > levels[target];
}
