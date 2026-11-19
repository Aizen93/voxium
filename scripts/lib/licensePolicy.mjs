// The npm licence policy of the repository (#111): which licence expressions a
// dependency may carry. Pure functions, no I/O: scripts/check-npm-licenses.mjs
// feeds them what `pnpm licenses list --json` prints for the installed tree
// and apps/server/src/__tests__/scripts/licensePolicy.test.ts feeds them
// fixtures.
//
// The rule mirrors the Rust gate of crypto-deps-watch.yml: an `OR` expression
// passes when ONE alternative is allowed, an `AND` expression only when EVERY
// part is. Anything not on the allow-list is refused, so a new licence needs a
// decision: the allow-list gets the identifier, or a reviewed exception
// (package, licence, reason) goes into scripts/npm-license-policy.json.
//
// Two refinements, both decided by the project owner and both recorded in the
// policy file: `allowedDevelopmentOnly` lists licences accepted for build and
// test tooling as a class (a package under one passes only when it is absent
// from the production tree), and an exception may carry `onlyRequiredBy`, the
// packages allowed to depend on it directly (it stops applying when anything
// else starts to).
//
// No top-level await here: the .ts scripts load this file through require(esm).

/** Licences that are copyleft by name; they get their own message. */
const COPYLEFT_RE = /(^|[^A-Za-z])(A|L)?GPL|^SSPL|^EUPL|^CPAL|^OSL|^RPL|^Sleepycat|^CC-BY-(NC|SA|ND)/i;
/** What a missing or unreadable licence field looks like. */
const UNKNOWN_RE = /^(unknown|unlicensed|see license in .*|custom.*|)$/i;

/**
 * Split an SPDX-like expression into tokens: `(`, `)`, `AND`, `OR` and terms
 * (an identifier, with a `WITH <exception>` kept inside its term). The
 * operators are matched without regard to case ("MIT and ISC" is what some
 * packages publish).
 *
 * @param {string} expression
 * @returns {string[]}
 */
function tokenise(expression) {
  const spaced = expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ');
  const words = spaced.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const up = w.toUpperCase();
    if (w === '(' || w === ')') tokens.push(w);
    else if (up === 'AND' || up === 'OR') tokens.push(up);
    else if (up === 'WITH' && tokens.length > 0 && i + 1 < words.length) {
      // "GPL-2.0 WITH Classpath-exception-2.0" is ONE term
      tokens.push(`${tokens.pop()} WITH ${words[++i]}`);
    } else tokens.push(w);
  }
  return tokens;
}

/**
 * Parse tokens into a tree: { op: 'AND' | 'OR', items } or { term }.
 * AND binds tighter than OR, as in SPDX. Returns null for a malformed one.
 *
 * @param {string[]} tokens
 */
