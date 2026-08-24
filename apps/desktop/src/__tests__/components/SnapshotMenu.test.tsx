import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const socketEmit = vi.hoisted(() => vi.fn());
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn().mockReturnValue({ emit: socketEmit }),
}));

const voiceState = vi.hoisted(() => ({
  activeChannelId: 'voice-1',
  activeVoiceServerId: 'server-1',
  screenSharingUserId: 'sharer-1',
  localUserId: 'viewer-1',
  isScreenSharing: false,
  screenStream: null as unknown,
  pendingShare: null as unknown,
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => voiceState, subscribe: () => () => {} },
  registerShareMaskHooks: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api: apiMock }));

const snap = vi.hoisted(() => ({
  composeSnapshotCanvas: vi.fn(),
  encodeSnapshot: vi.fn(),
  encodeSnapshotPng: vi.fn(),
}));
vi.mock('../../utils/shareSnapshot', () => snap);

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}:${opts.name}` : key) }) };
});

import { SnapshotMenu } from '../../components/voice/SnapshotMenu';
import { useAnnotationStore } from '../../stores/annotationStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const videoRef = { current: {} as HTMLVideoElement };
const fakeCanvas = {} as HTMLCanvasElement;

function render() {
  act(() => {
    root.render(<SnapshotMenu videoRef={videoRef} sharerName="Alice" />);
  });
}

const button = () => container.querySelector('[data-testid="snapshot-button"]') as HTMLButtonElement;
const menu = () => document.querySelector('[data-testid="snapshot-menu"]');

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  useAnnotationStore.setState({ masks: [], scene: { objects: [] }, selectedObjectId: null });
  voiceState.localUserId = 'viewer-1';
  voiceState.screenSharingUserId = 'sharer-1';
  socketEmit.mockClear();
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  snap.composeSnapshotCanvas.mockReset().mockReturnValue(fakeCanvas);
  snap.encodeSnapshot.mockReset().mockResolvedValue({ size: 12_345 } as Blob);
  snap.encodeSnapshotPng.mockReset().mockResolvedValue({ size: 9_999 } as Blob);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SnapshotMenu', () => {
  it('a VIEWER captures without the mask pass (their stream has masks baked in) and the sharer is told', () => {
    useAnnotationStore.setState({ masks: [{ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] });
    render();
    act(() => button().click());
    expect(menu()).not.toBeNull();
    expect(snap.composeSnapshotCanvas).toHaveBeenCalledWith(videoRef.current, expect.anything(), [], expect.anything());
    // Courtesy notice went out on the live plane
    expect(socketEmit).toHaveBeenCalledWith('voice:annotation:live', { channelId: 'voice-1', ev: { k: 'snapshot' } });
  });

  it('the SHARER captures WITH their current masks burned in, and tells nobody', () => {
    const masks = [{ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    useAnnotationStore.setState({ masks });
    voiceState.localUserId = 'sharer-1'; // I am the sharer
    render();
    act(() => button().click());
    expect(snap.composeSnapshotCanvas).toHaveBeenCalledWith(videoRef.current, expect.anything(), masks, expect.anything());
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('Send to channel: picker excludes secure and voice channels; the send reuses the attachment pipeline', async () => {
    apiMock.get.mockResolvedValue({
      data: {
        data: [
          { id: 'ch-text', name: 'general', type: 'text' },
          { id: 'ch-secure', name: 'vault', type: 'text', secure: true },
          { id: 'ch-voice', name: 'lounge', type: 'voice' },
        ],
      },
    });
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { uploadUrl: 'https://s3/put-url', key: 'attachments/snap.webp' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'msg-1' } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render();
    act(() => button().click());
    await act(async () => {
      (document.querySelector('[data-testid="snapshot-send-to"]') as HTMLButtonElement).click();
    });
    await flush();
    const list = document.querySelector('[data-testid="snapshot-channel-list"]')!;
    expect(apiMock.get).toHaveBeenCalledWith('/servers/server-1/channels'); // the VOICE server, never serverStore.channels
    expect(list.querySelectorAll('[data-channel-id]')).toHaveLength(1);
    expect(list.querySelector('[data-channel-id="ch-secure"]')).toBeNull();
    expect(list.querySelector('[data-channel-id="ch-voice"]')).toBeNull();

    await act(async () => {
      (list.querySelector('[data-channel-id="ch-text"]') as HTMLButtonElement).click();
    });
    await flush();

    // presign → S3 PUT → message, with matching key/meta throughout
    expect(apiMock.post).toHaveBeenCalledWith('/uploads/presign/attachment', expect.objectContaining({
      channelId: 'ch-text',
      mimeType: 'image/webp',
      fileSize: 12_345,
    }));
    expect(fetchMock).toHaveBeenCalledWith('https://s3/put-url', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
    }));
    expect(apiMock.post).toHaveBeenCalledWith('/channels/ch-text/messages', expect.objectContaining({
      content: 'voice.snapshot.caption:Alice',
      attachments: [expect.objectContaining({ s3Key: 'attachments/snap.webp', mimeType: 'image/webp', fileSize: 12_345 })],
    }));
    expect(menu()).toBeNull(); // closed on success
    vi.unstubAllGlobals();
  });

  it('a failed S3 PUT surfaces an error and never posts the message', async () => {
    apiMock.get.mockResolvedValue({ data: { data: [{ id: 'ch-text', name: 'general', type: 'text' }] } });
    apiMock.post.mockResolvedValueOnce({ data: { data: { uploadUrl: 'https://s3/put-url', key: 'k' } } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render();
    act(() => button().click());
    await act(async () => {
      (document.querySelector('[data-testid="snapshot-send-to"]') as HTMLButtonElement).click();
    });
    await flush();
    await act(async () => {
      (document.querySelector('[data-channel-id="ch-text"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(apiMock.post).toHaveBeenCalledTimes(1); // presign only — no message with a broken key
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('Copy encodes PNG for the clipboard', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });

    render();
    act(() => button().click());
    await act(async () => {
      (document.querySelector('[data-testid="snapshot-copy"]') as HTMLButtonElement).click();
    });
    expect(snap.encodeSnapshotPng).toHaveBeenCalledWith(fakeCanvas);
    expect(write).toHaveBeenCalled();
    expect(menu()).toBeNull();
    vi.unstubAllGlobals();
  });
});
