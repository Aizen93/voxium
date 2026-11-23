import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The update check every desktop session runs at launch. A newer version on
// the build's feed is a mandatory dialog (Update Now is its only action); a
// build without a feed (a self-hosted build with no TAURI_UPDATER_ENDPOINTS,
// scripts/tauriSelfHosted.mjs) gets the plugin's "no endpoints" answer at once
// and must show nothing, and say why without a warning.

const { checkMock, relaunchMock } = vi.hoisted(() => {
  // Read once, when UpdateChecker is imported
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return { checkMock: vi.fn(), relaunchMock: vi.fn() };
});

vi.mock('@tauri-apps/plugin-updater', () => ({ check: checkMock }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, opts?: { version?: string }) => (opts?.version ? `${key}:${opts.version}` : key) }),
  };
});

import { UpdateChecker } from '../../components/updater/UpdateChecker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** Render, then let the dynamic import and check() settle. */
async function renderChecker() {
  await act(async () => {
    root.render(<UpdateChecker />);
  });
  await vi.waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  info.mockRestore();
  warn.mockRestore();
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('UpdateChecker', () => {
  it('a build without a feed shows nothing and logs an info line, not a warning', async () => {
    // what invoke() rejects with: the plugin error, serialised as its message
    checkMock.mockRejectedValue('Updater does not have any endpoints set.');
    await renderChecker();
    expect(container.innerHTML).toBe('');
    expect(info).toHaveBeenCalledWith('[Updater] This build has no update feed: no update check');
    expect(warn).not.toHaveBeenCalled();
  });

  it('recognises the same answer as an Error too', async () => {
    checkMock.mockRejectedValue(new Error('Updater does not have any endpoints set.'));
    await renderChecker();
    expect(container.innerHTML).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed check on a build with a feed shows nothing and warns', async () => {
    checkMock.mockRejectedValue('Could not fetch a valid release JSON from the remote');
    await renderChecker();
    expect(container.innerHTML).toBe('');
    expect(warn).toHaveBeenCalledWith('[Updater] Check failed:', 'Could not fetch a valid release JSON from the remote');
    expect(info).not.toHaveBeenCalled();
  });

  it('no newer version: nothing', async () => {
    checkMock.mockResolvedValue(null);
    await renderChecker();
    expect(container.innerHTML).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a newer version on the feed is the mandatory dialog, whose one action installs it', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (e: { event: string; data: Record<string, number> }) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 2048 } });
      onEvent({ event: 'Progress', data: { chunkLength: 2048 } });
      onEvent({ event: 'Finished', data: {} });
    });
    checkMock.mockResolvedValue({ version: '9.9.9', downloadAndInstall });
    await renderChecker();
    expect(container.textContent).toContain('updater.titleAvailable');
    expect(container.textContent).toContain('updater.version:9.9.9');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['updater.updateNow']);

    await act(async () => {
      buttons[0].click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain('updater.titleReady'));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  describe('a failed download or install', () => {
    async function failWith(reason: unknown) {
      const downloadAndInstall = vi.fn().mockRejectedValue(reason);
      checkMock.mockResolvedValue({ version: '9.9.9', downloadAndInstall });
      await renderChecker();
      await act(async () => {
        container.querySelector('button')!.click();
      });
      await vi.waitFor(() => expect(container.textContent).toContain('updater.titleFailed'));
      return downloadAndInstall;
    }

    it.each([
      ['a transport failure', 'error sending request for url (https://example.invalid/latest.json)', 'updater.failedNetwork'],
      ['a TLS failure inside a request error is never a signature claim', 'error sending request: certificate verify failed', 'updater.failedNetwork'],
      ['a timeout', 'operation Timed Out', 'updater.failedNetwork'],
      ['a request that timed out', 'Request timed out after 30s', 'updater.failedNetwork'],
      ['an installer that timed out is not a connection failure', 'installer timed out waiting for process', 'updater.failed'],
      ['a refused download status', 'Download request failed with status: 404', 'updater.failed'],
      ['a failed installer', 'the installer exited with status 1', 'updater.failed'],
      ['an install that could not move the file', 'failed to move the downloaded installer into place', 'updater.failed'],
      ['a signature text', 'The signature could not be verified', 'updater.failed'],
      ['anything else', 'something nobody planned for', 'updater.failed'],
    ])('%s shows its translated sentence, never the raw text, and logs the message', async (_name, raw, key) => {
      await failWith(raw);
      expect(container.querySelector('p')?.textContent).toBe(key);
      expect(container.textContent).not.toContain(raw);
      expect(warn).toHaveBeenCalledWith('[Updater] Update failed:', raw);
    });

    it('an Error is read by its message, and Retry runs the update again', async () => {
      const downloadAndInstall = await failWith(new Error('error sending request'));
      expect(container.textContent).toContain('updater.failedNetwork');
      expect(warn).toHaveBeenCalledWith('[Updater] Update failed:', 'error sending request');
      downloadAndInstall.mockResolvedValueOnce(undefined);
      await act(async () => {
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'updater.retry')!.click();
      });
      await vi.waitFor(() => expect(container.textContent).toContain('updater.titleReady'));
      expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    });
  });

  it('a failed check logs the message of an Error, not the object', async () => {
    checkMock.mockRejectedValue(new Error('Could not fetch a valid release JSON'));
    await renderChecker();
    expect(warn).toHaveBeenCalledWith('[Updater] Check failed:', 'Could not fetch a valid release JSON');
  });
});