function parse(tokens) {
  let at = 0;
  function parseOr() {
    const items = [parseAnd()];
    while (tokens[at] === 'OR') { at++; items.push(parseAnd()); }
    return items.length === 1 ? items[0] : { op: 'OR', items };
  }
  function parseAnd() {
    const items = [parseAtom()];
    while (tokens[at] === 'AND') { at++; items.push(parseAtom()); }
    return items.length === 1 ? items[0] : { op: 'AND', items };
  }
  function parseAtom() {
    const token = tokens[at++];
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR') throw new Error('malformed');
    if (token === '(') {
      const inner = parseOr();
      if (tokens[at++] !== ')') throw new Error('malformed');
      return inner;
    }
    return { term: token };
  }
  try {
    const tree = parseOr();
    return at === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/**
 * Judge one licence string against the allow-list.
 *
 * @param {string | null | undefined} license  as `pnpm licenses list` reports it
 * @param {Iterable<string>} allowed  SPDX identifiers (compared without regard to case)
 * @returns {{ ok: true } | { ok: false, kind: 'copyleft' | 'unknown' | 'not-allowed', terms: string[] }}
 *   `terms` names the licences that stopped it
 */
export function judgeLicense(license, allowed) {
  const allow = new Set([...allowed].map((a) => a.toLowerCase()));
  const text = typeof license === 'string' ? license.trim() : '';
  if (UNKNOWN_RE.test(text)) return { ok: false, kind: 'unknown', terms: [text || 'UNKNOWN'] };

  const tree = parse(tokenise(text));
  if (!tree) return { ok: false, kind: 'unknown', terms: [text] };

  /** @returns {string[]} the refused terms; empty when the node passes */
  function blockers(node) {
    if ('term' in node) {
      return allow.has(node.term.toLowerCase()) ? [] : [node.term];
    }
    if (node.op === 'OR') {
      const each = node.items.map(blockers);
      // One alternative with nothing in the way is enough
      return each.some((b) => b.length === 0) ? [] : each.flat();
    }
    return node.items.flatMap(blockers);
  }

  const terms = blockers(tree);
  if (terms.length === 0) return { ok: true };
  if (terms.some((t) => UNKNOWN_RE.test(t))) return { ok: false, kind: 'unknown', terms };
  return { ok: false, kind: terms.some((t) => COPYLEFT_RE.test(t)) ? 'copyleft' : 'not-allowed', terms };
}

/**
 * Check the shape of the policy file; throws an Error naming the entry.
 *
 * @param {unknown} policy
 * @returns {{ allowed: string[], allowedDevelopmentOnly: string[], exceptions: { package: string, license: string, reason: string, onlyRequiredBy?: string[] }[] }}
 */
export function validatePolicy(policy) {
  const p = /** @type {any} */ (policy);
  if (!p || typeof p !== 'object') throw new Error('the policy must be an object');
  if (!Array.isArray(p.allowed) || p.allowed.length === 0 || p.allowed.some((a) => typeof a !== 'string' || a.trim() === '')) {
    throw new Error('"allowed" must be a non-empty list of licence identifiers');
  }
  if (!Array.isArray(p.exceptions)) throw new Error('"exceptions" must be a list');
  const developmentOnly = p.allowedDevelopmentOnly ?? [];
  if (!Array.isArray(developmentOnly) || developmentOnly.some((a) => typeof a !== 'string' || a.trim() === '')) {
    throw new Error('"allowedDevelopmentOnly" must be a list of licence identifiers');
  }
  const seen = new Set();
  p.exceptions.forEach((e, i) => {
    for (const field of ['package', 'license', 'reason']) {
      if (!e || typeof e[field] !== 'string' || e[field].trim() === '') {
        throw new Error(`exceptions[${i}]: "${field}" must be a non-empty string`);
      }
    }
    if (e.onlyRequiredBy !== undefined
      && (!Array.isArray(e.onlyRequiredBy) || e.onlyRequiredBy.length === 0 || e.onlyRequiredBy.some((n) => typeof n !== 'string' || n.trim() === ''))) {
      throw new Error(`exceptions[${i}]: "onlyRequiredBy" must be a non-empty list of package names`);
    }
    const key = `${e.package}\u0000${e.license}`;
    if (seen.has(key)) throw new Error(`exceptions[${i}]: ${e.package} (${e.license}) is listed twice`);
    seen.add(key);
  });
  return { allowed: p.allowed, allowedDevelopmentOnly: developmentOnly, exceptions: p.exceptions };
}

/**
 * Judge every package of a `pnpm licenses list --json` result.
 *
 * @param {Record<string, { name: string, versions?: string[] }[]>} byLicense  licence string -> packages
 * @param {{ allowed: string[], allowedDevelopmentOnly?: string[], exceptions: { package: string, license: string, reason: string, onlyRequiredBy?: string[] }[] }} policy
 * @param {Set<string>} [productionNames]  names in the production tree; without it every package counts as production
 * @param {(name: string) => string[] | null} [directDependents]  the packages that depend on `name` directly, or null when unknown (an exception with `onlyRequiredBy` does not apply then)
 */
export function checkLicenses(byLicense, policy, productionNames, directDependents) {
  const { allowed, allowedDevelopmentOnly, exceptions } = validatePolicy(policy);
  const withDevelopment = [...allowed, ...allowedDevelopmentOnly];
  const used = new Set();
  const refused = [];
  const excepted = [];
  const developmentOnly = [];

  for (const [license, packages] of Object.entries(byLicense)) {
    if (judgeLicense(license, allowed).ok) continue;
    const verdict = judgeLicense(license, withDevelopment);
    for (const pkg of packages) {
      const inProduction = productionNames ? productionNames.has(pkg.name) : true;
      const entry = {
        name: pkg.name,
        versions: pkg.versions ?? [],
        license,
        kind: verdict.ok ? 'development-only' : verdict.kind,
        production: productionNames ? inProduction : undefined,
      };
      // A licence accepted for tooling passes only outside the production tree
      if (verdict.ok && !inProduction) { developmentOnly.push(entry); continue; }

      const index = exceptions.findIndex((e) => e.package === pkg.name && e.license === license);
      const exception = index >= 0 ? exceptions[index] : undefined;
      if (!exception) { refused.push(entry); continue; }
      used.add(index);
      let stray = [];
      if (exception.onlyRequiredBy) {
        const dependents = directDependents ? directDependents(pkg.name) : null;
        stray = dependents === null ? ['(dependents unknown)'] : dependents.filter((d) => !exception.onlyRequiredBy.includes(d));
      }
      if (stray.length === 0) excepted.push({ ...entry, reason: exception.reason });
      else refused.push({ ...entry, strayDependents: stray });
    }
  }

  refused.sort((a, b) => a.name.localeCompare(b.name));
  return {
    refused,
    excepted,
    developmentOnly,
    unusedExceptions: exceptions.filter((_, i) => !used.has(i)),
  };
}

/** One line naming a finding: package, versions and licence. */
export function describeFinding(f) {
  const where = f.production === undefined ? '' : f.production ? ' [production]' : ' [development only]';
  const versions = f.versions.length ? `@${f.versions.join(',')}` : '';
  let why;
  if (f.strayDependents) {
    why = `reviewed exception no longer applies: required by ${f.strayDependents.join(', ')}, which the exception does not name`;
  } else if (f.kind === 'development-only') {
    why = 'licence accepted for development-only tooling, but this package is in the production tree';
  } else if (f.kind === 'copyleft') why = 'copyleft licence';
  else if (f.kind === 'unknown') why = 'unknown licence';
  else why = 'licence not on the allow-list';
  return `${f.name}${versions}: ${f.license} (${why})${where}`;
}
