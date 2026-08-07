import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Occupied voice channels render as a highlighted card in the sidebar — bold
 * header with a live participant count, the people in it, and an explicit
 * "Join voice" button — instead of the quiet row an empty channel gets.
 *
 * The states worth pinning: the card only exists when someone is actually in
 * the channel, the Join button disappears once YOU are the one in it (the
 * voice panel owns leave/controls), and the speaking/muted indicators show on
 * the right people.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const { joinChannel } = vi.hoisted(() => ({ joinChannel: vi.fn() }));

type VoiceUser = {
  id: string; displayName: string; avatarUrl: string | null;
  selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean;
  speaking: boolean; screenSharing?: boolean;
};

let channels: Array<{ id: string; name: string; type: string; serverId: string; position: number; categoryId: string | null }> = [];
let channelUsers: Record<string, VoiceUser[]> = {};
let voiceActiveChannelId: string | null = null;

vi.mock('../../stores/serverStore', () => {
  const state = () => ({
    channels,
    categories: [],
    activeChannelId: null,
    setActiveChannel: vi.fn(),
    activeServerId: 'srv1',
    servers: [{ id: 'srv1', name: 'Testers' }],
    createChannel: vi.fn(),
    deleteChannel: vi.fn(),
    createCategory: vi.fn(),
    deleteCategory: vi.fn(),
    members: [],
    unreadCounts: {},
    reorderCategories: vi.fn(),
    reorderChannels: vi.fn(),
  });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
  return { useServerStore };
});

vi.mock('../../stores/voiceStore', () => {
  const state = () => ({
    joinChannel,
    activeChannelId: voiceActiveChannelId,
    channelUsers: new Map(Object.entries(channelUsers)),
  });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useVoiceStore.getState = state;
  return { useVoiceStore };
});

vi.mock('../../stores/chatStore', () => {
  const state = () => ({ clearMessages: vi.fn(), fetchMessages: vi.fn() });
  const useChatStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useChatStore.getState = state;
  return { useChatStore };
});

vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useAuthStore.getState = state;
  return { useAuthStore };
});

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Heavy children the card does not depend on.
vi.mock('../../components/voice/VoicePanel', () => ({ VoicePanel: () => null }));
vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../components/server/InviteModal', () => ({ InviteModal: () => null }));
vi.mock('../../components/server/ServerSettingsModal', () => ({ ServerSettingsModal: () => null }));
vi.mock('../../components/server/ChannelPermissionsEditor', () => ({ ChannelPermissionsEditor: () => null }));
vi.mock('../../components/server/MemberContextMenu', () => ({ MemberContextMenu: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { ChannelSidebar } from '../../components/channel/ChannelSidebar';

const voiceUser = (id: string, name: string, extra: Partial<VoiceUser> = {}): VoiceUser => ({
  id,
  displayName: name,
  avatarUrl: null,
  selfMute: false,
  selfDeaf: false,
  serverMuted: false,
  serverDeafened: false,
  speaking: false,
  screenSharing: false,
  ...extra,
});

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<ChannelSidebar />);
  });
}
const card = () => document.body.querySelector('[data-testid="voice-channel-card"]');
const joinButton = () =>
  Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === 'channel.joinVoice',
  );

beforeEach(() => {
  channels = [
    { id: 'v1', name: 'Lounge', type: 'voice', serverId: 'srv1', position: 0, categoryId: null },
  ];
  channelUsers = {
    v1: [
      voiceUser('u-mara', 'Mara Voss', { speaking: true }),
      voiceUser('u-jonas', 'Jonas Petit'),
      voiceUser('u-priya', 'Priya Anand', { selfMute: true }),
    ],
  };
  voiceActiveChannelId = null;
  joinChannel.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('occupied voice channel card', () => {
  it('renders as a card with the channel, its count, and everyone in it', () => {
    render();
    const el = card();
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('Lounge');
    expect(el!.textContent).toContain('3');
    for (const name of ['Mara Voss', 'Jonas Petit', 'Priya Anand']) {
      expect(el!.textContent).toContain(name);
    }
  });

  it('offers Join voice and joins THIS channel when clicked', () => {
    render();
    const btn = joinButton();
    expect(btn).toBeTruthy();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(joinChannel).toHaveBeenCalledWith('v1', 'srv1');
  });

  it('drops the Join button once you are in the channel', () => {
    // The voice panel owns the controls at that point — a Join button on a
    // channel you are already in would rejoin/no-op and just adds noise.
    voiceActiveChannelId = 'v1';
    channelUsers.v1.push(voiceUser('me', 'Me'));
    render();
    expect(card()).toBeTruthy();
    expect(joinButton()).toBeUndefined();
  });

  it('leaves an empty voice channel as a plain row', () => {
    channelUsers = {};
    render();
    expect(card()).toBeNull();
    expect(document.body.textContent).toContain('Lounge');
  });

  it('marks who is speaking and who is muted', () => {
    render();
    const el = card()!;
    expect(el.querySelector('.lucide-audio-lines'), 'speaking indicator').toBeTruthy();
    expect(el.querySelector('.lucide-mic-off'), 'muted indicator').toBeTruthy();
  });
});
