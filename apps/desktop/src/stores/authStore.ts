import { create } from 'zustand';
import { api } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import type { User } from '@voxium/shared';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  uploadAvatar: (file: File) => Promise<void>;
  updateProfile: (fields: { displayName?: string; bio?: string }) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.post('/auth/login', { email, password });
      const { user, accessToken, refreshToken } = data.data;

      localStorage.setItem('voxium_access_token', accessToken);
      localStorage.setItem('voxium_refresh_token', refreshToken);

      connectSocket(accessToken);

      set({ user, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.error || 'Login failed',
        isLoading: false,
      });
      throw err;
    }
  },

  register: async (username, email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.post('/auth/register', { username, email, password });
      const { user, accessToken, refreshToken } = data.data;

      localStorage.setItem('voxium_access_token', accessToken);
      localStorage.setItem('voxium_refresh_token', refreshToken);

      connectSocket(accessToken);

      set({ user, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.error || 'Registration failed',
        isLoading: false,
      });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('voxium_access_token');
    localStorage.removeItem('voxium_refresh_token');
    disconnectSocket();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const token = localStorage.getItem('voxium_access_token');
    if (!token) {
      set({ isLoading: false });
      return;
    }

    try {
      const { data } = await api.get('/auth/me');
      connectSocket(token);
      set({ user: data.data, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('voxium_access_token');
      localStorage.removeItem('voxium_refresh_token');
      set({ isLoading: false });
    }
  },

  clearError: () => set({ error: null }),

  uploadAvatar: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const { data } = await api.post('/uploads/avatar', formData);
    const key = data.data.key;
    const userId = get().user?.id;
    set((state) => ({
      user: state.user ? { ...state.user, avatarUrl: key } : null,
    }));
    // Propagate to member list and chat messages so avatar updates everywhere
    if (userId) {
      useServerStore.getState().updateMemberAvatar(userId, key);
      useChatStore.getState().updateAuthorAvatar(userId, key);
    }
  },

  updateProfile: async (fields) => {
    const { data } = await api.patch('/users/me/profile', fields);
    set({ user: data.data });
  },
}));
