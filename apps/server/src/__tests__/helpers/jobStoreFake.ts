// Test-only: a job store held in memory (utils/jobs.ts, JobStore), for the
// suites that run a scheduled job through the wrapper and read what it
// recorded. Install it with `useFakeJobStore()` in a beforeEach; it puts the
// wrapper back to "no store" with `restoreJobStore()`.
import { vi } from 'vitest';
import { setJobStore, resetJobMemory, type JobRunRecord, type JobStore } from '../../utils/jobs';

export interface FakeJobStore extends JobStore {
  /** The stored modes, by job: set one to switch the job. */
  modes: Map<string, string>;
  /** Every run recorded, in order. */
  runs: JobRunRecord[];
  readMode: ReturnType<typeof vi.fn<(job: string) => Promise<string | null>>>;
  insertRun: ReturnType<typeof vi.fn<(run: JobRunRecord) => Promise<void>>>;
  pruneRuns: ReturnType<typeof vi.fn<(job: string, keep: number) => Promise<void>>>;
}

export function useFakeJobStore(): FakeJobStore {
  const modes = new Map<string, string>();
  const runs: JobRunRecord[] = [];
  const store: FakeJobStore = {
    modes,
    runs,
    readMode: vi.fn(async (job: string) => modes.get(job) ?? null),
    insertRun: vi.fn(async (run: JobRunRecord) => { runs.push(run); }),
    pruneRuns: vi.fn(async () => undefined),
  };
  resetJobMemory();
  setJobStore(store);
  return store;
}

export function restoreJobStore(): void {
  setJobStore(null);
  resetJobMemory();
}
