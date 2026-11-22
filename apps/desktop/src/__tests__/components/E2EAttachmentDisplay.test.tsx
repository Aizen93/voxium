import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { E2EAttachmentMeta } from '@voxium/shared';

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  initEngine: vi.fn(),
  decryptAttachment: vi.fn(),
}));

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
vi.mock('../../services/e2e/engine', () => ({
  initEngine: h.initEngine,
  decryptAttachment: h.decryptAttachment,
}));

import { E2EAttachmentDisplay } from '../../components/chat/E2EAttachmentDisplay';

let n = 0;
function meta(over: Partial<E2EAttachmentMeta> = {}): E2EAttachmentMeta {
  n += 1;
  return {
    s3Key: `attachments/secret-key-${n}.bin`,
    key: 'k',
    iv: 'i',
    fileName: 'clip.mp4',
    fileSize: 2048,
    mimeType: 'video/mp4',
    ...over,
  } as E2EAttachmentMeta;
}

let root: Root;
let host: HTMLDivElement;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  h.apiGet.mockReset();
  h.apiGet.mockResolvedValue({ data: new ArrayBuffer(4) });
  h.initEngine.mockReset();
  h.initEngine.mockResolvedValue(undefined);
  h.decryptAttachment.mockReset();
  h.decryptAttachment.mockReturnValue(new Uint8Array([1, 2, 3]));
  created.length = 0;
  revoked.length = 0;
  let u = 0;
  URL.createObjectURL = vi.fn(() => {
    u += 1;
    created.push(`blob:e2e/${u}`);
    return `blob:e2e/${u}`;
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

async function render(m: E2EAttachmentMeta) {
  await act(async () => {
    root.render(<E2EAttachmentDisplay meta={m} />);
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

describe('E2EAttachmentDisplay', () => {
  it('fetches and decrypts an image on mount', async () => {
    await render(meta({ mimeType: 'image/png', fileName: 'p.png' }));
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.decryptAttachment).toHaveBeenCalledTimes(1);
    expect(host.querySelector('img')).not.toBeNull();
  });

  it.each([
    ['video', 'video/mp4'],
    ['audio', 'audio/mpeg'],
  ])('fetches and decrypts a %s only on activation, once', async (tag, mime) => {
    const m = meta({ mimeType: mime });
    await render(m);
    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.initEngine).not.toHaveBeenCalled();
    expect(h.decryptAttachment).not.toHaveBeenCalled();
    await click();
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith(`/uploads/${m.s3Key}`, { responseType: 'arraybuffer' });
    expect(h.decryptAttachment).toHaveBeenCalledTimes(1);
    expect(h.decryptAttachment).toHaveBeenCalledWith(expect.any(Uint8Array), 'k', 'i');
    expect(host.querySelector(tag)).not.toBeNull();
  });

  it('decrypts again after a remount (decrypted bytes are not kept)', async () => {
    const m = meta();
    await render(m);
    await click();
    remount();
    await render(m);
    expect(host.querySelector('video')).toBeNull();
    await click();
    expect(h.decryptAttachment).toHaveBeenCalledTimes(2);
  });

  it('logs a failure by message only and offers a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.decryptAttachment.mockImplementationOnce(() => {
      throw new Error('GCM failure');
    });
    await render(meta());
    await click();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('GCM failure');
    expect(logged).not.toContain('secret-key');
    expect(host.textContent).toContain('attachment.loadFailed');
    await click();
    expect(h.decryptAttachment).toHaveBeenCalledTimes(2);
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('logs a failed image load without the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.apiGet.mockRejectedValueOnce(new Error('Network Error'));
    await render(meta({ mimeType: 'image/png' }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('Network Error');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key');
  });

  it('falls back to the failure notice when the player cannot decode', async () => {
    await render(meta());
    await click();
    await act(async () => {
      host.querySelector('video')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('video')).toBeNull();
    expect(host.textContent).toContain('e2e.attachmentFailed');
  });

  it('revokes the URL on unmount', async () => {
    await render(meta());
    await click();
    remount();
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
  });
});
