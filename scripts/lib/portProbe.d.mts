export const PROBE_HOSTS: readonly string[];

export type ProbeResult =
  | { state: 'free' }
  | { state: 'in-use' }
  | { state: 'error'; code: string | undefined; message: string };

export function probeBind(port: number, host: string): Promise<ProbeResult>;

export function portProblem(
  port: number,
  options?: { hosts?: readonly string[]; probe?: (port: number, host: string) => Promise<ProbeResult> },
): Promise<string | null>;
