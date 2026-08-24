import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A REAL zustand store stands in for voiceStore — the modal must re-render
// when pendingShare changes, which a plain callable mock cannot do.
vi.mock('../../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  const useVoiceStore = create(() => ({
    pendingShare: null as { stream: MediaStream; sourceKey: string | null; displaySurface: string } | null,
    activeChannelId: 'chan-1' as string | null,
    isScreenSharing: false,
    localUserId: 'me' as string | null,
    screenShareSourceKey: null as string | null,
    screenSharingUserId: null as string | null,
    screenStream: null,
    confirmPendingShare: vi.fn().mockResolvedValue(undefined),
    cancelPendingShare: vi.fn(),
  }));
  return { useVoiceStore, registerShareMaskHooks: vi.fn(), isShareActivationInFlight: () => false };
});

vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: vi.fn() }),
}));
vi.mock('../../services/screenComposite', () => ({
  ensureComposite: vi.fn(), stopComposite: vi.fn(), teardownComposite: vi.fn(), isCompositing: () => false,
  resumeSourceHold: vi.fn(), prepareComposite: vi.fn(), attachCompositeProducerHandles: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { SharePreflightModal } from '../../components/voice/SharePreflightModal';
import { useVoiceStore } from '../../stores/voiceStore';
const voiceMock = { useVoiceStore: useVoiceStore as unknown as typeof useVoiceStore & { setState: (p: object) => void } };
import { useAnnotationStore } from '../../stores/annotationStore';
import { useMaskLayoutStore } from '../../stores/maskLayoutStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialAnnotation = useAnnotationStore.getState();

function fakeStream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [], active: true } as unknown as MediaStream;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => { root.render(<SharePreflightModal />); });
}

function openPreflight(displaySurface = 'window') {
  act(() => {
    voiceMock.useVoiceStore.setState({ pendingShare: { stream: fakeStream(), sourceKey: 'window:1280x720', displaySurface } });
  });
}

const modal = () => document.querySelector('[data-testid="share-preflight"]');

beforeEach(() => {
  useAnnotationStore.setState({ ...initialAnnotation, activeTool: 'pen', masks: [] }, true);
  useMaskLayoutStore.setState({ appliedLayout: null });
  voiceMock.useVoiceStore.setState({ pendingShare: null, activeChannelId: 'chan-1' });
  vi.mocked(voiceMock.useVoiceStore.getState().cancelPendingShare).mockClear();
  vi.mocked(voiceMock.useVoiceStore.getState().confirmPendingShare).mockClear();
  localStorage.removeItem('vox:annotations:prefs');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('vox:annotations:prefs');
});

describe('SharePreflightModal', () => {
  it('renders nothing without a pending share, and the full modal with one — mask tool preselected', () => {
    render();
    expect(modal()).toBeNull();
    openPreflight();
    expect(modal()).not.toBeNull();
    expect(useAnnotationStore.getState().activeTool).toBe('mask');
    expect(modal()!.querySelector('[data-testid="preflight-go-live"]')).not.toBeNull();
    expect(modal()!.querySelector('[data-testid="preflight-monitor-nudge"]')).toBeNull(); // a window capture
  });

  it('a whole-monitor capture always carries the nudge', () => {
    render();
    openPreflight('monitor');
    expect(modal()!.querySelector('[data-testid="preflight-monitor-nudge"]')).not.toBeNull();
  });

  it('Go live confirms; Cancel and Escape cancel', () => {
    render();
    openPreflight();
    act(() => { (modal()!.querySelector('[data-testid="preflight-go-live"]') as HTMLButtonElement).click(); });
    expect(voiceMock.useVoiceStore.getState().confirmPendingShare).toHaveBeenCalledTimes(1);

    act(() => { (modal()!.querySelector('[data-testid="preflight-cancel"]') as HTMLButtonElement).click(); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalledTimes(1);

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalledTimes(2);
  });

  it('leaving voice mid-pre-flight abandons it', () => {
    render();
    openPreflight();
    act(() => { voiceMock.useVoiceStore.setState({ activeChannelId: null }); });
    expect(voiceMock.useVoiceStore.getState().cancelPendingShare).toHaveBeenCalled();
  });

  it('the skip checkbox persists — and the whole-screen warning is documented as staying', () => {
    render();
    openPreflight();
    const box = modal()!.querySelector('[data-testid="preflight-skip"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    act(() => { box.click(); });
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ skipPreflight: true });
    act(() => { box.click(); });
    expect(JSON.parse(localStorage.getItem('vox:annotations:prefs')!)).toMatchObject({ skipPreflight: false });
  });

  it('shows the applied-layout banner with Start fresh wired to the layout store', () => {
    useAnnotationStore.setState({ masks: [{ id: 'applied-1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] });
    useMaskLayoutStore.setState({ appliedLayout: { key: 'window:1280x720', count: 1, ids: ['applied-1'] } });
    render();
    openPreflight();
    expect(modal()!.querySelector('[data-testid="preflight-layout-banner"]')).not.toBeNull();
    act(() => { (modal()!.querySelector('[data-testid="preflight-layout-banner"] button') as HTMLButtonElement).click(); });
    expect(useAnnotationStore.getState().masks).toEqual([]);
    expect(useMaskLayoutStore.getState().appliedLayout).toBeNull();
  });

  it('mask style picks set the default for the masks about to be drawn', () => {
    render();
    openPreflight();
    act(() => { (modal()!.querySelector('[data-preflight-style="pixelate"]') as HTMLButtonElement).click(); });
    expect(useAnnotationStore.getState().maskStyle).toBe('pixelate');
    useAnnotationStore.setState({ maskStyle: 'cover' });
  });
});
