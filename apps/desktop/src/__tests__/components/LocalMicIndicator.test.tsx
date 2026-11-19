import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * In push-to-talk mode the store's manual mute flag stays false while the key
 * is up, although the microphone is off and the server says "muted". The
 * local user's own mute controls (voice panel, user card, both DM call panels)
 * must say so: the muted icon with the "hold the key" wording while the key is
 * up in a live call, the open icon while it is held, and the manual mute still
 * apart (red). Display only: no event is sent, the flag is not touched.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const h = vi.hoisted(() => ({
  voice: {
    activeChannelId: null as string | null,
    dmCallConversationId: null as string | null,
    channelUsers: new Map<string, unknown[]>(),
    dmCallUsers: [] as unknown[],
    selfMute: false,
    selfDeaf: false,
    pttActive: false,
    latency: null,
    isScreenSharing: false,
    screenSharingUserId: null,
    secureVoicePeerIssues: {},
    secureVoiceActive: false,
    activeVoiceServerId: null,
    dmCallPeerDevice: null,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
    leaveChannel: vi.fn(),
    leaveDMCall: vi.fn(),
    startScreenShare: vi.fn(),
    startWhiteboardShare: vi.fn(),
    stopScreenShare: vi.fn(),
  },
  settings: { voiceMode: 'voice_activity' as string, openSettings: vi.fn() },
}));

vi.mock('../../stores/voiceStore', () => {
  const useVoiceStore = <T,>(sel?: (s: typeof h.voice) => T) => (sel ? sel(h.voice) : h.voice);
  useVoiceStore.getState = () => h.voice;
  return { useVoiceStore };
});
vi.mock('../../stores/settingsStore', () => {
  const useSettingsStore = <T,>(sel?: (s: typeof h.settings) => T) => (sel ? sel(h.settings) : h.settings);
  useSettingsStore.getState = () => h.settings;
  return { useSettingsStore };
});
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', displayName: 'Me', avatarUrl: null, status: 'online' }, logout: vi.fn() });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../stores/serverStore', () => {
  const s = { activeServerId: null, members: [], channels: [], servers: [], setNickname: vi.fn() };
  const useServerStore = <T,>(sel?: (st: typeof s) => T) => (sel ? sel(s) : s);
  useServerStore.getState = () => s;
  return { useServerStore };
});
vi.mock('../../stores/dmStore', () => {
  const s = { conversations: [{ id: 'conv-1', participant: { id: 'peer', displayName: 'Peer' } }], setActiveConversation: vi.fn() };
  const useDMStore = <T,>(sel?: (st: typeof s) => T) => (sel ? sel(s) : s);
  return { useDMStore };
});
vi.mock('../../stores/annotationStore', () => ({ useAnnotationStore: { getState: () => ({ setIsEditing: vi.fn() }) } }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useConnectionStatus', () => ({ useConnectionStatus: () => 'connected' }));
// The user card also asks for the viewer's permissions (its nickname editor): not what these tests look at
vi.mock('../../hooks/useServerPermissions', () => ({ useServerPermissions: () => null }));
vi.mock('../../hooks/useLocalSpeaking', () => ({ useLocalSpeaking: () => false }));
vi.mock('../../services/audioAnalyser', () => ({ getAudioLevel: () => 0 }));
vi.mock('../../utils/serverErrors', () => ({ getTranslatedError: () => 'err' }));
vi.mock('../../components/voice/ConnectionQuality', () => ({ ConnectionQuality: () => null }));
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <div /> }));

import { VoicePanel } from '../../components/voice/VoicePanel';
import { UserCard } from '../../components/layout/UserCard';
import { DMCallPanel } from '../../components/dm/DMCallPanel';
import { DMVoicePanel } from '../../components/voice/DMVoicePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function show(node: ReactNode) {
  act(() => { root.render(node); });
}

/** The mute control: the button whose label is one of the mute wordings. */
function muteButton() {
  const labels = ['voice.mute', 'voice.unmute', 'settings.audio.holdToTransmit'];
  const found = Array.from(container.querySelectorAll('button')).find((b) => labels.includes(b.getAttribute('aria-label') ?? ''));
  if (!found) throw new Error('mute button not found');
  return found;
}
const hasMutedIcon = (b: HTMLElement) => b.querySelector('.lucide-mic-off') !== null;
const hasOpenIcon = (b: HTMLElement) => b.querySelector('.lucide-mic') !== null;
const isRed = (b: HTMLElement) => b.className.includes('text-vox-accent-danger');

