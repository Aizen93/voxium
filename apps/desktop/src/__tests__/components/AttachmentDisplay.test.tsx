import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Attachment } from '@voxium/shared';

/**
 * Images are fetched when their row renders; a video or audio file is fetched
 * only when the person asks to play it, through the API client (the token
 * stays in the Authorization header, nothing is put in an address).
 */

const h = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, o?: { name?: string }) => (o?.name ? `${k}:${o.name}` : k),
    }),
  };
});
vi.mock('../../services/api', () => ({ api: { get: h.apiGet } }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));

import { AttachmentDisplay } from '../../components/chat/AttachmentDisplay';
import { resetMediaCache } from '../../services/mediaBlobCache';
import { resetAccountStores } from '../../stores/resetStores';

let n = 0;
function att(over: Partial<Attachment> = {}): Attachment {
  n += 1;
  return {
    id: `att-${n}`,
    fileName: 'clip.mp4',
    fileSize: 2048,
    mimeType: 'video/mp4',
    s3Key: `attachments/secret-key-${n}-clip.mp4`,
    expired: false,
    ...over,
  } as Attachment;
}

let root: Root;
let host: HTMLDivElement;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  resetMediaCache();
  h.apiGet.mockReset();
  h.apiGet.mockResolvedValue({ data: new Blob(['x']) });
  created.length = 0;
  revoked.length = 0;
  let u = 0;
  URL.createObjectURL = vi.fn(() => {
    u += 1;
    const url = `blob:test/${u}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function render(a: Attachment) {
  await act(async () => {
    root.render(<AttachmentDisplay attachment={a} />);
  });
}
function remount() {
  act(() => root.unmount());
  root = createRoot(host);
}
const button = () => host.querySelector('button') as HTMLButtonElement;
async function click() {
  await act(async () => {
    button().click();
  });
}

describe('AttachmentDisplay media fetching', () => {
  it('fetches an image when it renders', async () => {
    const a = att({ fileName: 'p.png', mimeType: 'image/png' });
    await render(a);
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith(`/uploads/${a.s3Key}`, { responseType: 'blob' });
    expect(host.querySelector('img')).not.toBeNull();
  });

  it.each([
    ['video', 'video/mp4'],
    ['audio', 'audio/mpeg'],
  ])('does not fetch a %s on render, then fetches it once on activation', async (tag, mime) => {
    const a = att({ mimeType: mime, fileName: `f.${tag}` });
    await render(a);
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(host.querySelector(tag)).toBeNull();
    expect(button().getAttribute('aria-label')).toBe(`attachment.play:f.${tag}`);
    expect(host.textContent).toContain('f.' + tag);
    expect(host.textContent).toContain('2.0 KB');
    expect(host.textContent).toContain(mime);

    await click();
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith(`/uploads/${a.s3Key}`, { responseType: 'blob' });
    const el = host.querySelector(tag) as HTMLMediaElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute('src')).toBe(created[0]);
    expect(el.autoplay).toBe(true);
  });

  it('keeps the same button while loading and does not fetch again on a second activation', async () => {
    let resolve!: (v: { data: Blob }) => void;
    h.apiGet.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render(att());
    const b = button();
    b.focus();
    await click();
    expect(button()).toBe(b);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe('attachment.loadingVideo');
    expect(document.activeElement).toBe(b);
    await click();
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ data: new Blob(['x']) });
    });
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('fetches once for two activations in the same tick', async () => {
    await render(att());
    const b = button();
    await act(async () => {
      b.click();
      b.click();
    });
    expect(h.apiGet).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the player after the person started the load', async () => {
    await render(att());
    button().focus();
    await click();
    expect(document.activeElement).toBe(host.querySelector('video'));
  });

  it('does not autoplay or take focus for a player remounted from the cache', async () => {
    const a = att();
    await render(a);
    await click();
    expect((host.querySelector('video') as HTMLVideoElement).autoplay).toBe(true);
    remount();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    await render(a);
    expect((host.querySelector('video') as HTMLVideoElement).autoplay).toBe(false);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('never renders nothing between a cached blob and its URL', async () => {
    const a = att();
    await render(a);
    await click();
    remount();
    // The first render from the cache, before any effect has run
    const { renderToString } = await import('react-dom/server');
    expect(renderToString(<AttachmentDisplay attachment={a} />)).toContain('<button');
  });

  it('shows a failed fetch, logs one warning without the key or address, and fetches again on retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = att();
    h.apiGet.mockRejectedValueOnce(new Error('Network Error'));
    await render(a);
    await click();
    expect(host.textContent).toContain('attachment.loadFailed');
    expect(host.textContent).toContain('attachment.retry');
    expect(host.querySelector('[role="status"]')!.textContent).toBe('attachment.loadFailed');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Network Error');
    expect(logged).not.toContain(a.s3Key);
    expect(logged).not.toContain('secret-key');
    expect(logged).not.toContain('/uploads/');

    await click();
    expect(h.apiGet).toHaveBeenCalledTimes(2);
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('keeps focus on the same button when the fetch fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.apiGet.mockRejectedValueOnce(new Error('boom'));
    await render(att());
    const b = button();
    b.focus();
    await click();
    expect(button()).toBe(b);
    expect(document.activeElement).toBe(b);
  });

  it('sets no state and logs nothing when it unmounts in the middle of a fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject!: (e: Error) => void;
    h.apiGet.mockReturnValue(new Promise((_r, rj) => { reject = rj; }));
    await render(att());
    await click();
    remount();
    await act(async () => {
      reject(new Error('late'));
    });
    expect(warn).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => String(c[0])).filter((m) => !m.includes('act('))).toEqual([]);
  });

  it('logs a failed image fetch once, with the message and without the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.apiGet.mockRejectedValueOnce(new Error('Network Error'));
    await render(att({ mimeType: 'image/png', fileName: 'p.png' }));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Network Error');
    expect(logged).not.toContain('secret-key');
    expect(logged).not.toContain('/uploads/');
  });

  it('revokes the blob URL on unmount', async () => {
    await render(att());
    await click();
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);
    remount();
    expect(revoked).toEqual(created);
  });

  it('revokes exactly the URLs it made under StrictMode', async () => {
    await act(async () => {
      root.render(<StrictMode><AttachmentDisplay attachment={att()} /></StrictMode>);
    });
    await click();
    remount();
    expect(created.length).toBeGreaterThan(0);
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it('does not fetch again when a loaded file comes back on screen', async () => {
    const a = att();
    await render(a);
    await click();
    remount();
    await render(a);
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('fetches again after the account stores are reset (logout)', async () => {
    const a = att();
    await render(a);
    await click();
    resetAccountStores();
    remount();
    await render(a);
    expect(host.querySelector('video')).toBeNull();
    await click();
    expect(h.apiGet).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing for an expired attachment', async () => {
    await render(att({ expired: true }));
    await render(att({ expired: true, mimeType: 'audio/mpeg' }));
    await render(att({ expired: true, mimeType: 'image/png' }));
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(host.textContent).toContain('attachment.expired');
  });

  it('shows the download card when the video player cannot decode the file', async () => {
    await render(att());
    await click();
    await act(async () => {
      host.querySelector('video')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('button')).not.toBeNull();
  });

  it('shows the download card when the audio player cannot decode the file', async () => {
    await render(att({ mimeType: 'audio/mpeg', fileName: 'a.mp3' }));
    await click();
    await act(async () => {
      host.querySelector('audio')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('audio')).toBeNull();
    expect(host.querySelector('button')).not.toBeNull();
    expect(host.textContent).toContain('a.mp3');
  });

  it('puts no address and no token in the DOM', async () => {
    await render(att());
    await click();
    const html = host.innerHTML;
    expect(html).not.toContain('/uploads/');
    expect(html).not.toContain('token');
    expect(html).not.toContain('secret-key');
    expect(html).not.toContain('Bearer');
    expect(host.querySelector('video')!.getAttribute('src')).toMatch(/^blob:/);
  });
});
