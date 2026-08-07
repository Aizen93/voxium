import type { Channel, ServerMember, VoiceUser } from '@voxium/shared';

/**
 * Presence-first grouping for the People panel (2026 redesign):
 *   In voice (one section per voice channel) → Active → Away/DND → Offline.
 *
 * Role identity is preserved through name colors and badges, not sections —
 * the section axis is what people are DOING right now.
 *
 * Pure and React-free so it is unit-testable.
 */

export interface VoiceSection {
  channelId: string;
  channelName: string;
  entries: { member: ServerMember; voice: VoiceUser }[];
}

export interface PeopleGroups {
  voiceSections: VoiceSection[];
  active: ServerMember[];
  away: ServerMember[];
  offline: ServerMember[];
}

const byName = (a: ServerMember, b: ServerMember) =>
  (a.nickname || a.user.displayName).localeCompare(b.nickname || b.user.displayName);

export function groupPeopleByPresence(
  members: ServerMember[],
  channels: Channel[],
  channelUsers: Map<string, VoiceUser[]>,
): PeopleGroups {
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const inVoiceIds = new Set<string>();

  // One section per voice channel that has participants, in channel order.
  const voiceSections: VoiceSection[] = [];
  for (const ch of channels) {
    if (ch.type !== 'voice') continue;
    const users = channelUsers.get(ch.id) || [];
    if (!users.length) continue;
    const entries = users
      .map((vu) => {
        const member = memberById.get(vu.id);
        return member ? { member, voice: vu } : null;
      })
      .filter((e): e is { member: ServerMember; voice: VoiceUser } => e !== null)
      .sort((a, b) => byName(a.member, b.member));
    if (!entries.length) continue;
    entries.forEach((e) => inVoiceIds.add(e.member.userId));
    voiceSections.push({ channelId: ch.id, channelName: ch.name, entries });
  }

  const active: ServerMember[] = [];
  const away: ServerMember[] = [];
  const offline: ServerMember[] = [];
  for (const m of members) {
    if (inVoiceIds.has(m.userId)) continue;
    const status = m.user.status || 'offline';
    if (status === 'online') active.push(m);
    else if (status === 'idle' || status === 'dnd') away.push(m);
    else offline.push(m);
  }
  active.sort(byName);
  away.sort(byName);
  offline.sort(byName);

  return { voiceSections, active, away, offline };
}

/** The rich presence line under a voice participant's name. */
export function voicePresenceKind(vu: VoiceUser): 'speaking' | 'muted' | 'in-voice' {
  if (vu.speaking) return 'speaking';
  if (vu.selfMute || vu.serverMuted || vu.selfDeaf || vu.serverDeafened) return 'muted';
  return 'in-voice';
}
