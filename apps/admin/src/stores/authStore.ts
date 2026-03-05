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

  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isSubmitting: false,
  error: null,

  login: async (email, password) => {
    set({ isSubmitting: true, error: null });
    try {
      const { data } = await api.post('/auth/login', { email, password, rememberMe: true });
      const { user, accessToken, refreshToken } = data.data;

      if (user.role !== 'superadmin' && user.role !== 'admin') {
        set({ error: 'Access denied. Admin privileges required.', isSubmitting: false });
        return;
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
