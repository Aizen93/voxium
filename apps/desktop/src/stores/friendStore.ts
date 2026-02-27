import { create } from 'zustand';
import { api } from '../services/api';
import { toast } from './toastStore';
import type { Friendship, UserStatus } from '@voxium/shared';

type FriendTab = 'online' | 'all' | 'pending' | 'add';

interface FriendState {
  friends: Friendship[];
  pendingIncoming: Friendship[];
  pendingOutgoing: Friendship[];
  activeTab: FriendTab;
  showFriendsView: boolean;

  fetchFriends: () => Promise<void>;
  sendRequest: (username: string) => Promise<void>;
  acceptRequest: (friendshipId: string) => Promise<void>;
  removeFriendship: (friendshipId: string) => Promise<void>;
  setActiveTab: (tab: FriendTab) => void;
  setShowFriendsView: (show: boolean) => void;
  updateFriendStatus: (userId: string, status: UserStatus) => void;

  // Socket handlers
  handleRequestReceived: (data: { friendship: Friendship }) => void;
  handleRequestAccepted: (data: { friendship: Friendship }) => void;
  handleFriendRemoved: (data: { userId: string }) => void;

  // Sync helper
  getFriendshipStatus: (userId: string) => { status: 'none' | 'pending_outgoing' | 'pending_incoming' | 'friends'; friendshipId: string | null };
}

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: [],
  pendingIncoming: [],
  pendingOutgoing: [],
  activeTab: 'online',
  showFriendsView: false,

  fetchFriends: async () => {
    try {
      const { data } = await api.get('/friends');
      const all: Friendship[] = data.data;
      set({
        friends: all.filter((f) => f.status === 'accepted'),
        pendingIncoming: all.filter((f) => f.status === 'pending' && f.addresseeId !== f.user.id),
        pendingOutgoing: all.filter((f) => f.status === 'pending' && f.requesterId !== f.user.id),
      });
    } catch (err) {
      console.error('Failed to fetch friends:', err);
    }
  },

  sendRequest: async (username: string) => {
    const { data } = await api.post('/friends/request', { username });
    const friendship: Friendship = data.data;

    if (friendship.status === 'accepted') {
      // Auto-accepted (reverse pending existed)
      set((state) => ({
        friends: [friendship, ...state.friends],
        pendingIncoming: state.pendingIncoming.filter((f) => f.user.id !== friendship.user.id),
      }));
    } else {
      set((state) => ({
        pendingOutgoing: [friendship, ...state.pendingOutgoing],
      }));
    }
  },

  acceptRequest: async (friendshipId: string) => {
    const { data } = await api.post(`/friends/${friendshipId}/accept`);
    const friendship: Friendship = data.data;

    set((state) => ({
      friends: [friendship, ...state.friends],
      pendingIncoming: state.pendingIncoming.filter((f) => f.id !== friendshipId),
    }));
  },

  removeFriendship: async (friendshipId: string) => {
    await api.delete(`/friends/${friendshipId}`);

    set((state) => ({
      friends: state.friends.filter((f) => f.id !== friendshipId),
      pendingIncoming: state.pendingIncoming.filter((f) => f.id !== friendshipId),
      pendingOutgoing: state.pendingOutgoing.filter((f) => f.id !== friendshipId),
    }));
  },

  setActiveTab: (tab: FriendTab) => set({ activeTab: tab }),

  setShowFriendsView: (show: boolean) => set({ showFriendsView: show }),

  updateFriendStatus: (userId: string, status: UserStatus) => {
    set((state) => ({
      friends: state.friends.map((f) =>
        f.user.id === userId ? { ...f, user: { ...f.user, status } } : f
      ),
      pendingIncoming: state.pendingIncoming.map((f) =>
        f.user.id === userId ? { ...f, user: { ...f.user, status } } : f
      ),
      pendingOutgoing: state.pendingOutgoing.map((f) =>
        f.user.id === userId ? { ...f, user: { ...f.user, status } } : f
      ),
    }));
  },

  handleRequestReceived: ({ friendship }) => {
    set((state) => ({
      pendingIncoming: [friendship, ...state.pendingIncoming],
    }));
    toast.info(`${friendship.user.displayName} sent you a friend request`);
  },

  handleRequestAccepted: ({ friendship }) => {
    set((state) => ({
      friends: [friendship, ...state.friends],
      pendingOutgoing: state.pendingOutgoing.filter((f) => f.user.id !== friendship.user.id),
    }));
    toast.success(`${friendship.user.displayName} accepted your friend request`);
  },

  handleFriendRemoved: ({ userId }) => {
    set((state) => ({
      friends: state.friends.filter((f) => f.user.id !== userId),
      pendingIncoming: state.pendingIncoming.filter((f) => f.user.id !== userId),
      pendingOutgoing: state.pendingOutgoing.filter((f) => f.user.id !== userId),
    }));
  },

  getFriendshipStatus: (userId: string) => {
    const { friends, pendingIncoming, pendingOutgoing } = get();
    const friend = friends.find((f) => f.user.id === userId);
    if (friend) return { status: 'friends', friendshipId: friend.id };
    const incoming = pendingIncoming.find((f) => f.user.id === userId);
    if (incoming) return { status: 'pending_incoming', friendshipId: incoming.id };
    const outgoing = pendingOutgoing.find((f) => f.user.id === userId);
    if (outgoing) return { status: 'pending_outgoing', friendshipId: outgoing.id };
    return { status: 'none', friendshipId: null };
  },
}));
