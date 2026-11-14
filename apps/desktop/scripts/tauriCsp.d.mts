export const TAURI_IPC_SOURCES: readonly string[];
export function isCspHost(host: unknown): boolean;
export function isTcpPort(port: string | number): boolean;
export function parseAssetOrigins(value: string | undefined | null): string[];
export function withAssetOrigins(csp: string, origins: readonly string[]): string;
export function releaseConfig(
  tauriConf: { app?: { security?: { csp?: string } } } | null | undefined,
  assetOriginValue: string | undefined | null,
): { app: { security: { csp: string } } } | null;
