import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import type React from 'react';
import type { VoiceUser, Channel } from '@voxium/shared';

/**
 * Secure VOICE channels in the sidebar + VoicePanel (spec §21): the join is
 * hard-gated on encoded-transform support, the panel shows the E2E lock,
 * screen share is absent, and un-keyable members surface as a warning strip.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.count !== undefined ? `${k}:${o.count}` : k) }),
  };
});

const joinChannel = vi.fn();
let channels: Partial<Channel>[] = [];
let channelUsers: Record<string, VoiceUser[]> = {};
let voiceActiveChannelId: string | null = null;
let peerIssues: Record<string, string> = {};
const supported = vi.hoisted(() => ({ value: false }));

vi.mock('../../services/e2e/voiceFrameTransform', () => ({
  isSecureVoiceSupported: () => supported.value,
  createFrameCryptoSession: vi.fn(),
}));

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
    roles: [],
    unreadCounts: {},
    reorderCategories: vi.fn(),
    reorderChannels: vi.fn(),
    fetchEffectivePermissions: vi.fn().mockResolvedValue('0'),
    leaveSecureChannel: vi.fn(),
    secureChannelMembers: {},
  });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
  return { useServerStore, NO_SECURE_MEMBERS: [] };
});

vi.mock('../../stores/voiceStore', () => {
  const state = () => ({
    joinChannel,
    activeChannelId: voiceActiveChannelId,
    channelUsers: new Map(Object.entries(channelUsers)),
    selfMute: false,
    selfDeaf: false,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
    leaveChannel: vi.fn(),
    latency: 42,
    isScreenSharing: false,
    screenSharingUserId: null,
    startScreenShare: vi.fn(),
    stopScreenShare: vi.fn(),
    activeVoiceServerId: 'srv1',
    secureVoicePeerIssues: peerIssues,
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

vi.mock('../../components/voice/DMVoicePanel', () => ({ DMVoicePanel: () => null }));
vi.mock('../../components/server/InviteModal', () => ({ InviteModal: () => null }));
vi.mock('../../components/server/ServerSettingsModal', () => ({ ServerSettingsModal: () => null }));
vi.mock('../../components/server/ChannelPermissionsEditor', () => ({ ChannelPermissionsEditor: () => null }));
vi.mock('../../components/server/MemberContextMenu', () => ({ MemberContextMenu: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { ChannelSidebar } from '../../components/channel/ChannelSidebar';
import { VoicePanel } from '../../components/voice/VoicePanel';

let container: HTMLDivElement;
let root: Root;

function renderEl(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}

beforeEach(() => {
  channels = [
    { id: 'sv1', name: 'war-room', type: 'voice', serverId: 'srv1', position: 0, categoryId: null, secure: true },
  ];
  channelUsers = {};
  voiceActiveChannelId = null;
  peerIssues = {};
  supported.value = false;
  joinChannel.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('secure voice channel — sidebar', () => {
  it('renders disabled with the unsupported tooltip when transforms are unavailable', () => {
    renderEl(<ChannelSidebar />);
    const btn = document.body.querySelector('[data-testid="secure-voice-channel-war-room"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('secureVoice.unsupported');
    act(() => btn.click());
    expect(joinChannel).not.toHaveBeenCalled();
  });

  it('joins on click when supported, and lists occupants', () => {
    supported.value = true;
    channelUsers = {
      sv1: [{ id: 'u1', username: 'a', displayName: 'Ada', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false }],
    };
    renderEl(<ChannelSidebar />);
    const btn = document.body.querySelector('[data-testid="secure-voice-channel-war-room"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => btn.click());
    expect(joinChannel).toHaveBeenCalledWith('sv1', 'srv1');
    expect(document.body.textContent).toContain('Ada');
  });
});

describe('secure voice channel — VoicePanel', () => {
  beforeEach(() => {
    voiceActiveChannelId = 'sv1';
  });

  it('shows the E2E lock and hides the screen-share button', () => {
    renderEl(<VoicePanel />);
    expect(document.body.querySelector('[data-testid="secure-voice-e2e-lock"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('voice.shareScreen');
    const titles = Array.from(document.body.querySelectorAll('button')).map((b) => b.title);
    expect(titles).not.toContain('voice.shareScreen');
  });

  it('keeps the screen-share button on PLAINTEXT channels (no regression)', () => {
    channels = [{ id: 'sv1', name: 'lounge', type: 'voice', serverId: 'srv1', position: 0, categoryId: null, secure: false }];
    renderEl(<VoicePanel />);
    expect(document.body.querySelector('[data-testid="secure-voice-e2e-lock"]')).toBeNull();
    const titles = Array.from(document.body.querySelectorAll('button')).map((b) => b.title);
    expect(titles).toContain('voice.shareScreen');
  });

  it('surfaces un-keyable members as a warning strip', () => {
    peerIssues = { 'u-bad': 'binding-mismatch' };
    renderEl(<VoicePanel />);
    const strip = document.body.querySelector('[data-testid="secure-voice-issues"]');
    expect(strip).toBeTruthy();
    expect(strip!.textContent).toContain('secureVoice.peerIssues:1');
  });
});
