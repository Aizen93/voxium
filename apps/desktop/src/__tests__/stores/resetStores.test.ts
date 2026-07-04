import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all external dependencies before importing the stores ──────────────
// resetStores transitively imports voiceStore, so it needs the same module
// mocks as voiceStore.test.ts, plus the api mock for the REST-backed stores.

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { data: [] } }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('mediasoup-client', () => ({
  Device: vi.fn(),
}));

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
  onSocketReconnect: vi.fn(),
}));

vi.mock('../../services/audioAnalyser', () => ({
  startSpeakingDetection: vi.fn(),
  stopSpeakingDetection: vi.fn(),
  setNoiseGateThreshold: vi.fn(),
  getGatedStream: vi.fn().mockReturnValue(null),
  setNoiseSuppression: vi.fn(),
  onSpeakingChange: vi.fn(),
  applyNoiseSuppression: vi.fn().mockImplementation((stream: MediaStream) => Promise.resolve(stream)),
  getSuppressedStream: vi.fn().mockReturnValue(null),
  stopNoiseSuppression: vi.fn(),
  setSpeakingDetectionPaused: vi.fn(),
}));

vi.mock('../../services/sdpUtils', () => ({
  optimizeOpusSDP: vi.fn((sdp: string) => sdp),
}));

vi.mock('@timephy/rnnoise-wasm', () => ({
  NoiseSuppressorWorklet_Name: 'NoiseSuppressorWorklet',
}));
vi.mock('@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url', () => ({
  default: 'mock-url',
}));

vi.mock('../../stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const store = create(() => ({
    audioInputDeviceId: '',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'voice_activity' as const,
    voiceQuality: 'medium' as const,
    pushToTalkKey: 'Backquote',
    enableNoiseSuppression: true,
    enableNotificationSounds: true,
    enableDesktopNotifications: true,
    setAudioInputDeviceId: vi.fn(),
    setAudioOutputDeviceId: vi.fn(),
    setNoiseGateThreshold: vi.fn(),
    setVoiceMode: vi.fn(),
    setVoiceQuality: vi.fn(),
    setPushToTalkKey: vi.fn(),
    setEnableNoiseSuppression: vi.fn(),
    setEnableNotificationSounds: vi.fn(),
    setEnableDesktopNotifications: vi.fn(),
    subscribe: vi.fn(),
  }));
  return {
    useSettingsStore: store,
    VOICE_QUALITY_BITRATE: { low: 16000, medium: 32000, high: 64000 },
  };
});

import { resetAccountStores } from '../../stores/resetStores';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSupportStore } from '../../stores/supportStore';
import { useAnnouncementStore } from '../../stores/announcementStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Server, ServerMember, Conversation, Friendship, Message } from '@voxium/shared';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const fakeServer = { id: 'srv-1', name: 'Old Account Server', ownerId: 'u-prev' } as unknown as Server;
const fakeMember = { userId: 'u-prev', serverId: 'srv-1', role: 'member', user: { id: 'u-prev', username: 'prev' } } as unknown as ServerMember;
const fakeConversation = { id: 'conv-1', participant: { id: 'u-friend', username: 'friend' } } as unknown as Conversation;
const fakeFriendship = { id: 'fr-1', status: 'accepted', user: { id: 'u-friend', username: 'friend' } } as unknown as Friendship;
const fakeMessage = { id: 'msg-1', content: 'leftover from previous account', channelId: 'ch-1' } as unknown as Message;

function populateAccountStores() {
  useServerStore.setState({
    servers: [fakeServer],
    activeServerId: 'srv-1',
    members: [fakeMember],
    activeChannelId: 'ch-1',
    unreadCounts: { 'ch-1': 3 },
    serverUnreadCounts: { 'srv-1': 3 },
  });
  useDMStore.setState({
    conversations: [fakeConversation],
    activeConversationId: 'conv-1',
    dmUnreadCounts: { 'conv-1': 2 },
  });
  useFriendStore.setState({
    friends: [fakeFriendship],
    pendingIncoming: [fakeFriendship],
    activeTab: 'all',
    showFriendsView: true,
  });
  useChatStore.setState({
    messages: [fakeMessage],
    hasMore: true,
    replyingTo: fakeMessage,
  });
  useSupportStore.setState({
    messages: [{ id: 'sup-1', content: 'help', authorId: 'u-prev' } as never],
    showSupportView: true,
  });
  useAnnouncementStore.setState({
    announcements: [{ id: 'ann-1', title: 'old' } as never],
  });
}

describe('resetAccountStores (HIGH-14b)', () => {
  beforeEach(() => {
    resetAccountStores();
  });

  it('wipes every populated account-scoped store back to its initial state', () => {
    populateAccountStores();

    resetAccountStores();

    // serverStore
    const server = useServerStore.getState();
    expect(server.servers).toEqual([]);
    expect(server.activeServerId).toBeNull();
    expect(server.members).toEqual([]);
    expect(server.activeChannelId).toBeNull();
    expect(server.unreadCounts).toEqual({});
    expect(server.serverUnreadCounts).toEqual({});

    // dmStore
    const dm = useDMStore.getState();
    expect(dm.conversations).toEqual([]);
    expect(dm.activeConversationId).toBeNull();
    expect(dm.dmUnreadCounts).toEqual({});

    // friendStore
    const friend = useFriendStore.getState();
    expect(friend.friends).toEqual([]);
    expect(friend.pendingIncoming).toEqual([]);
    expect(friend.activeTab).toBe('online');
    expect(friend.showFriendsView).toBe(false);

    // chatStore
    const chat = useChatStore.getState();
    expect(chat.messages).toEqual([]);
    expect(chat.hasMore).toBe(false);
    expect(chat.replyingTo).toBeNull();

    // supportStore
    const support = useSupportStore.getState();
    expect(support.messages).toEqual([]);
    expect(support.showSupportView).toBe(false);

    // announcementStore
    expect(useAnnouncementStore.getState().announcements).toEqual([]);
  });

  it('store actions still work after a replace-reset', () => {
    populateAccountStores();
    resetAccountStores();

    // friendStore setter
    useFriendStore.getState().setActiveTab('pending');
    expect(useFriendStore.getState().activeTab).toBe('pending');

    // dmStore setter
    useDMStore.getState().addConversation(fakeConversation);
    expect(useDMStore.getState().conversations).toHaveLength(1);
    expect(useDMStore.getState().conversations[0].id).toBe('conv-1');

    // serverStore setter (activeServerId is null → no API side effects)
    useServerStore.getState().setActiveChannel('ch-77');
    expect(useServerStore.getState().activeChannelId).toBe('ch-77');

    // chatStore setter
    useChatStore.getState().setReplyingTo(fakeMessage);
    expect(useChatStore.getState().replyingTo).toBe(fakeMessage);
  });

  it('resetting twice in a row is idempotent', () => {
    populateAccountStores();
    resetAccountStores();
    resetAccountStores();

    expect(useServerStore.getState().servers).toEqual([]);
    expect(useDMStore.getState().conversations).toEqual([]);
    expect(useFriendStore.getState().friends).toEqual([]);
  });

  it('does NOT reset settingsStore (device-level preferences survive logout)', () => {
    useSettingsStore.setState({ audioInputDeviceId: 'mic-42' } as never);
    populateAccountStores();

    resetAccountStores();

    expect((useSettingsStore.getState() as { audioInputDeviceId: string }).audioInputDeviceId).toBe('mic-42');
    // Account stores were still wiped in the same call
    expect(useServerStore.getState().servers).toEqual([]);
  });
});
