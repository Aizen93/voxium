import { useEffect, useRef, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { getSocket, getSocketGeneration, onConnectionStatusChange } from '../../services/socket';
import { ServerSidebar } from '../server/ServerSidebar';
import { ChannelSidebar } from '../channel/ChannelSidebar';
import { ChatArea } from '../chat/ChatArea';
import { MemberSidebar } from '../server/MemberSidebar';
import { SettingsModal } from '../settings/SettingsModal';
import { ConnectionBanner } from './ConnectionBanner';
import { DMList } from '../dm/DMList';
import { DMChatArea } from '../dm/DMChatArea';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePushToTalk } from '../../hooks/usePushToTalk';
import { playJoinSound, playLeaveSound, playMessageSound, playMentionSound } from '../../services/notificationSounds';
import { toast } from '../../stores/toastStore';
import { stopSpeakingDetection } from '../../services/audioAnalyser';
import { IncomingCallModal } from '../dm/IncomingCallModal';
import { FriendsView } from '../friends/FriendsView';
import { SupportTicketView } from '../dm/SupportTicketView';
import { useSupportStore } from '../../stores/supportStore';
import { SearchModal } from '../search/SearchModal';
import { ScreenShareViewer } from '../voice/ScreenShareViewer';
import { ScreenShareFloating } from '../voice/ScreenShareFloating';
import { initNotifications, notify } from '../../services/notifications';
import { useAnnouncementStore } from '../../stores/announcementStore';
import { AnnouncementBanner } from './AnnouncementBanner';
import type {
  Message, Channel, Category, Server, PublicUser, VoiceUser, UserStatus,
  TransportOptions, ConsumerOptions, UnreadCount, DMUnreadCount, Friendship,
  MemberRole, Announcement, SupportMessageData, SupportTicketStatus,
  ReactionGroup,
} from '@voxium/shared';

