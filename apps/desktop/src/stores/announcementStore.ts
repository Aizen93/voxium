import { create } from 'zustand';
import type { Announcement } from '@voxium/shared';

const STORAGE_KEY = 'voxium_dismissed_announcements';

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveDismissed(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

interface AnnouncementState {
  announcements: Announcement[];
  dismissedIds: string[];
  initAnnouncements: (list: Announcement[]) => void;
  addAnnouncement: (ann: Announcement) => void;
  dismissAnnouncement: (id: string) => void;
  clearAll: () => void;
}

export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  announcements: [],
  dismissedIds: loadDismissed(),

  initAnnouncements: (list) => {
    const existing = get().announcements;
    const existingIds = new Set(existing.map((a) => a.id));
    const merged = [...existing];
    for (const ann of list) {
      if (!existingIds.has(ann.id)) merged.push(ann);
    }
    set({ announcements: merged });
  },

  addAnnouncement: (ann) => {
    const existing = get().announcements;
    if (existing.some((a) => a.id === ann.id)) return;
    set({ announcements: [ann, ...existing] });
  },

  dismissAnnouncement: (id) => {
    const current = get().dismissedIds;
    if (current.includes(id)) return;
    const dismissed = [...current, id];
    saveDismissed(dismissed);
    set({ dismissedIds: dismissed });
  },

  clearAll: () => {
    set({ announcements: [] });
  },
}));
