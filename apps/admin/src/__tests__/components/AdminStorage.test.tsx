import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The orphan clean-up: what the confirmation promises and what a refused run
 * tells the operator. The orphan COUNT is every unreferenced object, while the
 * sweep (apps/server/src/utils/orphanCleanup.ts) deletes only those past the
 * 7-day grace with a key shape this app writes, and refuses implausible runs;
 * the dialog used to promise it "will permanently delete N", and a refusal
 * sent operators to a dry run this panel does not have.
 */

const store = vi.hoisted(() => ({
  storageStats: null as Record<string, number> | null,
  storageFiles: [] as unknown[],
  storageFilesTotal: 0,
  storageFilesPage: 1,
  storageFilter: 'all',
  topUploaders: [] as unknown[],
  fetchStorageStats: vi.fn(),
  fetchStorageFiles: vi.fn(),
  setStorageFilter: vi.fn(),
  deleteStorageFile: vi.fn(),
  cleanupOrphans: vi.fn(),
  fetchTopUploaders: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { ORPHAN_GRACE_DAYS } from '@voxium/shared';
import { AdminStorage } from '../../components/AdminStorage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATS = {
  totalFiles: 40, totalSize: 4096, avatarCount: 10, avatarSize: 1024, serverIconCount: 5, serverIconSize: 1024,
  attachmentCount: 25, attachmentSize: 2048, orphanCount: 12, orphanSize: 2048,
};

let container: HTMLDivElement;
let root: Root;
const buttons = () => Array.from(document.body.querySelectorAll('button')) as HTMLButtonElement[];
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text);

async function render() {
  await act(async () => { root.render(<AdminStorage />); });
}
async function openCleanup() {
  const open = buttons().find((b) => b.textContent?.includes('Clean Up Orphans'));
  expect(open, 'the clean-up button shows while orphans exist').toBeDefined();
  await act(async () => { open!.click(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.storageStats = { ...STATS };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminStorage — orphan clean-up', () => {
  it('the button shows the unreferenced count without promising to delete all of it', async () => {
    await render();
    const open = buttons().find((b) => b.textContent?.includes('Clean Up Orphans'));
    expect(open!.textContent).toContain('(12)');
  });

  it('the confirmation states the 7-day grace and the refusal instead of "will permanently delete N"', async () => {
    await render();
    await openCleanup();
    const text = document.body.textContent ?? '';
    expect(text).toContain('12 files (2 KB) are not referenced by any user avatar, server icon, or message attachment.');
    expect(text).toContain(`only those older than ${ORPHAN_GRACE_DAYS} days`);
    expect(text).toContain('deletes nothing if the candidates look implausibly many');
    expect(text).not.toMatch(/will permanently delete 12/);
    expect(button('Delete Orphans')).toBeDefined();
    // The dialog is titled like the button that opens it
    expect(Array.from(document.body.querySelectorAll('h3')).map((h) => h.textContent)).toContain('Clean Up Orphans');
  });

  it.each([
    ['over-cap', { found: 60000, deleted: 0, skipped: 'over-cap' }],
    ['over-fraction', { found: 900, deleted: 0, scanned: 1000, skipped: 'over-fraction' }],
  ] as const)('a %s refusal points at the API dry run, the only one there is', async (_kind, result) => {
    store.cleanupOrphans.mockResolvedValue(result);
    await render();
    await openCleanup();
    await act(async () => { button('Delete Orphans')!.click(); });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = toast.error.mock.calls[0][0] as string;
    expect(message).toContain('Nothing was deleted');
    expect(message).toContain('POST /api/v1/admin/storage/cleanup-orphans?dryRun=1');
  });

  it('a completed run reports how many of the candidates went', async () => {
    store.cleanupOrphans.mockResolvedValue({ found: 5, deleted: 5, skipped: null });
    await render();
    await openCleanup();
    await act(async () => { button('Delete Orphans')!.click(); });
    expect(toast.success).toHaveBeenCalledWith('Cleaned up 5 of 5 orphaned files');
  });
});
