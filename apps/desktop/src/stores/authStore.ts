import { create } from 'zustand';
import { api } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { getAccessToken, setTokens, clearTokens, isRemembered } from '../services/tokenStorage';
import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import type { User } from '@voxium/shared';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  uploadAvatar: (file: File) => Promise<void>;
  updateProfile: (fields: { displayName?: string; bio?: string }) => Promise<void>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (token: string, password: string) => Promise<string>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (email, password, rememberMe = true) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.post('/auth/login', { email, password, rememberMe });
      const { user, accessToken, refreshToken } = data.data;

      setTokens(accessToken, refreshToken, rememberMe);

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

      setTokens(accessToken, refreshToken, true);

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
    clearTokens();
    disconnectSocket();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const token = getAccessToken();
    if (!token) {
      set({ isLoading: false });
      return;
    }

    try {
      const { data } = await api.get('/auth/me');
      connectSocket(token);
      set({ user: data.data, isAuthenticated: true, isLoading: false });
    } catch {
      clearTokens();
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

  forgotPassword: async (email) => {
    const { data } = await api.post('/auth/forgot-password', { email });
    return data.message;
  },

  resetPassword: async (token, password) => {
    const { data } = await api.post('/auth/reset-password', { token, password });
    return data.message;
  },

  changePassword: async (currentPassword, newPassword) => {
    const { data } = await api.post('/auth/change-password', { currentPassword, newPassword, rememberMe: isRemembered() });
    // Store fresh tokens so the current session survives the tokenVersion bump
    if (data.data?.accessToken && data.data?.refreshToken) {
      setTokens(data.data.accessToken, data.data.refreshToken);
    }
    return data.message;
  },
}));
