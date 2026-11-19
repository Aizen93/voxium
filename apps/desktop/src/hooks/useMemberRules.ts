import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useServerPermissions } from './useServerPermissions';
import { buildModerationContext, memberRules, type MemberRules, type ModerationContext } from '../utils/memberActions';

export interface MemberRulesView {
  rules: MemberRules;
  ctx: ModerationContext;
  /** The viewer is the space's owner (Server.ownerId). */
  isOwner: boolean;
}

/**
 * What the viewer may do to other members of `serverId`, from their
 * effective permission bits and the role order (utils/memberActions): the
 * real rules, recomputed from the roles in the store, so a role edit that
 * grants a bit changes the answer without any role being reassigned.
 * Null until there is a signed-in viewer who is a member.
 */
export function useMemberRules(serverId: string | null | undefined): MemberRulesView | null {
  const userId = useAuthStore((s) => s.user?.id);
  const bits = useServerPermissions(serverId, userId);
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const ownerId = useServerStore((s) => s.servers.find((sv) => sv.id === serverId)?.ownerId);

  return useMemo(() => {
    if (!userId) return null;
    const actor = members.find((m) => m.userId === userId);
    if (!actor) return null;
    const ctx = buildModerationContext({ actorId: userId, actor, ownerId, bits, roles });
    return { rules: memberRules(ctx), ctx, isOwner: !!ownerId && ownerId === userId };
  }, [userId, members, roles, ownerId, bits]);
}
