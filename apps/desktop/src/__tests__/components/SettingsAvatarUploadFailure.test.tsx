import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * An avatar upload that fails shows the path's own translated sentence for a
 * client-side failure (the image helper's developer text stays in the
 * console), and still the server's reason for a server refusal.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { SettingsModal } from '../../components/settings/SettingsModal';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { ImageEncodeError } from '../../utils/imageProcessing';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ isSettingsOpen: true, initialSettingsTab: 'account' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSettingsStore.setState({ isSettingsOpen: false, initialSettingsTab: null });
});

async function pickAvatar(failure: unknown) {
  useAuthStore.setState({ uploadAvatar: vi.fn().mockRejectedValue(failure) } as never);
  await act(async () => { root.render(<SettingsModal />); });
  const input = document.body.querySelector('input[type="file"][accept^="image/"]') as HTMLInputElement;
  const file = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('SettingsModal — an avatar upload that fails', () => {
  it('an ImageEncodeError shows the avatar sentence, never the helper text', async () => {
    await pickAvatar(new ImageEncodeError('OffscreenCanvas has no 2D context'));
    expect(toast.error).toHaveBeenCalledWith('settings.profile.failedToUploadAvatar');
  });

  it('a server refusal still shows the server reason', async () => {
    const refusal = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 429, data: { success: false, error: 'Too many requests. Please try again later.' } },
    });
    await pickAvatar(refusal);
    expect(toast.error).toHaveBeenCalledWith('serverErrors.tooManyRequests');
  });
});