export function MainLayout() {
  const { fetchServers, activeServerId, channels } = useServerStore();
  const { user } = useAuthStore();
  const activeConversationId = useDMStore((s) => s.activeConversationId);
  const conversations = useDMStore((s) => s.conversations);
  const showFriendsView = useFriendStore((s) => s.showFriendsView);
  const showSupportView = useSupportStore((s) => s.showSupportView);
  const isSettingsOpen = useSettingsStore((s) => s.isSettingsOpen);
  const screenSharingUserId = useVoiceStore((s) => s.screenSharingUserId);
  const screenShareViewMode = useVoiceStore((s) => s.screenShareViewMode);
  const voiceActiveChannelId = useVoiceStore((s) => s.activeChannelId);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  usePushToTalk();
  const attachedGeneration = useRef(-1);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Set local user ID in voice store
  useEffect(() => {
    if (user?.id) {
      useVoiceStore.getState().setLocalUserId(user.id);
    }
  }, [user?.id]);

  // Request notification permission on mount
  useEffect(() => {
    initNotifications();
  }, []);

  // Global Ctrl+K / Cmd+K search shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowGlobalSearch((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Fetch servers on mount
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Re-mark current channel/conversation as read when tab/window regains visibility.
  // This covers cases where the socket reconnected in the background and unread:init
  // restored stale counts because a previous markChannelRead API call failed.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      const serverState = useServerStore.getState();
      if (serverState.activeChannelId) {
        serverState.clearUnread(serverState.activeChannelId);
        serverState.markChannelRead(serverState.activeChannelId);
      }
      if (!serverState.activeServerId) {
        const dmState = useDMStore.getState();
        if (dmState.activeConversationId) {
          dmState.clearDMUnread(dmState.activeConversationId);
          dmState.markConversationRead(dmState.activeConversationId);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Set up WebSocket event listeners with proper function references
  useEffect(() => {
    // Debounce timers for marking channels/conversations as read while viewing
    let markReadTimer: ReturnType<typeof setTimeout> | null = null;
    let markDMReadTimer: ReturnType<typeof setTimeout> | null = null;

    // Store function references so cleanup actually works
    const handlers = {
      messageNew: (message: Message & { serverId?: string; serverName?: string; channelName?: string }) => {
        if (message.channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().addMessage(message);
          // Debounced mark-as-read so lastReadAt stays current while viewing
          // Capture serverId now — channels array may change if user switches servers before timer fires
          const capturedServerId = message.serverId;
          if (markReadTimer) clearTimeout(markReadTimer);
          markReadTimer = setTimeout(() => {
            useServerStore.getState().markChannelRead(message.channelId!, capturedServerId);
          }, 2000);
        }
        const currentUser = useAuthStore.getState().user;
        if (message.author?.id === currentUser?.id) return;

        // Check if the current user is mentioned
        const isMentioned = !!(currentUser && message.mentions?.some((m) => m.id === currentUser.id));

        const isActiveChannel = message.channelId === useServerStore.getState().activeChannelId;

        // If viewing this channel and not mentioned, no notification needed
        if (isActiveChannel && !isMentioned) return;

        // Mention in active channel: play sound but do NOT increment unread (user is already viewing)
        if (isActiveChannel && isMentioned) {
          const settings = useSettingsStore.getState();
          if (settings.enableNotificationSounds) playMentionSound();
          return;
        }

        // Message in another channel: increment unread and notify
        if (message.channelId && message.serverId) {
          useServerStore.getState().incrementUnread(message.channelId, message.serverId);
        }
        const settings = useSettingsStore.getState();
        if (settings.enableNotificationSounds) {
          if (isMentioned) {
            playMentionSound();
          } else {
            playMessageSound();
          }
        }
        if (settings.enableDesktopNotifications) {
          const authorName = message.author?.displayName || message.author?.username || 'Someone';
          const serverName = message.serverName || 'Unknown Server';
          const channelName = message.channelName || 'unknown';
          const body = message.content?.length > 100 ? message.content.slice(0, 100) + '...' : message.content;
          const title = isMentioned
            ? `${authorName} mentioned you in ${serverName} — #${channelName}`
            : `${serverName} — #${channelName}`;
          void notify(title, `${authorName}: ${body}`, message.author?.avatarUrl);
        }
      },
      messageUpdate: (message: Message) => {
        if (message.channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().updateMessage(message);
        }
      },
      messageDelete: ({ messageId, channelId }: { messageId: string; channelId: string }) => {
        if (channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().deleteMessage(messageId);
        }
      },
      typingStart: ({ channelId, userId, username }: { channelId: string; userId: string; username: string }) => {
        const currentUser = useAuthStore.getState().user;
        if (userId !== currentUser?.id && channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().setTypingUser(userId, username);
        }
      },
      typingStop: ({ channelId, userId }: { channelId: string; userId: string }) => {
        if (channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().removeTypingUser(userId);
        }
      },
      presenceUpdate: ({ userId, status }: { userId: string; status: UserStatus }) => {
        useServerStore.getState().updateMemberStatus(userId, status);
        useDMStore.getState().updateParticipantStatus(userId, status);
        useFriendStore.getState().updateFriendStatus(userId, status);
      },
      voiceChannelUsers: ({ channelId, users: voiceUsers }: { channelId: string; users: VoiceUser[] }) => {
        useVoiceStore.getState().setChannelUsers(channelId, voiceUsers);
      },
      voiceUserJoined: ({ channelId, user: voiceUser }: { channelId: string; user: VoiceUser }) => {
        useVoiceStore.getState().addUserToChannel(channelId, voiceUser);
        const currentUser = useAuthStore.getState().user;
        if (voiceUser.id === currentUser?.id) return;
        if (useVoiceStore.getState().activeChannelId !== channelId) return;
        if (useSettingsStore.getState().enableNotificationSounds) playJoinSound();
      },
      voiceUserLeft: ({ channelId, userId }: { channelId: string; userId: string }) => {
        const currentUser = useAuthStore.getState().user;
        const voiceState = useVoiceStore.getState();
        voiceState.removeUserFromChannel(channelId, userId);
        if (userId === currentUser?.id) return;
        if (voiceState.activeChannelId !== channelId) return;
        if (useSettingsStore.getState().enableNotificationSounds) playLeaveSound();
      },
      voiceStateUpdate: ({ channelId, userId, selfMute, selfDeaf }: { channelId: string; userId: string; selfMute: boolean; selfDeaf: boolean }) => {
        useVoiceStore.getState().updateUserState(channelId, userId, selfMute, selfDeaf);
      },
      voiceSpeaking: ({ channelId, userId, speaking }: { channelId: string; userId: string; speaking: boolean }) => {
        useVoiceStore.getState().setUserSpeaking(channelId, userId, speaking);
      },
      voiceSignal: ({ from, signal }: { from: string; signal: unknown }) => {
        useVoiceStore.getState().handleSignal(from, signal);
      },
      voiceTransportCreated: (data: { routerRtpCapabilities: unknown; sendTransport: TransportOptions; recvTransport: TransportOptions }) => {
        useVoiceStore.getState().handleTransportCreated(data);
      },
      voiceNewConsumer: (data: ConsumerOptions) => {
        useVoiceStore.getState().handleNewConsumer(data);
      },
      voiceProducerClosed: (data: { consumerId: string; producerUserId: string }) => {
        useVoiceStore.getState().handleProducerClosed(data);
      },
      memberJoined: ({ serverId, user: joinedUser }: { serverId: string; user: PublicUser }) => {
        useServerStore.getState().addMember(serverId, joinedUser);
      },
      memberLeft: ({ serverId, userId }: { serverId: string; userId: string }) => {
        useServerStore.getState().removeMember(serverId, userId);
      },
      channelCreated: (channel: Channel) => {
        useServerStore.getState().addChannel(channel);
      },
      channelUpdated: (channel: Channel) => {
        useServerStore.getState().updateChannelData(channel);
      },
      channelDeleted: ({ channelId, serverId }: { channelId: string; serverId: string }) => {
        useServerStore.getState().removeChannel(channelId, serverId);
      },
      categoryCreated: (category: Category) => {
        useServerStore.getState().addCategory(category);
      },
      categoryUpdated: (category: Category) => {
        useServerStore.getState().updateCategory(category);
      },
      categoryDeleted: ({ categoryId, serverId }: { categoryId: string; serverId: string }) => {
        useServerStore.getState().removeCategory(categoryId, serverId);
      },
      serverUpdated: (server: Server) => {
        useServerStore.getState().updateServerData(server);
      },
      userUpdated: ({ userId, displayName, avatarUrl }: { userId: string; displayName: string; avatarUrl: string | null }) => {
        useServerStore.getState().updateMemberProfile(userId, { displayName, avatarUrl });
        useChatStore.getState().updateAuthorProfile(userId, { displayName, avatarUrl });
      },
      messageReactionUpdate: ({ messageId, channelId, reactions }: { messageId: string; channelId: string; reactions: ReactionGroup[] }) => {
        if (channelId === useServerStore.getState().activeChannelId) {
          useChatStore.getState().updateMessageReactions(messageId, reactions);
        }
      },
      unreadInit: ({ unreads }: { unreads: UnreadCount[] }) => {
        const store = useServerStore.getState();
        store.initUnreadCounts(unreads);
        // If the user is already viewing a channel, clear its unread and mark as read
        const activeChannelId = store.activeChannelId;
        if (activeChannelId) {
          store.clearUnread(activeChannelId);
          store.markChannelRead(activeChannelId);
        }
      },
      dmMessageNew: async (message: Message) => {
        const dmStore = useDMStore.getState();
        const activeConvId = dmStore.activeConversationId;

        // Update last message in conversation list
        if (message.conversationId) {
          // If conversation isn't in the local store yet (e.g. brand-new DM), fetch it
          const exists = dmStore.conversations.some((c) => c.id === message.conversationId);
          if (!exists) {
            await dmStore.fetchConversations();
          } else {
            dmStore.updateLastMessage(message.conversationId, {
              content: message.content,
              createdAt: message.createdAt,
              authorId: message.author?.id,
            });
          }
        }

        if (message.conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().addMessage(message);
          // Debounced mark-as-read so lastReadAt stays current while viewing
          if (markDMReadTimer) clearTimeout(markDMReadTimer);
          markDMReadTimer = setTimeout(() => {
            useDMStore.getState().markConversationRead(message.conversationId!);
          }, 2000);
        } else if (message.conversationId) {
          const currentUser = useAuthStore.getState().user;
          if (message.author?.id !== currentUser?.id) {
            dmStore.incrementDMUnread(message.conversationId);
            const settings = useSettingsStore.getState();
            if (settings.enableNotificationSounds) playMessageSound();
            if (settings.enableDesktopNotifications) {
              const authorName = message.author?.displayName || message.author?.username || 'Someone';
              const body = message.content?.length > 100 ? message.content.slice(0, 100) + '...' : message.content;
              void notify(`DM — ${authorName}`, body, message.author?.avatarUrl);
            }
          }
        }
      },
      dmMessageUpdate: (message: Message) => {
        const activeConvId = useDMStore.getState().activeConversationId;
        if (message.conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().updateMessage(message);
        }
      },
      dmMessageDelete: ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
        const activeConvId = useDMStore.getState().activeConversationId;
        if (conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().deleteMessage(messageId);
        }
      },
      dmTypingStart: ({ conversationId, userId, username }: { conversationId: string; userId: string; username: string }) => {
        const currentUser = useAuthStore.getState().user;
        const activeConvId = useDMStore.getState().activeConversationId;
        if (userId !== currentUser?.id && conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().setTypingUser(userId, username);
        }
      },
      dmTypingStop: ({ conversationId, userId }: { conversationId: string; userId: string }) => {
        const activeConvId = useDMStore.getState().activeConversationId;
        if (conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().removeTypingUser(userId);
        }
      },
      dmReactionUpdate: ({ messageId, conversationId, reactions }: { messageId: string; conversationId: string; reactions: ReactionGroup[] }) => {
        const activeConvId = useDMStore.getState().activeConversationId;
        if (conversationId === activeConvId && !useServerStore.getState().activeServerId) {
          useChatStore.getState().updateMessageReactions(messageId, reactions);
        }
      },
      dmUnreadInit: ({ unreads }: { unreads: DMUnreadCount[] }) => {
        const dmStore = useDMStore.getState();
        dmStore.initDMUnreadCounts(unreads);
        const activeConvId = dmStore.activeConversationId;
        if (activeConvId) {
          dmStore.clearDMUnread(activeConvId);
          dmStore.markConversationRead(activeConvId);
        }
      },
      dmVoiceOffer: ({ conversationId, from }: { conversationId: string; from: VoiceUser }) => {
        const currentUser = useAuthStore.getState().user;
        if (from.id === currentUser?.id) return;
        // Don't show incoming call if already in a voice channel or DM call
        const voiceState = useVoiceStore.getState();
        if (voiceState.activeChannelId || voiceState.dmCallConversationId) return;
        voiceState.setIncomingCall({ conversationId, from });
      },
      dmVoiceJoined: ({ conversationId, user: voiceUser }: { conversationId: string; user: VoiceUser }) => {
        if (useVoiceStore.getState().dmCallConversationId !== conversationId) return;
        useVoiceStore.getState().addDMCallUser(voiceUser);
      },
      dmVoiceLeft: ({ conversationId, userId }: { conversationId: string; userId: string }) => {
        if (useVoiceStore.getState().dmCallConversationId !== conversationId) return;
        useVoiceStore.getState().removeDMCallUser(userId);
      },
      dmVoiceStateUpdate: ({ conversationId, userId, selfMute, selfDeaf }: { conversationId: string; userId: string; selfMute: boolean; selfDeaf: boolean }) => {
        if (useVoiceStore.getState().dmCallConversationId !== conversationId) return;
        useVoiceStore.getState().updateDMCallUserState(userId, selfMute, selfDeaf);
      },
      dmVoiceSpeaking: ({ conversationId, userId, speaking }: { conversationId: string; userId: string; speaking: boolean }) => {
        if (useVoiceStore.getState().dmCallConversationId !== conversationId) return;
        useVoiceStore.getState().setDMCallUserSpeaking(userId, speaking);
      },
      dmVoiceSignal: ({ from, signal }: { from: string; signal: unknown }) => {
        if (!useVoiceStore.getState().dmCallConversationId) return;
        useVoiceStore.getState().handleDMSignal(from, signal);
      },
      dmVoiceEnded: ({ conversationId }: { conversationId: string }) => {
        const voiceState = useVoiceStore.getState();
        if (voiceState.dmCallConversationId === conversationId) {
          // Inline cleanup instead of leaveDMCall() to avoid emitting dm:voice:leave
          // back to the server (call was already ended server-side)
          voiceState.stopLatencyMeasurement();
          stopSpeakingDetection();
          if (voiceState.localStream) {
            voiceState.localStream.getTracks().forEach((track) => track.stop());
          }
          voiceState.destroyAllPeers();
          useVoiceStore.setState({
            dmCallConversationId: null,
            dmCallUsers: [],
            localStream: null,
            latency: null,
          });
        }
        if (voiceState.incomingCall?.conversationId === conversationId) {
          voiceState.setIncomingCall(null);
        }
      },
      dmConversationDeleted: ({ conversationId }: { conversationId: string }) => {
        useDMStore.getState().handleConversationDeleted(conversationId);
      },
      friendRequestReceived: (data: { friendship: Friendship }) => {
        useFriendStore.getState().handleRequestReceived(data);
      },
      friendRequestAccepted: (data: { friendship: Friendship }) => {
        useFriendStore.getState().handleRequestAccepted(data);
      },
      friendRemoved: (data: { userId: string }) => {
        useFriendStore.getState().handleFriendRemoved(data);
      },
      voiceScreenShareStart: ({ channelId, userId }: { channelId: string; userId: string }) => {
        useVoiceStore.getState().setScreenSharingUser(channelId, userId);
        // Mark the user as screenSharing in channelUsers
        const users = useVoiceStore.getState().channelUsers.get(channelId);
        if (users) {
          const updated = users.map((u) => u.id === userId ? { ...u, screenSharing: true } : u);
          useVoiceStore.getState().setChannelUsers(channelId, updated);
        }
      },
      voiceScreenShareStop: ({ channelId, userId }: { channelId: string; userId: string }) => {
        useVoiceStore.getState().setScreenSharingUser(channelId, null);
        // Clear the screenSharing flag in channelUsers
        const users = useVoiceStore.getState().channelUsers.get(channelId);
        if (users) {
          const updated = users.map((u) => u.id === userId ? { ...u, screenSharing: false } : u);
          useVoiceStore.getState().setChannelUsers(channelId, updated);
        }
      },
      voiceScreenShareState: ({ channelId, sharingUserId }: { channelId: string; sharingUserId: string | null }) => {
        useVoiceStore.getState().setScreenSharingUser(channelId, sharingUserId);
        // Mark the user as screenSharing in channelUsers
        if (sharingUserId) {
          const users = useVoiceStore.getState().channelUsers.get(channelId);
          if (users) {
            const updated = users.map((u) => u.id === sharingUserId ? { ...u, screenSharing: true } : u);
            useVoiceStore.getState().setChannelUsers(channelId, updated);
          }
        }
      },
      memberRoleUpdated: ({ serverId, userId, role }: { serverId: string; userId: string; role: MemberRole }) => {
        useServerStore.getState().handleMemberRoleUpdated(serverId, userId, role);
      },
      memberKicked: ({ serverId }: { serverId: string }) => {
        // Leave voice if the active voice channel belongs to the kicked server
        const voiceState = useVoiceStore.getState();
        const serverState = useServerStore.getState();
        if (voiceState.activeChannelId) {
          const voiceChannel = serverState.channels.find((c) => c.id === voiceState.activeChannelId);
          if (voiceChannel?.serverId === serverId) {
            voiceState.leaveChannel();
          }
        }
        serverState.handleMemberKicked(serverId);
        toast.warning('You were kicked from the server');
      },
      serverDeleted: ({ serverId }: { serverId: string }) => {
        const voiceState = useVoiceStore.getState();
        const serverState = useServerStore.getState();

        // Inline voice cleanup if in a voice channel on this server
        // (don't call leaveChannel() — it would emit voice:leave back to
        // the server, but the server already ejected us)
        if (voiceState.activeChannelId) {
          const voiceChannel = serverState.channels.find((c) => c.id === voiceState.activeChannelId);
          if (voiceChannel?.serverId === serverId) {
            voiceState.stopLatencyMeasurement();
            stopSpeakingDetection();
            if (voiceState.localStream) {
              voiceState.localStream.getTracks().forEach((track) => track.stop());
            }
            voiceState.cleanupSFU();
            useVoiceStore.setState({
              activeChannelId: null,
              localStream: null,
              latency: null,
              screenStream: null,
              isScreenSharing: false,
              screenSharingUserId: null,
              remoteScreenStream: null,
            });
          }
        }

        // Clean up orphaned channelUsers entries for the deleted server's voice channels
        if (serverState.activeServerId === serverId) {
          const voiceChannelIds = serverState.channels
            .filter((c) => c.type === 'voice')
            .map((c) => c.id);
          if (voiceChannelIds.length > 0) {
            const newChannelUsers = new Map(voiceState.channelUsers);
            for (const chId of voiceChannelIds) {
              newChannelUsers.delete(chId);
            }
            useVoiceStore.setState({ channelUsers: newChannelUsers });
          }

          // Clear messages since the active channel is being removed
          useChatStore.getState().clearMessages();
        }

        serverState.handleServerDeleted(serverId);
        toast.info('Server was deleted');
      },
      announcementInit: ({ announcements }: { announcements: Announcement[] }) => {
        useAnnouncementStore.getState().initAnnouncements(announcements);
      },
      announcementNew: (announcement: Announcement) => {
        useAnnouncementStore.getState().addAnnouncement(announcement);
        const typeLabels: Record<string, string> = { info: 'Info', warning: 'Warning', maintenance: 'Maintenance' };
        const label = typeLabels[announcement.type] || 'Announcement';
        toast.info(`${label}: ${announcement.title}`);
      },
      supportMessageNew: (message: SupportMessageData) => {
        useSupportStore.getState().addMessage(message);
      },
      supportStatusChange: (data: { ticketId: string; status: SupportTicketStatus; claimedById?: string; claimedByUsername?: string }) => {
        useSupportStore.getState().updateStatus(data.status, data.claimedById, data.claimedByUsername);
      },
      voiceError: (data: { message: string }) => {
        const vs = useVoiceStore.getState();
        if (vs.activeChannelId) vs.leaveChannel();
        if (vs.dmCallConversationId) vs.leaveDMCall();
        toast.error(data.message);
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Socket.IO requires any[] for generic on/off iteration
    const eventMap: Array<[string, (...args: any[]) => void]> = [
      ['message:new', handlers.messageNew],
      ['message:update', handlers.messageUpdate],
      ['message:delete', handlers.messageDelete],
      ['typing:start', handlers.typingStart],
      ['typing:stop', handlers.typingStop],
      ['presence:update', handlers.presenceUpdate],
      ['voice:channel_users', handlers.voiceChannelUsers],
      ['voice:user_joined', handlers.voiceUserJoined],
      ['voice:user_left', handlers.voiceUserLeft],
      ['voice:state_update', handlers.voiceStateUpdate],
      ['voice:speaking', handlers.voiceSpeaking],
      ['voice:signal', handlers.voiceSignal],
      ['voice:transport_created', handlers.voiceTransportCreated],
      ['voice:new_consumer', handlers.voiceNewConsumer],
      ['voice:producer_closed', handlers.voiceProducerClosed],
      ['voice:error', handlers.voiceError],
      ['voice:screen_share:start', handlers.voiceScreenShareStart],
      ['voice:screen_share:stop', handlers.voiceScreenShareStop],
      ['voice:screen_share:state', handlers.voiceScreenShareState],
      ['member:joined', handlers.memberJoined],
      ['member:left', handlers.memberLeft],
      ['channel:created', handlers.channelCreated],
      ['channel:updated', handlers.channelUpdated],
      ['channel:deleted', handlers.channelDeleted],
      ['category:created', handlers.categoryCreated],
      ['category:updated', handlers.categoryUpdated],
      ['category:deleted', handlers.categoryDeleted],
      ['server:updated', handlers.serverUpdated],
      ['user:updated', handlers.userUpdated],
      ['message:reaction_update', handlers.messageReactionUpdate],
      ['unread:init', handlers.unreadInit],
      ['dm:message:new', handlers.dmMessageNew],
      ['dm:message:update', handlers.dmMessageUpdate],
      ['dm:message:delete', handlers.dmMessageDelete],
      ['dm:typing:start', handlers.dmTypingStart],
      ['dm:typing:stop', handlers.dmTypingStop],
      ['dm:message:reaction_update', handlers.dmReactionUpdate],
      ['dm:unread:init', handlers.dmUnreadInit],
      ['dm:voice:offer', handlers.dmVoiceOffer],
      ['dm:voice:joined', handlers.dmVoiceJoined],
      ['dm:voice:left', handlers.dmVoiceLeft],
      ['dm:voice:state_update', handlers.dmVoiceStateUpdate],
      ['dm:voice:speaking', handlers.dmVoiceSpeaking],
      ['dm:voice:signal', handlers.dmVoiceSignal],
      ['dm:voice:ended', handlers.dmVoiceEnded],
      ['dm:conversation:deleted', handlers.dmConversationDeleted],
      ['friend:request_received', handlers.friendRequestReceived],
      ['friend:request_accepted', handlers.friendRequestAccepted],
      ['friend:removed', handlers.friendRemoved],
      ['member:role_updated', handlers.memberRoleUpdated],
      ['member:kicked', handlers.memberKicked],
      ['server:deleted', handlers.serverDeleted],
      ['announcement:init', handlers.announcementInit],
      ['announcement:new', handlers.announcementNew],
      ['support:message:new', handlers.supportMessageNew],
      ['support:status_change', handlers.supportStatusChange],
    ];

    /**
     * Idempotent: removes then re-adds all listeners on the given socket.
     * Tracks socket generation so we know if the socket instance changed.
     */
    function ensureListeners(socket: NonNullable<ReturnType<typeof getSocket>>) {
      const gen = getSocketGeneration();
      if (attachedGeneration.current === gen) return; // same socket, already attached

      // Cast to untyped emitter for generic iteration over the event map
      const emitter = socket as { on: (e: string, fn: (...a: unknown[]) => void) => void; off: (e: string, fn: (...a: unknown[]) => void) => void };

      // Remove from whatever socket previously had them (no-op if wrong instance)
      for (const [event, handler] of eventMap) {
        emitter.off(event, handler);
      }

      // Attach fresh
      for (const [event, handler] of eventMap) {
        emitter.on(event, handler);
      }

      attachedGeneration.current = gen;
      console.log('[MainLayout] Listeners attached (generation', gen + ')');
    }

    function detachListeners(socket: NonNullable<ReturnType<typeof getSocket>>) {
      const emitter = socket as { off: (e: string, fn: (...a: unknown[]) => void) => void };
      for (const [event, handler] of eventMap) {
        emitter.off(event, handler);
      }
      attachedGeneration.current = -1;
    }

    /**
     * Called on every connect/reconnect. Ensures listeners are attached
     * and stale data is re-fetched. Deduplicates via socket.id.
     */
    let handledSocketId: string | undefined;

    function handleConnected() {
      const socket = getSocket();
      if (!socket?.connected) return;
      // Deduplicate: only process each connection once
      if (socket.id === handledSocketId) return;
      handledSocketId = socket.id;

      console.log(`[MainLayout] Connection established (id=${socket.id}) — attaching listeners & re-fetching`);
      ensureListeners(socket);

      // Re-fetch servers and members (presence may have changed)
      useServerStore.getState().fetchServers();
      const serverId = useServerStore.getState().activeServerId;
      if (serverId) {
        useServerStore.getState().fetchMembers(serverId);
      }
      // Re-fetch DM conversations
      useDMStore.getState().fetchConversations();
      // Re-fetch friends
      useFriendStore.getState().fetchFriends();
      // Re-fetch support ticket (auto-joins room on server)
      useSupportStore.getState().fetchTicket();
    }

    // Mechanism 1: Direct listener on the socket object
    const socket = getSocket();
    if (socket) {
      socket.on('connect', handleConnected);

      if (socket.connected) {
        handledSocketId = socket.id;
        ensureListeners(socket);
      }
    }

    // Mechanism 2: Status change listener (fires even if socket was replaced)
    const unsubStatus = onConnectionStatusChange((status) => {
      if (status !== 'connected') return;

      // Ensure direct listener is on the current socket
      const currentSocket = getSocket();
      if (currentSocket && currentSocket !== socket) {
        currentSocket.on('connect', handleConnected);
      }

      handleConnected();
    });

    cleanupRef.current = () => {
      const s = getSocket();
      if (s) {
        s.off('connect', handleConnected);
        detachListeners(s);
      }
      if (socket && socket !== s) socket.off('connect', handleConnected);
      unsubStatus();
      if (markReadTimer) clearTimeout(markReadTimer);
      if (markDMReadTimer) clearTimeout(markDMReadTimer);
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [user?.id]);

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <AnnouncementBanner />
      <div className="flex flex-1 min-h-0">
        <ServerSidebar />
        {activeServerId ? <ChannelSidebar /> : <DMList />}
        <div className="flex flex-1 flex-col overflow-hidden">
          {activeServerId ? (
            screenSharingUserId && voiceActiveChannelId ? (
              screenShareViewMode === 'inline' ? (
                <ScreenShareViewer />
              ) : (
                <>
                  <ChatArea />
                  <ScreenShareFloating />
                </>
              )
            ) : (
              <ChatArea />
            )
          ) : showFriendsView ? (
            <FriendsView />
          ) : showSupportView ? (
            <SupportTicketView />
          ) : activeConversationId ? (
            <DMChatArea />
          ) : (
            <DMWelcome />
          )}
        </div>
        {activeServerId && <MemberSidebar />}
        {isSettingsOpen && <SettingsModal />}
        <IncomingCallModal />
        {showGlobalSearch && (() => {
          if (activeServerId) {
            return (
              <SearchModal
                onClose={() => setShowGlobalSearch(false)}
                serverId={activeServerId}
                channels={channels}
              />
            );
          }
          if (activeConversationId) {
            const conv = conversations.find((c) => c.id === activeConversationId);
            return (
              <SearchModal
                onClose={() => setShowGlobalSearch(false)}
                conversationId={activeConversationId}
                participantName={conv?.participant.displayName}
              />
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
}

function DMWelcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-vox-bg-primary">
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-vox-bg-secondary">
          <svg className="h-12 w-12 text-vox-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-vox-text-primary">Direct Messages</h2>
        <p className="max-w-md text-vox-text-secondary">
          Select a conversation from the sidebar, or click on a member in any server to start a new one.
        </p>
      </div>
    </div>
  );
}
