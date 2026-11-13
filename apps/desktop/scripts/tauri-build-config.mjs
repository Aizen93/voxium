#!/usr/bin/env node
// Prints (or writes, with --out) the JSON `tauri build --config <file>`
// merges over tauri.conf.json for a self-hosted desktop build
// (tauriSelfHosted.mjs): a Content Security Policy naming the server the app
// is compiled for and its object store, the builder's own updater or none,
// and an app identifier derived from the API origin (so the build keeps its
// local state apart from the official app's and other servers' builds).
// `pnpm tauri:build` runs it, then `tauri build` with the file.
//
// Read from the same places as the build that compiles the frontend:
//   VITE_API_URL, VITE_WS_URL  through Vite's own loadEnv for `vite build`
//                              (mode production): the environment first,
//                              then apps/desktop/.env.production.local,
//                              .env.production, .env.local, .env
//   TAURI_ASSET_ORIGIN         the object store's origin(s), comma-separated
//   TAURI_UPDATER_ENDPOINTS    your update feed URL(s), comma-separated, https
//   TAURI_UPDATER_PUBKEY       your updater public key (`tauri signer generate`)
// The last two are both set or both unset (no updater).
//
//   node scripts/tauri-build-config.mjs                 # print the overlay
//   node scripts/tauri-build-config.mjs --out <file>    # write it for --config
//   node scripts/tauri-build-config.mjs --env-dir <dir> # read .env files there
//
// The official release builds tauri.conf.json as is instead
// (tauri-release-config.mjs, in the project's release workflow only).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { selfHostedConfig } from './tauriSelfHosted.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');

function parseArgs(argv) {
  const options = { out: null, envDir: desktopDir };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--out' || arg === '--env-dir') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[arg === '--out' ? 'out' : 'envDir'] = resolve(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument "${arg}" (expected --out <file> or --env-dir <dir>)`);
    }
  }
  return options;
}

function main() {
  const { out, envDir } = parseArgs(process.argv.slice(2));
  // A failed run must never leave an earlier overlay for `tauri build` to read
  if (out) rmSync(out, { force: true });

  const conf = JSON.parse(readFileSync(join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const viteEnv = loadEnv('production', envDir, 'VITE_');
  const env = process.env;
  const overlay = selfHostedConfig(conf, {
    apiUrl: viteEnv.VITE_API_URL,
    wsUrl: viteEnv.VITE_WS_URL,
    assetOrigin: env.TAURI_ASSET_ORIGIN,
    updaterEndpoints: env.TAURI_UPDATER_ENDPOINTS,
    updaterPubkey: env.TAURI_UPDATER_PUBKEY,
  });

  if (!env.TAURI_ASSET_ORIGIN?.trim()) {
    console.warn('[tauri-build-config] TAURI_ASSET_ORIGIN is unset: avatars, space icons and uploads work only if your object storage answers on the API origin');
  }
  if (overlay.bundle.createUpdaterArtifacts) {
    if (!env.TAURI_SIGNING_PRIVATE_KEY) {
      console.warn('[tauri-build-config] TAURI_SIGNING_PRIVATE_KEY is not set here: `tauri build` signs the update artifacts with it and fails without it');
    }
  } else {
    console.warn('[tauri-build-config] No update feed configured: this build has no updater and never checks for updates');
  }

  const json = `${JSON.stringify(overlay, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
}

try {
  main();
} catch (err) {
  console.error(`[tauri-build-config] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
