/** The part of an output chunk the guard reads (Rollup and Rolldown share it). */
export interface GuardedChunk {
  type: 'chunk';
  fileName: string;
  isEntry: boolean;
  imports?: readonly string[];
  moduleIds?: readonly string[];
  modules?: Record<string, unknown>;
}
export function isTauriModule(id: unknown): boolean;
export function tauriModulesAtStartup(bundle: Record<string, GuardedChunk | { type: 'asset'; fileName: string }>): string[];
export function browserEntryGuard(): {
  name: string;
  apply: 'build';
  generateBundle(this: { error(message: string): never }, options: unknown, bundle: Record<string, unknown>): void;
};
