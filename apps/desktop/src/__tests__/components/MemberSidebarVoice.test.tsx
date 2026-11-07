import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { Channel, ServerMember, VoiceUser } from '@voxium/shared';

/**
 * The People panel shows who is in voice and whether they are muted, never who
 * is speaking: the voice panel and the channel list show that, and on a big
 * space every speaking change would re-render and regroup the member list.
 * The voice store here is a REAL zustand store, so a speaking-only update is
 * shown not to re-render the panel at all.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const voice = vi.hoisted(() => ({ store: null as null | { setState: (s: { channelUsers: Map<string, VoiceUser[]> }) => void } }));
vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  const useVoiceStore = create<{ channelUsers: Map<string, VoiceUser[]> }>(() => ({ channelUsers: new Map() }));
  voice.store = useVoiceStore;
  return { useVoiceStore };
});

const voiceChannel = { id: 'vc1', name: 'Lounge', type: 'voice', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '' } as Channel;
const row = (id: string): ServerMember =>
  ({ userId: id, serverId: 'srv-1', role: 'member', nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id, username: id, displayName: id.toUpperCase(), avatarUrl: null, status: 'online' } } as unknown as ServerMember);
const serverState = {
  members: [row('me'), row('alice'), row('bob')],
  roles: [], channels: [voiceChannel], activeServerId: 'srv-1',
  people: { full: true, truncated: false, onlineCount: 3, memberCount: 3, loaded: true },
  ensureMembers: vi.fn(),
};
vi.mock('../../stores/serverStore', () => {
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) => (sel ? sel(serverState) : serverState);
  useServerStore.getState = () => serverState;
  return { useServerStore };
});
vi.mock('../../stores/authStore', () => {
  const state = { user: { id: 'me', username: 'me', displayName: 'ME' } };
  const useAuthStore = <T,>(sel?: (s: typeof state) => T) => (sel ? sel(state) : state);
  useAuthStore.getState = () => state;
  return { useAuthStore };
});
vi.mock('../../services/socket', () => ({
  getConnectionStatus: () => 'connected',
  onConnectionStatusChange: () => () => {},
}));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/server/MemberContextMenu', () => ({ MemberContextMenu: () => null }));
vi.mock('../../components/server/MembersDirectory', () => ({ MembersDirectory: () => null }));

// Every avatar render is recorded with the props it got: a re-render of the
// panel re-renders its rows, so the count is the re-render probe.
const avatarRenders = vi.hoisted(() => [] as { displayName: string; speaking?: boolean }[]);
vi.mock('../../components/common/Avatar', () => ({
  Avatar: (props: { displayName: string; speaking?: boolean }) => {
    avatarRenders.push({ displayName: props.displayName, speaking: props.speaking });
    return <span data-testid={`avatar-${props.displayName}`} />;
  },
}));

import { MemberSidebar } from '../../components/server/MemberSidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vu = (id: string, extra: Partial<VoiceUser> = {}): VoiceUser => ({
  id, username: id, displayName: id, avatarUrl: null,
  selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false, ...extra,
});
const setVoice = (users: VoiceUser[]) => act(() => { voice.store!.setState({ channelUsers: new Map([['vc1', users]]) }); });

let container: HTMLDivElement;
let root: Root;
const text = () => container.textContent ?? '';

beforeEach(async () => {
  avatarRenders.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setVoice([vu('alice'), vu('bob')]);
  await act(async () => { root.render(<MemberSidebar />); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('People panel: presence in voice, never who is speaking', () => {
  it('a speaking participant reads "in voice", with no speaking ring', async () => {
    setVoice([vu('alice', { speaking: true }), vu('bob')]);

    expect(text()).toContain('people.inVoice · Lounge');
    expect(text()).toContain('people.inVoiceStatus');
    expect(text()).not.toContain('people.speaking');
    expect(avatarRenders.every((r) => r.speaking === undefined)).toBe(true);
  });

  it('speaking starting and stopping does not re-render the panel', async () => {
    const rendersBefore = avatarRenders.length;
    expect(rendersBefore).toBeGreaterThan(0);

    setVoice([vu('alice', { speaking: true }), vu('bob')]);
    setVoice([vu('alice', { speaking: true }), vu('bob', { speaking: true })]);
    setVoice([vu('alice'), vu('bob')]);

    expect(avatarRenders.length).toBe(rendersBefore);
  });

  it('a mute, a join and a leave still reach it', async () => {
    setVoice([vu('alice', { selfMute: true }), vu('bob')]);
    expect(text()).toContain('people.mutedStatus');

    setVoice([vu('alice', { selfMute: true }), vu('bob'), vu('me')]);
    expect(container.querySelectorAll('[data-testid="avatar-ME"]').length).toBe(1);
    expect(text()).not.toContain('people.active');

    setVoice([vu('bob')]);
    expect(text()).not.toContain('people.mutedStatus');
    expect(text()).toContain('people.active · 2');
  });
});
