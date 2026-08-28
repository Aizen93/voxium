import { describe, it, expect } from 'vitest';
import { groupPeopleByPresence, voicePresenceKind } from '../../utils/peopleGroups';
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
