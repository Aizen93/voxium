#!/usr/bin/env node
// Binds the committed WASM artifact to the Rust source it was built from.
//
// pkg/ is a hand-built, committed binary; nothing else in the repo can tell
// whether it matches src/. Without this, editing lib.rs and forgetting to run
// `pnpm build:wasm` produces a green tree — typecheck, lint and every test read
// pkg/, not src/ — and release.yml then ships installers whose crypto engine
// silently predates the fix. A stale binary is not a build annoyance here; it
// is a security fix that exists in git and in no user's hands.
//
//   node scripts/source-hash.mjs           write pkg/.source-hash (part of build:wasm)
//   node scripts/source-hash.mjs --check   verify it (CI)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'pkg', '.source-hash');

/** Every input that can change the emitted WASM: the source and the pinned deps. */
function inputs() {
  const files = ['Cargo.toml', 'Cargo.lock'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir)).sort()) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (entry.endsWith('.rs')) files.push(rel);
    }
  };
  walk('src');
  return files.sort();
}

function digest() {
  const hash = createHash('sha256');
  for (const file of inputs()) {
    // Path AND content: a renamed module changes the build too.
    hash.update(file);
    // Normalise line endings so a Windows checkout and CI agree.
    hash.update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

const current = digest();

if (process.argv.includes('--check')) {
  let recorded;
  try {
    recorded = readFileSync(manifest, 'utf8').trim();
  } catch {
    console.error(
      `Missing ${relative(process.cwd(), manifest)}.\n` +
        'Rebuild the engine with `pnpm --filter @voxium/crypto-engine build:wasm` and commit pkg/.'
    );
    process.exit(1);
  }
  if (recorded !== current) {
    console.error(
      'The committed WASM in packages/crypto-engine/pkg/ was not built from the current Rust source.\n' +
        `  recorded: ${recorded}\n  actual:   ${current}\n` +
        'Run `pnpm --filter @voxium/crypto-engine build:wasm` and commit the regenerated pkg/.'
    );
    process.exit(1);
  }
  console.log('crypto-engine: committed WASM matches its Rust source');
} else {
  writeFileSync(manifest, `${current}\n`);
  console.log(`crypto-engine: recorded source hash ${current}`);
}