type Scene = { name: string; node: () => ReactNode; join: () => void };
const scenes: Scene[] = [
  { name: 'VoicePanel', node: () => <VoicePanel />, join: () => { h.voice.activeChannelId = 'ch-1'; } },
  { name: 'UserCard', node: () => <UserCard />, join: () => { h.voice.activeChannelId = 'ch-1'; } },
  { name: 'DMCallPanel', node: () => <DMCallPanel />, join: () => { h.voice.dmCallConversationId = 'conv-1'; } },
  { name: 'DMVoicePanel', node: () => <DMVoicePanel />, join: () => { h.voice.dmCallConversationId = 'conv-1'; } },
];

beforeEach(() => {
  Object.assign(h.voice, {
    activeChannelId: null, dmCallConversationId: null, selfMute: false, pttActive: false,
    dmCallUsers: [{ id: 'me', displayName: 'Me', avatarUrl: null, selfMute: false, selfDeaf: false, speaking: false }],
  });
  h.voice.channelUsers = new Map();
  h.voice.toggleMute.mockClear();
  h.settings.voiceMode = 'voice_activity';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe.each(scenes)('$name: the local mute control', ({ node, join }) => {
  it('voice activity: unchanged — open icon, muted only by the flag', () => {
    join();
    show(node());
    let b = muteButton();
    expect(b.getAttribute('aria-label')).toBe('voice.mute');
    expect(hasOpenIcon(b)).toBe(true);
    expect(hasMutedIcon(b)).toBe(false);

    h.voice.selfMute = true;
    show(node());
    b = muteButton();
    expect(b.getAttribute('aria-label')).toBe('voice.unmute');
    expect(hasMutedIcon(b)).toBe(true);
    expect(isRed(b)).toBe(true);
  });

  it('push-to-talk, key up: muted icon, hold-the-key wording, not the red manual look', () => {
    h.settings.voiceMode = 'push_to_talk';
    join();
    show(node());
    const b = muteButton();
    expect(hasMutedIcon(b)).toBe(true);
    expect(hasOpenIcon(b)).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('settings.audio.holdToTransmit');
    expect(b.getAttribute('title')).toBe('settings.audio.holdToTransmit');
    expect(isRed(b)).toBe(false);
    expect(b.className).toContain('text-vox-voice-muted');
  });

  it('push-to-talk, key held: the open icon', () => {
    h.settings.voiceMode = 'push_to_talk';
    h.voice.pttActive = true;
    join();
    show(node());
    const b = muteButton();
    expect(hasOpenIcon(b)).toBe(true);
    expect(hasMutedIcon(b)).toBe(false);
    expect(isRed(b)).toBe(false);
  });

  it('push-to-talk with the manual mute: red and "unmute" while the key is up, open while held', () => {
    h.settings.voiceMode = 'push_to_talk';
    h.voice.selfMute = true;
    join();
    show(node());
    let b = muteButton();
    expect(hasMutedIcon(b)).toBe(true);
    expect(isRed(b)).toBe(true);
    expect(b.getAttribute('aria-label')).toBe('voice.unmute');

    h.voice.pttActive = true; // push-to-talk overrides the mute flag
    show(node());
    b = muteButton();
    expect(hasOpenIcon(b)).toBe(true);
    expect(isRed(b)).toBe(false);
  });

  it('the control still toggles the manual flag and changes nothing else', () => {
    h.settings.voiceMode = 'push_to_talk';
    join();
    show(node());
    act(() => { muteButton().click(); });
    expect(h.voice.toggleMute).toHaveBeenCalledTimes(1);
    expect(h.voice.selfMute).toBe(false);
  });
});

describe('UserCard outside a call', () => {
  it('push-to-talk with no call shows only the manual flag, never the waiting look', () => {
    h.settings.voiceMode = 'push_to_talk';
    show(<UserCard />);
    let b = muteButton();
    expect(hasOpenIcon(b)).toBe(true);
    expect(b.getAttribute('aria-label')).toBe('voice.mute');

    h.voice.selfMute = true;
    show(<UserCard />);
    b = muteButton();
    expect(hasMutedIcon(b)).toBe(true);
    expect(isRed(b)).toBe(true);
  });
});
