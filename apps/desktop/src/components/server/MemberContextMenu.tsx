import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import type { ServerMember, MemberRole } from '@voxium/shared';

interface Props {
  member: ServerMember;
  position: { x: number; y: number };
  onClose: () => void;
}

export function MemberContextMenu({ member, position, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const { members, activeServerId, servers } = useServerStore();
  const [confirmAction, setConfirmAction] = useState<'kick' | 'transfer' | null>(null);

  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const server = servers.find((s) => s.id === activeServerId);

  const isOwner = currentMember?.role === 'owner';
  const isAdmin = currentMember?.role === 'admin';
  const isSelf = member.userId === currentUser?.id;

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

  if (isSelf || !currentMember || !activeServerId) return null;

  const canPromote = isOwner && member.role === 'member';
  const canDemote = isOwner && member.role === 'admin';
  const canKick = (isOwner || isAdmin) && outranksRole(currentMember.role, member.role);
  const canTransfer = isOwner;

  if (!canPromote && !canDemote && !canKick && !canTransfer) return null;

  async function handlePromote() {
    try {
      await useServerStore.getState().updateMemberRole(activeServerId!, member.userId, 'admin');
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to promote member');
    }
  }

  async function handleDemote() {
    try {
      await useServerStore.getState().updateMemberRole(activeServerId!, member.userId, 'member');
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to demote member');
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
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to kick member');
    }
  }

  async function handleTransfer() {
    if (confirmAction !== 'transfer') {
      setConfirmAction('transfer');
      return;
    }
    try {
      await useServerStore.getState().transferOwnership(activeServerId!, member.userId);
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to transfer ownership');
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-48 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      <div className="px-2 py-1.5 text-xs font-semibold text-vox-text-muted uppercase tracking-wide">
        {member.user.displayName}
      </div>

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

      {canTransfer && (
        <>
          {!canKick && <div className="my-1 border-t border-vox-border" />}
          <button
            onClick={handleTransfer}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            {confirmAction === 'transfer' ? 'Click again to confirm' : 'Transfer Ownership'}
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

function outranksRole(actor: MemberRole, target: MemberRole): boolean {
  const levels: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };
  return levels[actor] > levels[target];
}
