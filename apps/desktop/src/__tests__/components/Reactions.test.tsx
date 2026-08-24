import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const socketEmit = vi.hoisted(() => vi.fn());
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: socketEmit }),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => ({ activeChannelId: 'chan-1', screenSharingUserId: 'sharer', isScreenSharing: false, screenStream: null, localUserId: 'me', pendingShare: null }),
    subscribe: () => () => {},
  },
  registerShareMaskHooks: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { ANNOTATION_REACTIONS } from '@voxium/shared';
import { ReactionStrip, ReactionOverlay } from '../../components/voice/Reactions';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(el: React.ReactElement) {
  act(() => root.render(el));
}

beforeEach(() => {
  vi.useFakeTimers();
  useAnnotationStore.setState({ showReactions: true });
  useAnnotationLiveStore.getState().clear();
  socketEmit.mockClear();
  localStorage.removeItem('vox:annotations:prefs');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  localStorage.removeItem('vox:annotations:prefs');
});

describe('ReactionStrip', () => {
  it('renders one button per allowlisted emoji and sends the INDEX on click', () => {
    render(<ReactionStrip />);
    const buttons = container.querySelectorAll('[data-reaction-index]');
    expect(buttons).toHaveLength(ANNOTATION_REACTIONS.length);
    act(() => {
      (buttons[2] as HTMLButtonElement).click();
    });
    expect(socketEmit).toHaveBeenCalledWith('voice:annotation:live', { channelId: 'chan-1', ev: { k: 'reaction', e: 2 } });
    // …and the local echo landed without waiting for the wire
    expect(useAnnotationLiveStore.getState().reactions).toHaveLength(1);
    expect(useAnnotationLiveStore.getState().reactions[0].e).toBe(2);
  });

  it('paces sends locally under the server bucket (1/s), local echo included', () => {
    render(<ReactionStrip />);
    const button = container.querySelector('[data-reaction-index="0"]') as HTMLButtonElement;
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    expect(socketEmit).toHaveBeenCalledTimes(1);
    expect(useAnnotationLiveStore.getState().reactions).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1_100);
      button.click();
    });
    expect(socketEmit).toHaveBeenCalledTimes(2);
  });

  it('the eye toggle flips and persists the device pref', () => {
    render(<ReactionStrip />);
    const toggle = container.querySelector('[data-testid="reaction-visibility-toggle"]') as HTMLButtonElement;
    act(() => toggle.click());
    expect(useAnnotationStore.getState().showReactions).toBe(false);
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ showReactions: false });
    act(() => toggle.click());
    expect(useAnnotationStore.getState().showReactions).toBe(true);
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ showReactions: true });
  });
});

describe('ReactionOverlay', () => {
  it('renders each in-flight reaction as a DOM emoji (never canvas) and hides with the pref', () => {
    act(() => {
      useAnnotationLiveStore.getState().receive('user-a', { k: 'reaction', e: 0 });
      useAnnotationLiveStore.getState().receive('user-b', { k: 'reaction', e: 3 });
    });
    render(<ReactionOverlay />);
    const overlay = container.querySelector('[data-testid="reaction-overlay"]')!;
    expect(overlay).not.toBeNull();
    const spans = overlay.querySelectorAll('.vox-reaction');
    expect(spans).toHaveLength(2);
    expect(spans[0].textContent).toBe(ANNOTATION_REACTIONS[0]);
    expect(spans[1].textContent).toBe(ANNOTATION_REACTIONS[3]);
    // The rise/drift are per-element custom properties consumed by the CSS
    // animation (reduced motion swaps the keyframes in CSS, not in JS)
    expect((spans[0] as HTMLElement).style.getPropertyValue('--vox-reaction-rise')).toMatch(/px$/);

    act(() => {
      useAnnotationStore.getState().setShowReactions(false);
    });
    expect(container.querySelector('[data-testid="reaction-overlay"]')).toBeNull();
  });

  it('renders nothing with no reactions in flight', () => {
    render(<ReactionOverlay />);
    expect(container.querySelector('[data-testid="reaction-overlay"]')).toBeNull();
  });

  it('an out-of-range index from a hostile peer renders as nothing, not undefined', () => {
    act(() => {
      // The server rejects these; defence in depth if one ever got through
      useAnnotationLiveStore.setState({ reactions: [{ id: 'rX', userId: 'evil', e: 99, at: Date.now() }] });
    });
    render(<ReactionOverlay />);
    const span = container.querySelector('.vox-reaction')!;
    expect(span.textContent).toBe('');
  });
});
