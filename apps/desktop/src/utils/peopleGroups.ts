import type { Channel, ServerMember, VoiceUser } from '@voxium/shared';
import type { PeopleState } from '../stores/serverStore';

/**
 * Presence-first grouping for the People panel (2026 redesign):
 *   In voice (one section per voice channel) → Active → Away/DND → Offline.
 *
 * Role identity is preserved through name colors and badges, not sections —
 * the section axis is what people are DOING right now.
 *
 * Pure and React-free so it is unit-testable.
 */

/**
 * What the People panel knows of a voice participant: that they are in voice,
 * and whether they are muted or deafened. Never whether they are speaking:
 * the panel shows presence, the voice panel and the channel list show who is
 * talking, and on a big space every speaking change would re-render and
 * regroup the whole member list.
 */
export type VoicePresence = Pick<VoiceUser, 'id' | 'selfMute' | 'selfDeaf' | 'serverMuted' | 'serverDeafened'>;

const toPresence = (vu: VoiceUser): VoicePresence => ({
  id: vu.id,
  selfMute: vu.selfMute,
  selfDeaf: vu.selfDeaf,
  serverMuted: vu.serverMuted,
  serverDeafened: vu.serverDeafened,
});

function samePresence(held: ReadonlyMap<string, readonly VoicePresence[]>, next: ReadonlyMap<string, readonly VoiceUser[]>): boolean {
  if (held.size !== next.size) return false;
  for (const [channelId, users] of next) {
    const known = held.get(channelId);
    if (!known || known.length !== users.length) return false;
    for (let i = 0; i < users.length; i++) {
      const a = known[i];
      const b = users[i];
      if (a.id !== b.id || a.selfMute !== b.selfMute || a.selfDeaf !== b.selfDeaf
        || a.serverMuted !== b.serverMuted || a.serverDeafened !== b.serverDeafened) return false;
    }
  }
  return true;
}

let lastPresence: { source: ReadonlyMap<string, readonly VoiceUser[]>; presence: ReadonlyMap<string, readonly VoicePresence[]> } | null = null;

/**
 * The voice store's `channelUsers` as the People panel reads it. A store
 * change that moves only `speaking` (or a field the panel never shows) hands
 * back the SAME map, so a zustand selector built on it does not re-render the
 * panel; a join, a leave or a mute flag builds a new one.
 */
export function voicePresenceOf(channelUsers: ReadonlyMap<string, readonly VoiceUser[]>): ReadonlyMap<string, readonly VoicePresence[]> {
  if (lastPresence?.source === channelUsers) return lastPresence.presence;
  const presence = lastPresence && samePresence(lastPresence.presence, channelUsers)
    ? lastPresence.presence
    : new Map(Array.from(channelUsers, ([channelId, users]) => [channelId, users.map(toPresence)] as const));
  lastPresence = { source: channelUsers, presence };
  return presence;
}

export interface VoiceSection {
  channelId: string;
  channelName: string;
  entries: { member: ServerMember; voice: VoicePresence }[];
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
  voicePresence: ReadonlyMap<string, readonly VoicePresence[]>,
  options: PeopleGroupOptions = {},
): PeopleGroups {
  const includeOffline = options.includeOffline !== false;
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const inVoiceIds = new Set<string>();

  // One section per voice channel that has participants, in channel order.
  const voiceSections: VoiceSection[] = [];
  for (const ch of channels) {
    if (ch.type !== 'voice') continue;
    const users = voicePresence.get(ch.id) || [];
    if (!users.length) continue;
    const entries = users
      .map((vu) => {
        const member = memberById.get(vu.id);
        return member ? { member, voice: vu } : null;
      })
      .filter((e): e is { member: ServerMember; voice: VoicePresence } => e !== null)
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

/**
 * The "N online" figure of the channel sidebar header. With everyone loaded
 * the rows are the truth; with the online slice of a big server it is the
 * server's figure, moved by the events since — never below the rows that
 * read online here, the viewer's own among them.
 */
export function headerOnlineCount(members: ServerMember[], people: PeopleState, selfId: string | undefined, connected: boolean): number {
  const present = withOwnPresence(members, selfId, connected).filter((m) => (m.user.status || 'offline') !== 'offline').length;
  return people.full ? present : Math.max(people.onlineCount, present);
}

/** How many of the loaded rows the panel shows as present (in voice, active or away). */
export function presentCount(groups: PeopleGroups): number {
  return groups.voiceSections.reduce((n, s) => n + s.entries.length, 0) + groups.active.length + groups.away.length;
}

/** The presence line under a voice participant's name (never "speaking": see VoicePresence). */
export function voicePresenceKind(vu: VoicePresence): 'muted' | 'in-voice' {
  if (vu.selfMute || vu.serverMuted || vu.selfDeaf || vu.serverDeafened) return 'muted';
  return 'in-voice';
}
