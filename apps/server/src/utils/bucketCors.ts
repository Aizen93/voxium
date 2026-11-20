/**
 * The bucket CORS rule the clients need, how the store's answer to a browser's
 * preflight is judged, and how the rule is merged into a bucket's rules. Pure:
 * no environment, no client, nothing at import. The server's boot check
 * (`ensureBucketCors`, utils/s3.ts) and `scripts/setup-dev-bucket.ts` both go
 * through this module, so they cannot disagree.
 *
 * Uploads are presigned PUTs sent by the browser straight to the store, so the
 * browser preflights them (an `OPTIONS` with `Origin`,
 * `Access-Control-Request-Method: PUT` and
 * `Access-Control-Request-Headers: content-type`), and a store that refuses
 * that preflight fails the upload as an opaque "Failed to fetch" while images
 * still load (an `<img>` needs no preflight). The check asks the store the
 * browser's own question and judges the answer: no store's rule-matching is
 * reimplemented here (stores differ: one takes the first rule matching an
 * origin, one ignores a `content-*` header wildcard, one ignores a port
 * wildcard in an origin), and the question needs no permission on the bucket's
 * configuration.
 *
 * No client sends a cross-origin GET to the store, so only PUT with the
 * `content-type` header is required. The rule the server WRITES keeps GET
 * beside PUT: harmless, and a cross-origin read of an object would work.
 *
 * The write keeps every existing rule and changes only the rule named
 * `voxium-uploads`. It can change the store's answer only for the origins that
 * rule names; on a store that answers with the first rule matching an origin,
 * an origin named by this rule and by another one is answered by whichever
 * comes first. PutBucketCors has no precondition: an edit an operator makes
 * between the read and the write is lost.
 *
 * The check sends the preflight only: a proxy in front of the store that
 * answers the preflight itself but removes `Access-Control-Allow-Origin` from
 * the upload's own answer passes the check while uploads fail.
 */
import type { CORSRule } from '@aws-sdk/client-s3';

/** The ID of the rule the server writes, so a later write finds its own rule. */
export const UPLOAD_CORS_RULE_ID = 'voxium-uploads';

/** How long a browser may cache the store's preflight answer. */
export const UPLOAD_CORS_MAX_AGE_SECONDS = 3600;

/**
 * The key the preflight is addressed to. Nothing is ever written to it: only
 * an `OPTIONS` goes to the presigned address.
 */
export const CORS_PROBE_KEY = 'cors-check/probe';

/** What the clients' upload preflight asks for. */
export const PREFLIGHT_METHOD = 'PUT';
export const PREFLIGHT_HEADER = 'content-type';

export interface CheckableOrigins {
  /** Each origin once, sorted. */
  origins: string[];
  /** Entries left out because they hold a wildcard or are not a bare origin. */
  dropped: number;
}

/**
 * The origins to check, from the entries of CORS_ORIGIN. The API compares
 * origins literally, so an entry holding `*`, or one that is not exactly the
 * origin a browser sends (a path, a trailing slash, a different spelling), can
 * never be the origin of a request and is left out and counted. Blank entries
 * (a trailing comma) are ignored. A scheme other than http(s) (`tauri://…`)
 * has no origin to WHATWG URL (it reads `null`), so its origin is its
 * `scheme://host[:port]`, and the entry must be exactly that.
 */
export function checkableOrigins(entries: readonly string[]): CheckableOrigins {
  const kept = new Set<string>();
  let dropped = 0;
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (isBareOrigin(entry)) kept.add(entry);
    else dropped += 1;
  }
  return { origins: [...kept].sort(), dropped };
}

function isBareOrigin(entry: string): boolean {
  if (entry.includes('*')) return false;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  if (url.origin !== 'null') return entry === url.origin;
  if (url.protocol === 'file:' || url.username || url.password || url.search || url.hash) return false;
  return url.host.length > 0 && entry === `${url.protocol}//${url.host}`;
}

/**
 * Whether a comma-separated list names `wanted` or `*`. Header NAMES compare
 * case-insensitively; METHODS compare exactly, as a browser does (a store
 * answering `put` is refused by it).
 */
function listHas(value: string | null, wanted: string, caseSensitive: boolean): boolean {
  if (value === null) return false;
  return value.split(',').map((v) => (caseSensitive ? v.trim() : v.trim().toLowerCase())).some((v) => v === '*' || v === wanted);
}

/**
 * Whether the store's answer to the preflight lets the browser go on: a 2xx
 * status, the origin echoed (or `*`), PUT among the allowed methods (or `*`)
 * and `content-type` among the allowed headers (or `*`). The method is compared
 * exactly (`PUT`, not `put`), the header name without regard to case.
 */
export function preflightAccepts(
  status: number,
  header: (name: string) => string | null,
  origin: string,
): boolean {
  if (status < 200 || status > 299) return false;
  const allowOrigin = header('access-control-allow-origin')?.trim() ?? null;
  if (allowOrigin !== '*' && allowOrigin !== origin) return false;
  return listHas(header('access-control-allow-methods'), PREFLIGHT_METHOD, true)
    && listHas(header('access-control-allow-headers'), PREFLIGHT_HEADER, false);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** The rule the clients need for `origins`: exactly those origins. */
export function buildUploadCorsRule(origins: readonly string[]): CORSRule {
  return {
    ID: UPLOAD_CORS_RULE_ID,
    AllowedOrigins: sortedUnique(origins),
    AllowedMethods: ['GET', 'PUT'],
    AllowedHeaders: [PREFLIGHT_HEADER],
    MaxAgeSeconds: UPLOAD_CORS_MAX_AGE_SECONDS,
  };
}

/** What a write of the upload rule would put in the bucket. */
export interface CorsWritePlan {
  /** The whole configuration to write: every other rule as it was read, in its place. */
  rules: CORSRule[];
  /** The server's earlier rule that `next` takes the place of, or null when `next` is appended. */
  previous: CORSRule | null;
  next: CORSRule;
  /** How many other rules are written back unchanged. */
  kept: number;
}

/**
 * Merge the upload rule into the bucket's rules. PutBucketCors replaces the
 * whole configuration, so every other rule is written back as it was read and
 * in its place; the rule named `voxium-uploads` is replaced where it stands,
 * and without one the new rule goes last. The result depends only on the
 * rules read and the origins, so nodes booting together write the same
 * configuration.
 */
export function planUploadCorsWrite(existing: readonly CORSRule[], origins: readonly string[]): CorsWritePlan {
  const previous = existing.find((r) => r.ID === UPLOAD_CORS_RULE_ID) ?? null;
  const next = buildUploadCorsRule(origins);
  const rules = previous
    ? existing.map((r) => (r === previous ? next : r))
    : [...existing, next];
  return { rules, previous, next, kept: existing.length - (previous ? 1 : 0) };
}

/**
 * A rule's shape for a log line: its methods, how many origins, its request
 * and exposed headers and its max age. Never the origins themselves of a rule
 * the operator wrote.
 */
export function describeCorsRule(rule: CORSRule): string {
  const join = (v: string[] | undefined) => (v && v.length > 0 ? v.join(',') : 'none');
  const origins = rule.AllowedOrigins?.length ?? 0;
  return `methods ${join(rule.AllowedMethods)}; ${origins} origin${origins === 1 ? '' : 's'}; headers ${join(rule.AllowedHeaders)}; `
    + `exposed ${join(rule.ExposeHeaders)}; max-age ${rule.MaxAgeSeconds ?? 'unset'}`;
}
