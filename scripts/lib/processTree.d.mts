import type { spawn } from 'node:child_process';

export const TASKKILL_NOT_FOUND: 128;

export interface KillableChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export function killProcessTree(
  child: KillableChild | null | undefined,
  options?: { signal?: NodeJS.Signals; platform?: NodeJS.Platform; spawn?: typeof spawn },
): Promise<void>;
