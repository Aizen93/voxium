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
  isShareActivationInFlight: () => false,
}));

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api: apiMock }));

const snap = vi.hoisted(() => ({
  composeSnapshotCanvas: vi.fn(),
  encodeSnapshot: vi.fn(),
  encodeSnapshotPng: vi.fn(),
}));
vi.mock('../../utils/shareSnapshot', () => snap);

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}:${opts.name}` : key) }) };
});

import { AxiosError } from 'axios';
import { SnapshotMenu } from '../../components/voice/SnapshotMenu';
import { useAnnotationStore } from '../../stores/annotationStore';
import { activateSecurePins, deactivateSecurePins, forgetSecurePins, pinSecure } from '../../utils/securePins';

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

const TARGETS_URL = '/servers/server-1/channels/attachment-targets';
const LIST_URL = '/servers/server-1/channels';
const httpError = (status: number, error: string) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, { status, data: { success: false, error } } as never);
/** The API as the picker sees it: one answer per URL (a URL not listed is a 404). */
function givenApi(routes: Record<string, unknown>) {
  apiMock.get.mockImplementation((url: string) => {
    const answer = routes[url];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined) return Promise.reject(httpError(404, 'Not found'));
    return Promise.resolve({ data: { data: answer } });
  });
}
async function openPicker() {
  render();
  act(() => button().click());
  await act(async () => {
    (document.querySelector('[data-testid="snapshot-send-to"]') as HTMLButtonElement).click();
  });
  await flush();
}
const channelList = () => document.querySelector('[data-testid="snapshot-channel-list"]')!;
const listed = () => Array.from(channelList().querySelectorAll('[data-channel-id]')).map((b) => b.getAttribute('data-channel-id'));

const button = () => container.querySelector('[data-testid="snapshot-button"]') as HTMLButtonElement;
const menu = () => document.querySelector('[data-testid="snapshot-menu"]');

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  useAnnotationStore.setState({ masks: [], scene: { objects: [] }, selectedObjectId: null, sourceChangeHold: null });
  voiceState.localUserId = 'viewer-1';
  voiceState.screenSharingUserId = 'sharer-1';
  voiceState.isScreenSharing = false;
  socketEmit.mockClear();
  toastError.mockClear();
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  snap.composeSnapshotCanvas.mockReset().mockReturnValue(fakeCanvas);
  snap.encodeSnapshot.mockReset().mockResolvedValue({ size: 12_345, type: 'image/webp' } as Blob);
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

  it('the SHARER cannot snapshot during a source-change hold — the export path respects the pause', () => {
    voiceState.localUserId = 'sharer-1'; // I am the sharer
    useAnnotationStore.setState({ sourceChangeHold: { fromW: 1920, fromH: 1080, toW: 1280, toH: 720 } });
    render();
    act(() => button().click());
    expect(menu()).toBeNull();
    expect(snap.composeSnapshotCanvas).not.toHaveBeenCalled(); // no export of stale-mask geometry
  });

  it('a sharer with a stale/null localUserId still burns the masks — isScreenSharing is the truth', () => {
    const masks = [{ id: 'm1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    useAnnotationStore.setState({ masks });
    voiceState.localUserId = null as never; // the id comparison would misclassify
    voiceState.isScreenSharing = true;
    render();
    act(() => button().click());
    expect(snap.composeSnapshotCanvas).toHaveBeenCalledWith(videoRef.current, expect.anything(), masks, expect.anything());
    expect(socketEmit).not.toHaveBeenCalled(); // and tells nobody — they are the sharer
  });

  it('Send to channel: a channel PINNED as secure on this device is not a target, even listed without the flag', async () => {
    activateSecurePins('viewer-1');
    pinSecure('ch-flipped');
    try {
      givenApi({
        [TARGETS_URL]: [
          { id: 'ch-text', name: 'general', categoryId: null, position: 0 },
          // The server downgraded it: a plaintext snapshot there would be a leak
          { id: 'ch-flipped', name: 'vault', categoryId: null, position: 1 },
        ],
      });
      await openPicker();
      expect(listed()).toEqual(['ch-text']);
    } finally {
      deactivateSecurePins();
      forgetSecurePins('viewer-1');
    }
  });

  it('Send to channel: the picker lists exactly what the attachment-targets route answers, for the VOICE server; the send reuses the attachment pipeline', async () => {
    givenApi({
      [TARGETS_URL]: [
        { id: 'ch-text', name: 'general', categoryId: null, position: 0 },
        { id: 'ch-pics', name: 'pictures', categoryId: 'cat-1', position: 1 },
      ],
    });
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { uploadUrl: 'https://s3/put-url', key: 'attachments/snap.webp' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'msg-1' } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await openPicker();
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(apiMock.get).toHaveBeenCalledWith(TARGETS_URL); // the VOICE server, never serverStore.channels
    expect(listed()).toEqual(['ch-text', 'ch-pics']);

    await act(async () => {
      (channelList().querySelector('[data-channel-id="ch-text"]') as HTMLButtonElement).click();
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

  it('a server without the route (404) falls back to the plain channel list: text channels only, secure ones left out', async () => {
    givenApi({
      [LIST_URL]: [
        { id: 'ch-text', name: 'general', type: 'text' },
        { id: 'ch-secure', name: 'vault', type: 'text', secure: true },
        { id: 'ch-voice', name: 'lounge', type: 'voice' },
      ],
    });
    await openPicker();
    expect(apiMock.get).toHaveBeenNthCalledWith(1, TARGETS_URL);
    expect(apiMock.get).toHaveBeenNthCalledWith(2, LIST_URL);
    expect(listed()).toEqual(['ch-text']);
  });

  it('no channel to post in: the empty state', async () => {
    givenApi({ [TARGETS_URL]: [] });
    await openPicker();
    expect(listed()).toEqual([]);
    expect(channelList().textContent).toBe('voice.snapshot.noChannels');
  });

  it('a failing route (not a 404) shows the empty state and never falls back to the wider list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    givenApi({ [TARGETS_URL]: httpError(403, 'Not a member of this server'), [LIST_URL]: [{ id: 'ch-text', name: 'general', type: 'text' }] });
    await openPicker();
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(channelList().textContent).toBe('voice.snapshot.noChannels');
    warn.mockRestore();
  });

  it('a refusal that still happens (permissions changed meanwhile) shows the reason of the server in the language of the user, not "Snapshot failed"', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    givenApi({ [TARGETS_URL]: [{ id: 'ch-text', name: 'general', categoryId: null, position: 0 }] });
    apiMock.post.mockRejectedValueOnce(httpError(403, 'You do not have permission to attach files in this channel'));
    await openPicker();
    await act(async () => {
      (channelList().querySelector('[data-channel-id="ch-text"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('serverErrors.noPermissionAttachFiles');
    expect(menu()).not.toBeNull(); // stays open: pick another channel
    errSpy.mockRestore();
  });

  it('a send refused at the message POST says so too; an unmapped failure keeps the generic message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    givenApi({ [TARGETS_URL]: [{ id: 'ch-text', name: 'general', categoryId: null, position: 0 }] });
    apiMock.post
      .mockResolvedValueOnce({ data: { data: { uploadUrl: 'https://s3/put-url', key: 'k' } } })
      .mockRejectedValueOnce(httpError(403, 'You do not have permission to send messages in this channel'));
    await openPicker();
    const send = async () => {
      await act(async () => {
        (channelList().querySelector('[data-channel-id="ch-text"]') as HTMLButtonElement).click();
      });
      await flush();
    };
    await send();
    expect(toastError).toHaveBeenLastCalledWith('serverErrors.noPermissionSendMessages');

    toastError.mockClear();
    apiMock.post.mockResolvedValueOnce({ data: { data: { uploadUrl: 'https://s3/put-url', key: 'k' } } }).mockRejectedValueOnce(new Error('socket hang up'));
    await send();
    expect(toastError).toHaveBeenLastCalledWith('voice.snapshot.failed');
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('a failed S3 PUT surfaces an error and never posts the message', async () => {
    givenApi({ [TARGETS_URL]: [{ id: 'ch-text', name: 'general', categoryId: null, position: 0 }] });
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
