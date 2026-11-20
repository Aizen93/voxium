// Fails when a dependency of the installed npm tree carries a licence the
// policy does not allow (#111). Offline: it reads what pnpm already knows about
// node_modules (`pnpm licenses list --json`), calls no registry and no service.
//
//   node scripts/check-npm-licenses.mjs [--policy <file>] [--input <all.json>] [--prod-input <prod.json>] [--why-input <file.json>]
//
// --input/--prod-input/--why-input read the JSON documents from files instead
// of asking pnpm (for tests and for looking at a saved tree). --why-input holds
// { "<package>": ["<direct dependent>", ...] } for the exceptions that name
// `onlyRequiredBy`; pnpm answers the same question with `pnpm why <name> -r --json`. The decision logic
// is scripts/lib/licensePolicy.mjs; the allow-list and the reviewed
// exceptions are scripts/npm-license-policy.json.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicenses, describeFinding, isPackageName, validatePolicy } from './lib/licensePolicy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

// Every line this script prints goes through out() or annotate(). Text that
// came from a package (name, version, licence), from pnpm or from the free
// text of the policy file is untrusted: the runner reads a line that starts
// with `::` as a workflow command (`::error::`, `::stop-commands::`, ...), so
// a line break inside such text must never start a new line. inert() turns
// \r and \n into visible literals; a plain line never begins with `::`; the
// message of an annotation is also encoded the way the command syntax asks
// (%, \r, \n as %25, %0D, %0A).
const inert = (text) => String(text).replace(/\r/g, '\\r').replace(/\n/g, '\\n');

function out(text, stream = console.log) {
  const line = inert(text);
  stream(line.startsWith('::') ? ` ${line}` : line);
}

function annotate(level, text, stream = console.error) {
  const line = inert(text);
  if (!process.env.GITHUB_ACTIONS) { out(line, stream); return; }
  stream(`::${level}::${line.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

function fail(message) {
  annotate('error', message);
  process.exit(1);
}

/**
 * Run pnpm with `words`. On Windows pnpm is pnpm.cmd, which only a shell can
 * start, and the command is then ONE string: an argument list together with
 * `shell: true` is deprecated (DEP0190) because the arguments are joined
 * unescaped. So every word given here is either written in this file or has
 * passed isPackageName(), whose characters no shell interprets.
 */
function runPnpm(words) {
  const options = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 };
  return process.platform === 'win32'
    ? spawnSync(`pnpm ${words.join(' ')}`, { ...options, shell: true })
    : spawnSync('pnpm', words, options);
}

function pnpmLicenses(extra) {
  const result = runPnpm(['licenses', 'list', '--json', ...extra]);
  if (result.error || result.status !== 0) {
    fail(`pnpm licenses list failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? '').slice(0, 500)}`);
  }
  return JSON.parse(result.stdout);
}

/** The packages that depend directly on `name` (`pnpm why`), or null when pnpm cannot say. */
function pnpmDirectDependents(name) {
  // a name that is not a package name is never put on a command line: unknown
  // dependents, so an exception bound to its dependents does not apply
  if (!isPackageName(name)) return null;
  const result = runPnpm(['why', name, '-r', '--json']);
  if (result.error || result.status !== 0) return null;
  try {
    const found = JSON.parse(result.stdout);
    return [...new Set(found.flatMap((entry) => (entry.dependents ?? []).map((d) => d.name)))];
  } catch {
    return null;
  }
}

function load(file, extra) {
  return file ? JSON.parse(readFileSync(file, 'utf8')) : pnpmLicenses(extra);
}

let policy;
try {
  policy = validatePolicy(JSON.parse(readFileSync(option('--policy') ?? path.join(here, 'npm-license-policy.json'), 'utf8')));
} catch (err) {
  fail(`The licence policy is unusable: ${err.message}`);
}

const everything = load(option('--input'), []);
const production = load(option('--prod-input'), ['--prod']);
const productionNames = new Set(Object.values(production).flat().map((p) => p.name));

// An empty listing is a broken install (no node_modules, a failed install),
// never a clean tree: it would pass everything, and an empty production
// listing would let every development-only licence through.
const total = new Set(Object.values(everything).flat().map((p) => p.name)).size;
if (total === 0) fail('pnpm reported no packages: the install is missing or broken, so no licence was checked');
if (productionNames.size === 0) fail('pnpm reported no production packages: the production listing is empty, so the development-only licences cannot be told apart from production ones');
const whyFile = option('--why-input');
const whyDocument = whyFile ? JSON.parse(readFileSync(whyFile, 'utf8')) : null;
const directDependents = whyDocument ? (name) => whyDocument[name] ?? null : pnpmDirectDependents;
const { refused, excepted, developmentOnly, unusedExceptions } = checkLicenses(everything, policy, productionNames, directDependents);

out(`Checked ${total} packages against ${policy.allowed.length} allowed licences, ${policy.allowedDevelopmentOnly.length} development-only licence(s) and ${policy.exceptions.length} reviewed exception(s).`);
// What is tolerated, once, so a reader of the log sees it
if (developmentOnly.length > 0) {
  out(`Tolerated as development-only tooling (${policy.allowedDevelopmentOnly.join(', ')}; absent from the production tree):`);
  for (const f of developmentOnly) out(`  ${f.name}@${f.versions.join(',')}: ${f.license}`);
}
if (excepted.length > 0) {
  out('Tolerated by reviewed exception (scripts/npm-license-policy.json):');
  for (const f of excepted) out(`  ${f.name}@${f.versions.join(',')}: ${f.license}: ${f.reason}`);
}
for (const e of unusedExceptions) {
  annotate('warning', `unused exception: ${e.package} (${e.license}) is no longer in the tree; remove it from scripts/npm-license-policy.json`, console.warn);
}

if (refused.length > 0) {
  for (const f of refused) annotate('error', describeFinding(f));
  fail(`${refused.length} package(s) carry a licence the policy does not allow. Review each: allow the identifier or add a reviewed exception in scripts/npm-license-policy.json.`);
}
out('Licence tree clean.');
