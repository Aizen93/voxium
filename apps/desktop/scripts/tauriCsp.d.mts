export function parseAssetOrigins(value: string | undefined | null): string[];
export function withAssetOrigins(csp: string, origins: readonly string[]): string;
export function releaseConfig(
  tauriConf: { app?: { security?: { csp?: string } } } | null | undefined,
  assetOriginValue: string | undefined | null,
): { app: { security: { csp: string } } } | null;
