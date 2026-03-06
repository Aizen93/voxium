import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => void;
  removeToast: (id: string) => void;
}

const MAX_TOASTS = 5;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (toast) => {
    const id = crypto.randomUUID();
    const duration = toast.duration ?? 4000;
    const newToast: Toast = { ...toast, id, duration };

    set((state) => {
      const toasts = [...state.toasts, newToast];
      // Remove oldest if exceeding max — clear their timers
      if (toasts.length > MAX_TOASTS) {
        const evicted = toasts.slice(0, toasts.length - MAX_TOASTS);
        for (const t of evicted) {
          const timer = timers.get(t.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(t.id);
          }
        }
        return { toasts: toasts.slice(toasts.length - MAX_TOASTS) };
      }
      return { toasts };
    });

    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        get().removeToast(id);
      }, duration),
    );
  },

  removeToast: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

// Convenience functions callable from anywhere
export const toast = {
  success: (message: string) => useToastStore.getState().addToast({ type: 'success', message }),
  error: (message: string) => useToastStore.getState().addToast({ type: 'error', message }),
  warning: (message: string) => useToastStore.getState().addToast({ type: 'warning', message }),
  info: (message: string) => useToastStore.getState().addToast({ type: 'info', message }),
};
