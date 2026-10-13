import { describe, it, expect } from 'vitest';
import { groupPeopleByPresence, headerOnlineCount, presentCount, voicePresenceKind, withOwnPresence } from '../../utils/peopleGroups';
import type { Channel, ServerMember, VoiceUser } from '@voxium/shared';

const member = (id: string, name: string, status: string, nickname: string | null = null): ServerMember =>
  ({
    userId: id,
    serverId: 's1',
    role: 'member',
    nickname,
    joinedAt: '2026-01-01T00:00:00.000Z',
    user: { id, username: name.toLowerCase(), displayName: name, avatarUrl: null, status },
  }) as ServerMember;

const vu = (id: string, extra: Partial<VoiceUser> = {}): VoiceUser => ({
  id,
  username: id,
  displayName: id,
  avatarUrl: null,
  selfMute: false,
  selfDeaf: false,
  serverMuted: false,
  serverDeafened: false,
  speaking: false,
  ...extra,
});

const voiceChannel = (id: string, name: string): Channel =>
  ({ id, name, type: 'voice', serverId: 's1', categoryId: null, position: 0, createdAt: '' }) as Channel;

describe('groupPeopleByPresence', () => {
  const members = [
    member('u1', 'Alice', 'online'),
    member('u2', 'Bob', 'online'),
    member('u3', 'Carol', 'idle'),
    member('u4', 'Dave', 'dnd'),
    member('u5', 'Erin', 'offline'),
  ];

  it('voice membership wins over status', () => {
    const groups = groupPeopleByPresence(
      members,
      [voiceChannel('vc1', 'Lounge')],
      new Map([['vc1', [vu('u1'), vu('u3')]]]),
    );
    expect(groups.voiceSections).toHaveLength(1);
    expect(groups.voiceSections[0].channelName).toBe('Lounge');
    expect(groups.voiceSections[0].entries.map((e) => e.member.userId)).toEqual(['u1', 'u3']);
    // u1 (online) and u3 (idle) must not reappear below
    expect(groups.active.map((m) => m.userId)).toEqual(['u2']);
    expect(groups.away.map((m) => m.userId)).toEqual(['u4']);
    expect(groups.offline.map((m) => m.userId)).toEqual(['u5']);
  });

  it('groups idle and dnd together as away, offline separately', () => {
    const groups = groupPeopleByPresence(members, [], new Map());
    expect(groups.active.map((m) => m.userId)).toEqual(['u1', 'u2']);
    expect(groups.away.map((m) => m.userId)).toEqual(['u3', 'u4']);
    expect(groups.offline.map((m) => m.userId)).toEqual(['u5']);
  });

  it('creates one section per populated voice channel, in channel order', () => {
    const groups = groupPeopleByPresence(
      members,
      [voiceChannel('vc1', 'Lounge'), voiceChannel('vc2', 'War room'), voiceChannel('vc3', 'Empty')],
      new Map([
        ['vc2', [vu('u2')]],
        ['vc1', [vu('u1')]],
      ]),
    );
    expect(groups.voiceSections.map((s) => s.channelName)).toEqual(['Lounge', 'War room']);
  });

  it('ignores voice users who are not members (relay ghosts) and sorts by nickname over display name', () => {
    const withNick = [member('u1', 'Alice', 'online', 'Zed'), member('u2', 'Bob', 'online')];
    const groups = groupPeopleByPresence(
      withNick,
      [voiceChannel('vc1', 'Lounge')],
      new Map([['vc1', [vu('ghost'), vu('u2'), vu('u1')]]]),
    );
    expect(groups.voiceSections[0].entries.map((e) => e.member.userId)).toEqual(['u2', 'u1']);
  });

  it('treats a missing status as offline', () => {
    const noStatus = [member('u9', 'Nostatus', undefined as unknown as string)];
    const groups = groupPeopleByPresence(noStatus, [], new Map());
    expect(groups.offline.map((m) => m.userId)).toEqual(['u9']);
  });

  it('with includeOffline false (a big server: the rows are the online slice) offline rows are left out entirely', () => {
    const groups = groupPeopleByPresence(members, [voiceChannel('vc1', 'Lounge')], new Map([['vc1', [vu('u5')]]]), { includeOffline: false });
    expect(groups.offline).toEqual([]);
    expect(groups.active.map((m) => m.userId)).toEqual(['u1', 'u2']);
    expect(groups.away.map((m) => m.userId)).toEqual(['u3', 'u4']);
    // someone in voice is present whatever their stored status says
    expect(groups.voiceSections[0].entries.map((e) => e.member.userId)).toEqual(['u5']);
    expect(presentCount(groups)).toBe(5);
  });

  it('presentCount is the rows in voice, active and away — never the offline ones', () => {
    expect(presentCount(groupPeopleByPresence(members, [], new Map()))).toBe(4);
  });
});

describe('withOwnPresence', () => {
  const rows = [member('u1', 'Alice', 'offline'), member('u2', 'Bob', 'online')];

  it('reads the viewer\'s offline row as online while connected, in a copy that leaves the other rows alone', () => {
    const next = withOwnPresence(rows, 'u1', true);
    expect(next).not.toBe(rows);
    expect(next[0].user.status).toBe('online');
    expect(next[1]).toBe(rows[1]);
    expect(rows[0].user.status).toBe('offline');
  });

  it('is the same array when nothing has to change: disconnected, no viewer, the viewer absent, or already online', () => {
    expect(withOwnPresence(rows, 'u1', false)).toBe(rows);
    expect(withOwnPresence(rows, undefined, true)).toBe(rows);
    expect(withOwnPresence(rows, 'u9', true)).toBe(rows);
    expect(withOwnPresence(rows, 'u2', true)).toBe(rows);
  });
});

describe('headerOnlineCount', () => {
  const rows = [member('u1', 'Alice', 'offline'), member('u2', 'Bob', 'online'), member('u3', 'Carol', 'offline')];
  const people = (full: boolean, onlineCount: number) => ({ full, truncated: false, onlineCount, memberCount: 3, loaded: true });

  it('everyone loaded: the rows are the truth, the viewer\'s own reading online while connected', () => {
    expect(headerOnlineCount(rows, people(true, 99), 'u1', true)).toBe(2);
    expect(headerOnlineCount(rows, people(true, 99), 'u1', false)).toBe(1);
    expect(headerOnlineCount(rows, people(true, 99), undefined, true)).toBe(1);
  });

  it('the online slice of a big server: the server\'s figure, never below the rows that read online here', () => {
    expect(headerOnlineCount(rows, people(false, 640), 'u1', true)).toBe(640);
    // the slice was fetched before the connect wrote the viewer online: 0 from the server, 2 on screen
    expect(headerOnlineCount(rows, people(false, 0), 'u1', true)).toBe(2);
    expect(headerOnlineCount(rows, people(false, 0), 'u1', false)).toBe(1);
  });
});

describe('voicePresenceKind', () => {
  it('speaking wins over muted', () => {
    expect(voicePresenceKind(vu('u', { speaking: true, selfMute: true }))).toBe('speaking');
  });
  it('any mute/deafen flag reads as muted', () => {
    expect(voicePresenceKind(vu('u', { selfMute: true }))).toBe('muted');
    expect(voicePresenceKind(vu('u', { serverMuted: true }))).toBe('muted');
    expect(voicePresenceKind(vu('u', { selfDeaf: true }))).toBe('muted');
    expect(voicePresenceKind(vu('u', { serverDeafened: true }))).toBe('muted');
  });
  it('defaults to in-voice', () => {
    expect(voicePresenceKind(vu('u'))).toBe('in-voice');
  });
});
