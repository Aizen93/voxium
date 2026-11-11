export interface SelfHostedInputs {
  apiUrl?: string | null;
  wsUrl?: string | null;
  assetOrigin?: string | null;
  updaterEndpoints?: string | null;
  updaterPubkey?: string | null;
}

export interface UpdaterBlock {
  endpoints: string[];
  pubkey: string;
}

export interface SelfHostedOverlay {
  app: { security: { csp: string } };
  bundle: { createUpdaterArtifacts: boolean };
  plugins: { updater: UpdaterBlock };
}

export function isHostSource(source: string): boolean;
export function parseServerUrl(name: string, value: string | undefined | null, protocols: readonly string[]): URL;
export function serverSources(
  apiUrl: string | undefined | null,
  wsUrl: string | undefined | null,
): { 'connect-src': string[]; 'img-src': string[] };
export function selfHostedCsp(csp: string | undefined | null, sources: Partial<Record<'connect-src' | 'img-src', readonly string[]>>): string;
export function parseUpdaterPubkey(value: string | undefined | null): string;
export function selfHostedUpdater(
  endpointsValue: string | undefined | null,
  pubkeyValue: string | undefined | null,
  official: { endpoints?: string[]; pubkey?: string } | null | undefined,
): { createUpdaterArtifacts: boolean; updater: UpdaterBlock };
export function selfHostedConfig(
  tauriConf: { app?: { security?: { csp?: string } }; plugins?: { updater?: { endpoints?: string[]; pubkey?: string } } } | null | undefined,
  inputs?: SelfHostedInputs,
): SelfHostedOverlay;
