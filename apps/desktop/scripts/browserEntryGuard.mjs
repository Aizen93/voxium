// The desktop client is ONE bundle for the Tauri app and for the browser: it
// picks the desktop paths at run time ('__TAURI_INTERNALS__' in window), and
// every @tauri-apps/* module is loaded with import() inside such a path. A
// static import anywhere in the startup graph would put desktop-only code in
// what every browser session downloads and runs. This Vite plugin fails the
// production build when it does: the chunks a browser loads at startup are
// the entry chunks and the chunks they import statically, transitively (the
// ones index.html preloads); a chunk reached only through import() is loaded
// when that import runs, and may hold Tauri code.
//
// Pure functions here, so the desktop test suite can pin them; vite.config.ts
// registers the plugin.

/** A module of a @tauri-apps/* package (a path under node_modules, either separator). */
export function isTauriModule(id) {
  return typeof id === 'string' && /[\\/]node_modules[\\/](?:.*[\\/])?@tauri-apps[\\/]/.test(id);
}

/**
 * The @tauri-apps module ids in the chunks of `bundle` (Rollup/Rolldown's
 * output bundle) that a browser loads at startup, sorted, each once.
 */
export function tauriModulesAtStartup(bundle) {
  const chunks = Object.values(bundle).filter((output) => output && output.type === 'chunk');
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const queue = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  const seen = new Set();
  const found = new Set();
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    const chunk = byFile.get(fileName);
    if (!chunk) continue;
    for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
      if (isTauriModule(id)) found.add(id);
    }
    queue.push(...(chunk.imports ?? []));
  }
  return [...found].sort();
}

/** The plugin: a production build whose startup chunks hold Tauri code fails, naming the package. */
export function browserEntryGuard() {
  return {
    name: 'voxium-browser-entry-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const found = tauriModulesAtStartup(bundle);
      if (found.length === 0) return;
      const packages = [...new Set(found.map((id) => /@tauri-apps[\\/][^\\/]+/.exec(id)?.[0].replace('\\', '/')))];
      this.error(
        `The chunks a browser loads at startup contain Tauri code (${packages.join(', ')}): ` +
          'import @tauri-apps/* modules with import() inside the Tauri-only path (scripts/browserEntryGuard.mjs)'
      );
    },
  };
}
