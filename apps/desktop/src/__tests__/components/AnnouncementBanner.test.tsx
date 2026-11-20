import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Announcement } from '@voxium/shared';

/**
 * The announcement banner: one line, a "Read" button that opens the whole
 * announcement as plain text, and a button for the legal document the
 * announcement names (only a known one).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (k: string, o?: Record<string, unknown>) => (o?.document ? `${k}|${String(o.document)}` : k);
  return { ...actual, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

vi.mock('../../stores/serverStore', () => {
  const state = () => ({ activeServerId: null });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});

import { AnnouncementBanner } from '../../components/layout/AnnouncementBanner';
import { useAnnouncementStore } from '../../stores/announcementStore';

let container: HTMLDivElement;
let root: Root;

function make(id: string, extra: Partial<Announcement> = {}): Announcement {
  return {
    id, title: `Title ${id}`, content: 'Line one\nLine two', type: 'info', scope: 'global', serverIds: [],
    createdById: 'u1', createdByUsername: 'admin', publishedAt: new Date(0).toISOString(), expiresAt: null,
    createdAt: new Date(0).toISOString(), ...extra,
  };
}

function setAnnouncements(list: Announcement[]) {
  act(() => { useAnnouncementStore.setState({ announcements: list, dismissedIds: [] }); });
}

const dialog = () => document.querySelector('[role="dialog"][data-testid="announcement-dialog"]') as HTMLElement | null;
const buttonByText = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const readButton = () => buttonByText('notifications.announcementRead')!;
const press = (key: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
const clickEl = (el: Element) => act(() => { (el as HTMLElement).click(); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { useAnnouncementStore.setState({ announcements: [], dismissedIds: [] }); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => { root.render(<AnnouncementBanner />); });
}

describe('AnnouncementBanner: the line', () => {
  it('shows the one-line banner and a visible Read button', () => {
    setAnnouncements([make('a1')]);
    render();
    expect(container.textContent).toContain('Title a1');
    expect(readButton()).toBeTruthy();
    expect(dialog()).toBeNull();
  });

  it('renders nothing without an announcement', () => {
    render();
    expect(container.innerHTML).toBe('');
  });

  it('keeps the +N more text and the dismiss button', () => {
    setAnnouncements([make('a1'), make('a2')]);
    render();
    expect(container.textContent).toContain('notifications.announcementMore');
    clickEl(container.querySelector('button[aria-label="notifications.dismissAnnouncement"]')!);
    expect(useAnnouncementStore.getState().dismissedIds).toEqual(['a1']);
    expect(container.textContent).toContain('Title a2');
  });

  it('opening the dialog does not dismiss', () => {
    setAnnouncements([make('a1')]);
    render();
    clickEl(readButton());
    expect(useAnnouncementStore.getState().dismissedIds).toEqual([]);
  });
});

describe('AnnouncementBanner: the dialog', () => {
  it('shows the whole title and the whole content, line breaks kept', () => {
    const long = 'x'.repeat(1500);
    setAnnouncements([make('a1', { title: 'A long title '.repeat(10).trim(), content: `First\n\nSecond\n${long}` })]);
    render();
    clickEl(readButton());
    const d = dialog()!;
    expect(d).toBeTruthy();
    expect(d.getAttribute('aria-modal')).toBe('true');
    const label = document.getElementById(d.getAttribute('aria-labelledby')!)!;
    expect(label.textContent).toBe('A long title '.repeat(10).trim());
    const content = d.querySelector('[data-testid="announcement-content"]') as HTMLElement;
    expect(content.textContent).toBe(`First\n\nSecond\n${long}`);
    expect(content.className).toContain('whitespace-pre-wrap');
  });

  it('is portaled to the body and fixed', () => {
    setAnnouncements([make('a1')]);
    render();
    clickEl(readButton());
    expect(dialog()!.parentElement).toBe(document.body);
    expect(container.contains(dialog())).toBe(false);
    expect(dialog()!.className).toContain('fixed');
  });

  it('renders content as text: no markup, no link', () => {
    setAnnouncements([make('a1', { content: '<b>x</b> https://example.com [m](https://example.org) **y**' })]);
    render();
    clickEl(readButton());
    const content = dialog()!.querySelector('[data-testid="announcement-content"]') as HTMLElement;
    expect(content.textContent).toBe('<b>x</b> https://example.com [m](https://example.org) **y**');
    expect(content.querySelector('b, a, strong, img')).toBeNull();
    expect(dialog()!.querySelector('a')).toBeNull();
  });

  it('moves focus into the dialog and gives it back to Read on close', () => {
    setAnnouncements([make('a1')]);
    render();
    const read = readButton();
    read.focus();
    clickEl(read);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    press('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(read);
  });

  it('closes on Escape, on the backdrop and on the Close button, but not on a click inside', () => {
    setAnnouncements([make('a1')]);
    render();
    clickEl(readButton());
    press('Escape');
    expect(dialog()).toBeNull();

    clickEl(readButton());
    clickEl(dialog()!.querySelector('[data-testid="announcement-content"]')!);
    expect(dialog()).toBeTruthy();
    clickEl(dialog()!);
    expect(dialog()).toBeNull();

    clickEl(readButton());
    clickEl(buttonByText('common.close', dialog()!)!);
    expect(dialog()).toBeNull();
  });

  it('closes when the announcement it shows is dismissed', () => {
    setAnnouncements([make('a1'), make('a2')]);
    render();
    clickEl(readButton());
    expect(dialog()).toBeTruthy();
    act(() => { useAnnouncementStore.getState().dismissAnnouncement('a1'); });
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Title a2');
  });

  it('closes when the announcement it shows expires', () => {
    vi.useFakeTimers();
    try {
      const expiresAt = new Date(Date.now() + 5_000).toISOString();
      setAnnouncements([make('a1', { expiresAt })]);
      render();
      clickEl(readButton());
      expect(dialog()).toBeTruthy();
      act(() => { vi.advanceTimersByTime(6_000); });
      expect(dialog()).toBeNull();
      expect(container.innerHTML).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AnnouncementBanner: the legal document', () => {
  it.each([
    ['privacy', 'notifications.announcementOpenDocument|auth.register.privacyPolicy'],
    ['terms', 'notifications.announcementOpenDocument|auth.register.termsOfService'],
    ['cookies', 'notifications.announcementOpenDocument|landing.footer.cookiePolicy'],
  ] as const)('%s: a button on the line opens that document', (legalDoc, label) => {
    setAnnouncements([make('a1', { legalDoc })]);
    render();
    const button = buttonByText(label, container)!;
    expect(button).toBeTruthy();
    clickEl(button);
    expect(document.querySelector(`[data-testid="legal-doc-${legalDoc}"]`)).toBeTruthy();
    press('Escape');
    expect(document.querySelector(`[data-testid="legal-doc-${legalDoc}"]`)).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('the dialog has the same button, and Escape closes the document before the dialog', () => {
    setAnnouncements([make('a1', { legalDoc: 'terms' })]);
    render();
    clickEl(readButton());
    const label = 'notifications.announcementOpenDocument|auth.register.termsOfService';
    clickEl(buttonByText(label, dialog()!)!);
    expect(document.querySelector('[data-testid="legal-doc-terms"]')).toBeTruthy();
    press('Escape');
    expect(document.querySelector('[data-testid="legal-doc-terms"]')).toBeNull();
    expect(dialog()).toBeTruthy();
    press('Escape');
    expect(dialog()).toBeNull();
  });

  it.each([[undefined], [null], ['imprint'], ['']])('shows no document button for %j', (legalDoc) => {
    setAnnouncements([make('a1', { legalDoc: legalDoc as Announcement['legalDoc'] })]);
    render();
    expect(container.textContent).not.toContain('announcementOpenDocument');
    clickEl(readButton());
    expect(dialog()!.textContent).not.toContain('announcementOpenDocument');
  });
});
