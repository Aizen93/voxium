#!/usr/bin/env node
// Prints the JSON that `tauri build --config <file>` merges over
// tauri.conf.json for a release build: the Content Security Policy with the
// deployment's object-store origin(s) added to `img-src` and `connect-src`,
// read from TAURI_ASSET_ORIGIN (comma-separated for more than one). With the
// variable unset the script prints `{}` and the base policy ships unchanged.
//
//   TAURI_ASSET_ORIGIN=https://objects.example.com \
//     node scripts/tauri-release-config.mjs > "$RUNNER_TEMP/tauri.release.json"
//   pnpm tauri build --config "$RUNNER_TEMP/tauri.release.json"
//
// It changes `csp` only: `tauri dev` runs under `devCsp`, the same policy
// plus the dev server's localhost:3001, which no release build names.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseConfig } from './tauriCsp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const merged = releaseConfig(conf, process.env.TAURI_ASSET_ORIGIN);
process.stdout.write(JSON.stringify(merged ?? {}, null, 2) + '\n');
