import { useEffect } from 'react';
import { useServerStore } from '../stores/serverStore';
import type { ServerMember } from '@voxium/shared';

/**
 * The active server's row for a user, fetched when the client has none.
 *
 * The People panel's slice is not the whole membership on a big server
 * (CLAUDE.md "Server Membership"), so a message author, a voice participant
 * or a profile popup can name someone with no row here. The lookup is
 * batched and remembers misses; while it is in flight — or when the user
 * turns out not to be a member — this is undefined, and the caller falls
 * back to what it has (the author on the message, the voice entry).
 */
export function useMember(userId: string | undefined): ServerMember | undefined {
  // `.find` returns the same row object while nothing about it changed, so
  // the selector never hands React a fresh reference
  const member = useServerStore((s) => (userId ? s.members.find((m) => m.userId === userId) : undefined));
  const activeServerId = useServerStore((s) => s.activeServerId);
  useEffect(() => {
    if (userId && !member && activeServerId) useServerStore.getState().ensureMembers([userId]);
  }, [userId, member, activeServerId]);
  return member;
}
