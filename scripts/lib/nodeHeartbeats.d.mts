export const HEARTBEAT_PATTERN: string;

export const HEARTBEAT_EXPIRY_WAIT_MS: number;

export function foreignNodeProblem(options: {
  list: () => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}): Promise<string | null>;
