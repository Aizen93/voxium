import { create } from 'zustand';
import { api } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { getAccessToken, setTokens, clearTokens } from '../services/tokenStorage';
import type { User } from '@voxium/shared';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  totpRequired: boolean;
  totpToken: string | null;

  login: (email: string, password: string) => Promise<void>;
  verifyTOTP: (code: string) => Promise<void>;
  cancelTOTP: () => void;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isSubmitting: false,
  error: null,
  totpRequired: false,
  totpToken: null,

  login: async (email, password) => {
    set({ isSubmitting: true, error: null });
    try {
      const trustedDeviceToken = localStorage.getItem('voxium_admin_trusted_device') || undefined;
      const { data } = await api.post('/auth/login', { email, password, rememberMe: true, trustedDeviceToken });

      if (data.data.totpRequired) {
        set({ totpRequired: true, totpToken: data.data.totpToken, isSubmitting: false });
        return;
      }

      const { user, accessToken, refreshToken } = data.data;

      if (user.role !== 'superadmin' && user.role !== 'admin') {
        set({ error: 'Access denied. Admin privileges required.', isSubmitting: false });
        throw new Error('Access denied. Admin privileges required.');
      }

      setTokens(accessToken, refreshToken, true);
      connectSocket(accessToken);
      set({ user, isAuthenticated: true, isSubmitting: false });
    } catch (err: any) {
      set({
        error: err.response?.data?.error || 'Login failed',
        isSubmitting: false,
      });
      throw err;
    }
  },

  verifyTOTP: async (code) => {
    const totpToken = get().totpToken;
    if (!totpToken) return;
    set({ isSubmitting: true, error: null });
    try {
      const { data } = await api.post('/auth/totp/verify', { totpToken, code });
      const { user, accessToken, refreshToken, trustedDeviceToken } = data.data;

      if (user.role !== 'superadmin' && user.role !== 'admin') {
        set({ error: 'Access denied. Admin privileges required.', isSubmitting: false, totpRequired: false, totpToken: null });
        throw new Error('Access denied. Admin privileges required.');
      }

      setTokens(accessToken, refreshToken, true);
      if (trustedDeviceToken) {
        localStorage.setItem('voxium_admin_trusted_device', trustedDeviceToken);
      }
      connectSocket(accessToken);
      set({ user, isAuthenticated: true, isSubmitting: false, totpRequired: false, totpToken: null });
    } catch (err: any) {
      set({
        error: err.response?.data?.error || 'Invalid verification code',
        isSubmitting: false,
      });
      throw err;
    }
  },

  cancelTOTP: () => {
    set({ totpRequired: false, totpToken: null, error: null });
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
      const user = data.data;

      if (user.role !== 'superadmin' && user.role !== 'admin') {
        clearTokens();
        set({ isLoading: false });
        return;
      }

      connectSocket(token);
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      clearTokens();
      set({ isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
