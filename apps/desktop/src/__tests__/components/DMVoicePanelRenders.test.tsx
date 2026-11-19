import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The DM call panels draw the local user's speaking ring from the mic level,
 * which the speaking detector updates every 20 ms in ANY voice session. They
 * used to copy that level into React state on every animation frame, and the
 * sidebar panel did it before its "no DM call" early return: both sidebars'
 * panels re-rendered about 50 times a second in a voice channel, rendering
 * nothing. These count renders against a level that changes every frame.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const audio = vi.hoisted(() => ({ level: 0 }));
vi.mock('../../services/audioAnalyser', () => ({ getAudioLevel: () => audio.level }));

vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  const useVoiceStore = create(() => ({
    dmCallConversationId: null as string | null,
    dmCallUsers: [] as Array<Record<string, unknown>>,
    selfMute: false,
    selfDeaf: false,
    pttActive: false,
    dmCallPeerDevice: null,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
    leaveDMCall: vi.fn(),
  }));
  return { useVoiceStore };
});
vi.mock('../../stores/dmStore', async () => {
  const { create } = await import('zustand');
  return {
    useDMStore: create(() => ({
      conversations: [{ id: 'conv-1', participant: { id: 'peer', displayName: 'Peer' } }],
      setActiveConversation: vi.fn(),
    })),
  };
});
vi.mock('../../stores/serverStore', async () => {
  const { create } = await import('zustand');
  return { useServerStore: create(() => ({ activeServerId: 'srv-1' })) };
});
vi.mock('../../stores/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: { id: 'me' } })) };
});
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/common/Avatar', () => ({
  Avatar: ({ displayName, speaking }: { displayName: string; speaking?: boolean }) =>
    <div data-testid={`avatar-${displayName}`} data-speaking={String(Boolean(speaking))} />,
}));

import { useVoiceStore } from '../../stores/voiceStore';
import { DMVoicePanel } from '../../components/voice/DMVoicePanel';
import { DMCallPanel } from '../../components/dm/DMCallPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Animation frames, run by the test
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const requestFrame = vi.fn((cb: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, cb); return id; });
const cancelFrame = vi.fn((id: number) => { frames.delete(id); });
vi.stubGlobal('requestAnimationFrame', requestFrame);
vi.stubGlobal('cancelAnimationFrame', cancelFrame);

/** Run `count` frames, the mic level taking the next value of `levels` before each. */
function playFrames(count: number, levels: (i: number) => number) {
  for (let i = 0; i < count; i++) {
    audio.level = levels(i);
    act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(i * 16);
    });
  }
}

const me = { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false };
const peer = { ...me, id: 'peer', username: 'peer', displayName: 'Peer' };

let container: HTMLDivElement;
let root: Root;
let renders: number;

function mount(node: ReactNode) {
  act(() => {
    root.render(<Profiler id="panel" onRender={() => { renders++; }}>{node}</Profiler>);
  });
}

beforeEach(() => {
  frames.clear();
  requestFrame.mockClear();
  cancelFrame.mockClear();
  renders = 0;
  audio.level = 0;
  useVoiceStore.setState({ dmCallConversationId: null, dmCallUsers: [], selfMute: false, pttActive: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DMVoicePanel (both sidebars)', () => {
  it('with no DM call (in a voice channel, the level changing every frame): no frame loop, rendered once', () => {
    mount(<DMVoicePanel />);
    playFrames(50, (i) => (i % 2 ? 0.02 : 0.4));

    expect(container.innerHTML).toBe('');
    expect(requestFrame).not.toHaveBeenCalled();
    expect(renders).toBe(1);
  });

  it('in a DM call: re-renders only when the local user starts or stops speaking', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer] });
    mount(<DMVoicePanel />);
    const ring = () => container.querySelector('[data-testid="dm-voice-panel"] .rounded-full')!.className;
    expect(renders).toBe(1);

    playFrames(50, (i) => 0.2 + (i % 10) / 100); // speaking, the level moving every frame
    expect(renders).toBe(2);
    expect(ring()).toContain('ring-vox-voice-speaking');

    playFrames(50, (i) => (i % 10) / 1000); // silent, still moving
    expect(renders).toBe(3);
    expect(ring()).not.toContain('ring-vox-voice-speaking');
  });

  it('self-muted in a DM call (no push-to-talk held): no frame loop, the ring stays off', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer], selfMute: true });
    mount(<DMVoicePanel />);
    playFrames(20, () => 0.5);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(renders).toBe(1);
  });

  it('the call ending stops the frame loop', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer] });
    mount(<DMVoicePanel />);
    playFrames(3, () => 0.3);
    act(() => { useVoiceStore.setState({ dmCallConversationId: null, dmCallUsers: [] }); });
    expect(frames.size).toBe(0);
    requestFrame.mockClear();
    playFrames(10, () => 0.3);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});

describe('DMCallPanel (the conversation header)', () => {
  it('re-renders only when the local user starts or stops speaking, not on every frame', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer] });
    mount(<DMCallPanel />);
    const local = () => container.querySelector('[data-testid="avatar-Me"]')!.getAttribute('data-speaking');
    expect(renders).toBe(1);

    playFrames(50, (i) => 0.2 + (i % 10) / 100);
    expect(renders).toBe(2);
    expect(local()).toBe('true');

    playFrames(50, () => 0.01);
    expect(renders).toBe(3);
    expect(local()).toBe('false');
  });

  it('reads the voice store field by field: other voice events (latency, other channels\' speaking) do not re-render it', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer] });
    mount(<DMCallPanel />);
    expect(renders).toBe(1);
    act(() => { useVoiceStore.setState({ latency: 42 } as never); });
    act(() => { useVoiceStore.setState({ channelUsers: new Map([['ch-x', []]]) } as never); });
    act(() => { useVoiceStore.setState({ latency: 43 } as never); });
    expect(renders).toBe(1);
    // A field it shows still does
    act(() => { useVoiceStore.setState({ selfDeaf: true }); });
    expect(renders).toBe(2);
  });

  it('push-to-talk held while muted still lights the ring', () => {
    useVoiceStore.setState({ dmCallConversationId: 'conv-1', dmCallUsers: [me, peer], selfMute: true, pttActive: true });
    mount(<DMCallPanel />);
    playFrames(5, () => 0.5);
    expect(container.querySelector('[data-testid="avatar-Me"]')!.getAttribute('data-speaking')).toBe('true');
  });
});
