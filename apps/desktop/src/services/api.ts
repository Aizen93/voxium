import axios from 'axios';
import { connectSocket } from './socket';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('voxium_access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle token refresh on 401
let isRefreshing = false;
let refreshSubscribers: Array<(token: string) => void> = [];

function onTokenRefreshed(token: string) {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
}

function addRefreshSubscriber(cb: (token: string) => void) {
  refreshSubscribers.push(cb);
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      // If already refreshing, queue this request until the new token arrives
      if (isRefreshing) {
        return new Promise((resolve) => {
          addRefreshSubscriber((newToken: string) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            resolve(api(originalRequest));
          });
        });
      }

      const refreshToken = localStorage.getItem('voxium_refresh_token');
      if (refreshToken) {
        isRefreshing = true;
        try {
          const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken });
          const { accessToken, refreshToken: newRefreshToken } = data.data;

          localStorage.setItem('voxium_access_token', accessToken);
          localStorage.setItem('voxium_refresh_token', newRefreshToken);

          // Reconnect socket with fresh token
          // (socket.ts reads from localStorage on reconnect attempts too,
          //  but this handles the case where socket hasn't disconnected yet)
          connectSocket(accessToken);

          // Resolve all queued requests with the new token
          onTokenRefreshed(accessToken);

          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
          return api(originalRequest);
        } catch {
          localStorage.removeItem('voxium_access_token');
          localStorage.removeItem('voxium_refresh_token');
          window.location.href = '/login';
        } finally {
          isRefreshing = false;
        }
      }
    }

    return Promise.reject(error);
  }
);
