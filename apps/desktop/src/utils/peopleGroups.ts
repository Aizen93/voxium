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

export interface PeopleGroupOptions {
  /** False on a big server: the loaded rows are the online slice, and an
   *  offline row among them (someone who went offline since, a looked-up
   *  author) is not listed — the directory is where offline members live. */
  includeOffline?: boolean;
}

export function groupPeopleByPresence(
  members: ServerMember[],
  channels: Channel[],
  channelUsers: Map<string, VoiceUser[]>,
  options: PeopleGroupOptions = {},
): PeopleGroups {
  const includeOffline = options.includeOffline !== false;
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
    else if (includeOffline) offline.push(m);
  }
  active.sort(byName);
  away.sort(byName);
  offline.sort(byName);

  return { voiceSections, active, away, offline };
}

/**
 * The viewer's OWN presence is connection-driven (the rule UserCard follows):
 * the server marks them online when their socket connects and never echoes
 * that presence back to them, so a slice fetched in the same breath as the
 * connect can still carry their row as offline. While the socket is
 * connected, their row reads online — the same array when nothing changes.
 */
export function withOwnPresence(members: ServerMember[], selfId: string | undefined, connected: boolean): ServerMember[] {
  if (!connected || !selfId) return members;
  const i = members.findIndex((m) => m.userId === selfId);
  if (i < 0 || (members[i].user.status || 'offline') !== 'offline') return members;
  const next = members.slice();
  next[i] = { ...members[i], user: { ...members[i].user, status: 'online' } };
  return next;
}

/** How many of the loaded rows the panel shows as present (in voice, active or away). */
export function presentCount(groups: PeopleGroups): number {
  return groups.voiceSections.reduce((n, s) => n + s.entries.length, 0) + groups.active.length + groups.away.length;
}

/** The rich presence line under a voice participant's name. */
export function voicePresenceKind(vu: VoiceUser): 'speaking' | 'muted' | 'in-voice' {
  if (vu.speaking) return 'speaking';
  if (vu.selfMute || vu.serverMuted || vu.selfDeaf || vu.serverDeafened) return 'muted';
  return 'in-voice';
}
