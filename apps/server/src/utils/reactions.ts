import type { ReactionGroup } from '@voxium/shared';

export function aggregateReactions(raw: { emoji: string; userId: string }[]): ReactionGroup[] {
  const groups = new Map<string, string[]>();
  for (const r of raw) {
    const arr = groups.get(r.emoji) || [];
    arr.push(r.userId);
    groups.set(r.emoji, arr);
  }
  return Array.from(groups.entries()).map(([emoji, userIds]) => ({
    emoji, count: userIds.length, userIds,
  }));
}

export const reactionInclude = {
  select: { emoji: true, userId: true },
  orderBy: { createdAt: 'asc' as const },
};
