import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetBucketEncryptionCommand,
  PutBucketEncryptionCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  type CORSRule,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CORS_PROBE_KEY,
  PREFLIGHT_HEADER,
  PREFLIGHT_METHOD,
  checkableOrigins,
  describeCorsRule,
  planUploadCorsWrite,
  preflightAccepts,
  type CorsWritePlan,
} from './bucketCors';

/**
 * The settings of every S3 client this code base builds: the server's own
 * (below) and the bucket scripts', so none of them can drift from the others.
 * Reads the environment when called, never at import.
 *
 * Checksums go only where the operation REQUIRES one. The SDK's default
 * (`WHEN_SUPPORTED`, since 3.729) puts a CRC32 on every request that can carry
 * one, and the presigner hoists it into the URL: every presigned PUT then
 * carried `x-amz-checksum-crc32` of an EMPTY body (the presigner has no body)
 * plus `x-amz-sdk-checksum-algorithm`, and the client uploads the real file
 * under that URL. A store that ignores the parameter accepts the upload; one
 * that enforces it refuses every avatar, icon and attachment (`BadDigest`).
 * The presigned PUT stays bound to the exact size and type the server signed
 * (`content-length` and `content-type`, see generatePresignedPutUrl). The
 * operations S3 models as requiring a checksum keep theirs under this setting:
 * the multi-object delete and the bucket configuration writes (encryption,
 * CORS) still send a CRC32 of their real body.
 *
 * Response checksums are validated only when a call asks for them. The default
 * sets `ChecksumMode: ENABLED` on every GetObject, which puts
 * `x-amz-checksum-mode=ENABLED` into each presigned GET URL the avatar and
 * icon redirects hand out, and validates proxied bodies against whatever
 * checksum header the store chooses to send, ranged reads included.
 *
 * Set here, in the constructor, these win over the AWS_REQUEST_CHECKSUM_CALCULATION
 * and AWS_RESPONSE_CHECKSUM_VALIDATION environment variables and the shared
 * AWS config file, so no deployment setting can turn the URL parameter back on.
 */
export function s3ClientConfig(): S3ClientConfig {
  return {
    endpoint: process.env.S3_ASSETS_ENDPOINT!,
    region: process.env.S3_ASSETS_REGION!,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

// Lazy-initialized to avoid reading env vars at module load time
// (ES import hoisting means this file executes before dotenv.config())
let _s3: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client(s3ClientConfig());
  }
  return _s3;
}

function getBucket(): string {
  return process.env.S3_ASSETS_BUCKET!;
}

// Optional server-side encryption at rest (S3_SSE=AES256 or aws:kms), applied
// as BUCKET-DEFAULT encryption at startup — never as a per-request param on
// presigned PUTs. SSE headers cannot ride a presigned URL: the AWS presigner
// deliberately marks x-amz-server-side-encryption unhoistable, so it lands in
// SignedHeaders and clients (who don't send it) would 403 on every upload.
// Bucket-default encryption covers all uploads with zero client changes.
let _sse: 'AES256' | 'aws:kms' | undefined | null = null;
function getSSE(): 'AES256' | 'aws:kms' | undefined {
  if (_sse === null) {
    const v = process.env.S3_SSE;
    if (!v) {
      _sse = undefined;
    } else if (v === 'AES256' || v === 'aws:kms') {
      _sse = v;
    } else {
      console.warn(`[S3] Ignoring unsupported S3_SSE value "${v}" (expected AES256 or aws:kms)`);
      _sse = undefined;
    }
  }
  return _sse;
}

/**
 * Ensure the assets bucket has default encryption matching S3_SSE.
 * Called once at startup; no-op when S3_SSE is unset. Never throws — a
 * provider without bucket-encryption support (or a key lacking the
 * permission) must not block boot; uploads keep working and the operator
 * gets a loud log telling them to enable it provider-side.
 */
export async function ensureBucketEncryption(): Promise<void> {
  const sse = getSSE();
  if (!sse) return;
  const bucket = getBucket();
  try {
    const current = await getS3Client().send(
      new GetBucketEncryptionCommand({ Bucket: bucket }),
    ).catch(() => null); // missing config surfaces as an error on most providers
    const currentAlgo = current?.ServerSideEncryptionConfiguration?.Rules?.[0]
      ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
    if (currentAlgo === sse) {
      console.log(`[S3] Bucket "${bucket}" already has default encryption (${sse})`);
      return;
    }
    await getS3Client().send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: sse } }],
        },
      }),
    );
    console.log(`[S3] Enabled default encryption (${sse}) on bucket "${bucket}"`);
  } catch (err) {
    console.error(
      `[S3] Could not enable default encryption on bucket "${bucket}" — uploads will be stored per the provider's current settings. ` +
      'Enable default encryption in the provider console, or unset S3_SSE to silence this. ' +
      `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Bucket CORS ─────────────────────────────────────────────────────────────
// Uploads are presigned PUTs the browser sends straight to the store, so the
// store must answer the browser's preflight for every client origin, or each
// upload fails as an opaque "Failed to fetch" while images still load. The
// check sends that preflight (see ./bucketCors for what is asked and judged);
// it reads and writes the bucket's rules only with S3_CORS_APPLY=true.

/** How long the check waits for each call to the store (it never holds the boot). */
export const BUCKET_CORS_CALL_TIMEOUT_MS = 15_000;

/** An error name or code: an identifier, never a sentence. */
const ERROR_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * An error of the store or the network as its name, code and HTTP status.
 * Never its message: a network error's message names the endpoint's host and
 * port (`connect ECONNREFUSED host:port`, `getaddrinfo ENOTFOUND host`), and a
 * store's message can name the bucket. `fetch` hides the system error's code
 * in `cause`, which is read the same way, and the SDK's HTTP handler wraps an
 * abort as an `AbortError` whose `cause` is the signal's reason: that name is
 * appended as `cause <name>` (a timeout reads `AbortError, cause TimeoutError`).
 * A cause that is a plain `Error` says nothing and is left out.
 */
export function describeStoreError(err: unknown): string {
  const e = (err ?? {}) as {
    name?: unknown; code?: unknown; Code?: unknown;
    cause?: { code?: unknown; name?: unknown } | null;
    $metadata?: { httpStatusCode?: unknown };
  };
  const parts: string[] = [];
  for (const token of [e.name, e.code, e.Code, e.cause?.code]) {
    if (typeof token === 'string' && ERROR_TOKEN_RE.test(token) && !parts.includes(token)) parts.push(token);
  }
  const causeName = e.cause?.name;
  if (typeof causeName === 'string' && causeName !== 'Error' && ERROR_TOKEN_RE.test(causeName) && !parts.includes(causeName)) parts.push(`cause ${causeName}`);
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && Number.isInteger(status)) parts.push(`HTTP ${status}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown error';
}

function isNoCorsConfiguration(err: unknown): boolean {
  const e = err as { name?: unknown; Code?: unknown } | null;
  return !!e && (e.name === 'NoSuchCORSConfiguration' || e.Code === 'NoSuchCORSConfiguration');
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What the preflights found. */
type ProbeResult =
  | { ok: true; accepted: string[]; refused: string[] }
  | { ok: false; error: string };

/**
 * One unauthenticated preflight per origin, one after the other, each to a
 * presigned PUT address of a key that is never uploaded (only `OPTIONS` is
 * sent). A request that fails (the store does not answer, the network) or is
 * answered with a redirect or a server error (3xx, 5xx) ends the check:
 * nothing is known about the remaining origins either.
 */
async function probeOrigins(origins: readonly string[], fetchImpl: Fetch, timeoutMs: number): Promise<ProbeResult> {
  const accepted: string[] = [];
  const refused: string[] = [];
  try {
    const url = await generatePresignedPutUrl(CORS_PROBE_KEY, 'application/octet-stream', 1);
    for (const origin of origins) {
      const res = await fetchImpl(url, {
        method: 'OPTIONS',
        redirect: 'manual',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': PREFLIGHT_METHOD,
          'Access-Control-Request-Headers': PREFLIGHT_HEADER,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The answer is judged on its status and headers; its body is of no use
      await res.body?.cancel().catch((err: unknown) => {
        console.warn(`[S3] Bucket CORS: a preflight answer could not be discarded (${describeStoreError(err)})`);
      });
      // A redirect or a server error is not the store's CORS answer: the check
      // could not run, and apply mode writes nothing after it
      if ((res.status >= 300 && res.status <= 399) || (res.status >= 500 && res.status <= 599)) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      (preflightAccepts(res.status, (name) => res.headers.get(name), origin) ? accepted : refused).push(origin);
    }
  } catch (err) {
    return { ok: false, error: describeStoreError(err) };
  }
  return { ok: true, accepted, refused };
}

/** What the check found, and what a write did. */
export type BucketCorsOutcome =
  | { status: 'no-origins'; dropped: number }
  | { status: 'accepted'; origins: string[]; dropped: number }
  | { status: 'refused'; refused: string[]; dropped: number }
  | { status: 'unavailable'; error: string; dropped: number }
  /** Apply mode, after a refusal: the rules could not be read. */
  | { status: 'rules-unreadable'; refused: string[]; error: string; dropped: number }
  /** Apply mode: the store answered the read with a success and no rule, which is not "no rules". */
  | { status: 'rules-uninterpretable'; refused: string[]; dropped: number }
  | { status: 'write-failed'; refused: string[]; error: string; dropped: number }
  /** `stillRefused`: the origins the preflights after the write still see refused; null when they could not run (`probeError`). */
  | { status: 'written'; origins: string[]; refused: string[]; plan: CorsWritePlan; stillRefused: string[] | null; probeError: string | null; dropped: number };

/** The bucket's rules; `null` when the store says it has none (`NoSuchCORSConfiguration`). */
async function readBucketCorsRules(client: S3Client, bucket: string, timeoutMs: number): Promise<CORSRule[] | null> {
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return res.CORSRules ?? [];
  } catch (err) {
    if (isNoCorsConfiguration(err)) return null;
    throw err;
  }
}

/**
 * Ask the store whether it accepts an upload preflight from each origin of
 * `entries` (CORS_ORIGIN's entries). With `apply`, and only when a preflight
 * was refused, read the bucket's rules and write the upload rule (the rules
 * read: `NoSuchCORSConfiguration`, or a non-empty list; a success with no
 * rule is not read as "none"), then ask again: the second answer is the
 * outcome. Never throws.
 */
export async function reconcileBucketCors(options: {
  origins: readonly string[];
  apply: boolean;
  timeoutMs?: number;
  fetchImpl?: Fetch;
}): Promise<BucketCorsOutcome> {
  const { origins, dropped } = checkableOrigins(options.origins);
  if (origins.length === 0) return { status: 'no-origins', dropped };
  const timeoutMs = options.timeoutMs ?? BUCKET_CORS_CALL_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const first = await probeOrigins(origins, fetchImpl, timeoutMs);
  if (!first.ok) return { status: 'unavailable', error: first.error, dropped };
  if (first.refused.length === 0) return { status: 'accepted', origins, dropped };
  const refused = first.refused;
  if (!options.apply) return { status: 'refused', refused, dropped };

  try {
    const client = getS3Client();
    const bucket = getBucket();
    let read: CORSRule[] | null;
    try {
      read = await readBucketCorsRules(client, bucket, timeoutMs);
    } catch (err) {
      return { status: 'rules-unreadable', refused, error: describeStoreError(err), dropped };
    }
    if (read !== null && read.length === 0) return { status: 'rules-uninterpretable', refused, dropped };

    // The upload rule names the origins that were checked and refused, plus
    // those accepted (so a later boot with another list leaves no one out)
    const plan = planUploadCorsWrite(read ?? [], origins);
    try {
      await client.send(
        new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: plan.rules } }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
    } catch (err) {
      return { status: 'write-failed', refused, error: describeStoreError(err), dropped };
    }
    const second = await probeOrigins(origins, fetchImpl, timeoutMs);
    return second.ok
      ? { status: 'written', origins, refused, plan, stillRefused: second.refused, probeError: null, dropped }
      : { status: 'written', origins, refused, plan, stillRefused: null, probeError: second.error, dropped };
  } catch (err) {
    return { status: 'unavailable', error: describeStoreError(err), dropped };
  }
}

function describeOrigins(origins: readonly string[]): string {
  return origins.join(', ');
}

const CORS_RULE_HINT = 'a CORS rule allowing PUT with the request header content-type from these origins (GET is optional)';

/** Whether S3_CORS_APPLY asks the boot check to write the rule (memoised; a bad value warns once and checks only). */
let _corsApply: boolean | null = null;
function getCorsApply(): boolean {
  if (_corsApply === null) {
    const v = process.env.S3_CORS_APPLY;
    if (!v || v === 'false') {
      _corsApply = false;
    } else if (v === 'true') {
      _corsApply = true;
    } else {
      console.warn(`[S3] Ignoring unsupported S3_CORS_APPLY value "${v}" (expected true or false): the store's answer is checked, no CORS rule is written`);
      _corsApply = false;
    }
  }
  return _corsApply;
}

/**
 * The boot check of the store's CORS answer for `allowedOrigins` (the entries
 * of CORS_ORIGIN). It sends the browser's upload preflight for each origin and
 * logs ONE line: all accepted, which origins the store refuses, or that the
 * check could not run. By default it reads and writes no rule of the bucket.
 * With S3_CORS_APPLY=true, and only after a refusal, it adds the upload rule
 * (see ./bucketCors) and asks again. Not awaited by the boot; never throws;
 * logs neither the endpoint, the bucket, a key, an address, nor a credential.
 */
export async function ensureBucketCors(allowedOrigins: readonly string[]): Promise<void> {
  try {
    const outcome = await reconcileBucketCors({ origins: allowedOrigins, apply: getCorsApply() });
    const left = outcome.dropped > 0
      ? ` (${outcome.dropped} CORS_ORIGIN entr${outcome.dropped === 1 ? 'y' : 'ies'} left out: a wildcard or not a bare origin, which no request can carry)`
      : '';
    const fails = (origins: readonly string[]) =>
      `the store refuses browser uploads from ${describeOrigins(origins)}, so uploads from them fail in the browser with a network error`;
    switch (outcome.status) {
      case 'no-origins':
        console.warn(`[S3] Bucket CORS: CORS_ORIGIN names no origin to check, so the store's CORS answer was not checked${left}`);
        return;
      case 'accepted':
        console.log(`[S3] Bucket CORS: the store accepts browser uploads from all ${outcome.origins.length} CORS_ORIGIN origin(s)${left}`);
        return;
      case 'refused':
        console.warn(
          `[S3] Bucket CORS: ${fails(outcome.refused)}${left}. `
          + `Add ${CORS_RULE_HINT}, or set S3_CORS_APPLY=true to let the server add it (that needs permission to change the bucket's CORS configuration).`,
        );
        return;
      case 'unavailable':
        console.warn(
          `[S3] Bucket CORS: the check could not run (${outcome.error}), so whether the store accepts browser uploads from CORS_ORIGIN was not checked${left}. `
          + 'It changes nothing, and the server runs either way.',
        );
        return;
      case 'rules-unreadable':
        console.warn(
          `[S3] Bucket CORS: ${fails(outcome.refused)}${left}, and the bucket's CORS rules could not be read (${outcome.error}), so none was written. `
          + `Add ${CORS_RULE_HINT} with an account allowed to change the bucket's CORS configuration.`,
        );
        return;
      case 'rules-uninterpretable':
        console.warn(
          `[S3] Bucket CORS: ${fails(outcome.refused)}${left}, and the store's answer about the bucket's CORS rules could not be interpreted (a success with no rule), so none was written. `
          + `Add ${CORS_RULE_HINT} by hand.`,
        );
        return;
      case 'write-failed':
        console.error(
          `[S3] Bucket CORS: ${fails(outcome.refused)}${left}, and the upload rule could not be written (${outcome.error}). `
          + `Add ${CORS_RULE_HINT} with an account allowed to change the bucket's CORS configuration (a store that answers NotImplemented takes no bucket CORS rules and has a setting of its own for the origins it allows).`,
        );
        return;
      case 'written': {
        const { plan } = outcome;
        const did = `${plan.previous ? 'replaced' : 'added'} the upload rule (${describeCorsRule(plan.next)}), the bucket's ${plan.kept} other rule(s) written back unchanged`;
        if (outcome.stillRefused === null) {
          console.warn(`[S3] Bucket CORS: ${did}, but the check afterwards could not run (${outcome.probeError}); the next boot checks again${left}`);
        } else if (outcome.stillRefused.length > 0) {
          console.warn(
            `[S3] Bucket CORS: ${did}, but the store still refuses browser uploads from ${describeOrigins(outcome.stillRefused)}${left}: `
            + 'another rule naming the same origin may be answered first, or the store applies the rule after a delay or not as written. Check its CORS configuration by hand; the next boot checks again.',
          );
        } else {
          console.log(`[S3] Bucket CORS: ${did}; the store now accepts browser uploads from all ${outcome.origins.length} CORS_ORIGIN origin(s)${left}`);
        }
        return;
      }
    }
  } catch (err) {
    console.error(`[S3] Bucket CORS: the check failed (${describeStoreError(err)})`);
  }
}

/** Regex matching valid S3 asset keys (e.g. avatars/userId-timestamp.webp) */
export const VALID_S3_KEY_RE = /^(avatars|server-icons)\/[\w-]+\.webp$/;

/** Regex matching valid attachment keys (e.g. attachments/ch-abc123/clxyz-report.pdf) */
export const VALID_ATTACHMENT_KEY_RE = /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/;

/**
 * Generate a presigned PUT URL for direct client upload to S3.
 * ContentType and ContentLength are signed; the CacheControl given to the
 * command below never reaches the store: a presigned PUT signs only
 * content-length, content-type and host, the client sends no Cache-Control
 * header, and the presigner does not hoist the value into the URL, so a stored
 * object has no cache directive from this call (the avatar and icon reads add
 * theirs through ResponseCacheControl, see generatePresignedGetUrl).
 *
 * The URL is signed for EXACTLY `contentLength` bytes: Content-Length is a
 * signed header, so the store refuses a body of any other length. Browsers
 * set Content-Length themselves from the Blob they PUT, so the client sends
 * nothing extra — only Content-Type and Content-Length are signed, never a
 * header the client does not send on its own (an unsent signed header 403s
 * every upload; that is why SSE is bucket-default, see above). Nor does the
 * URL carry a checksum of a body it never saw (s3ClientConfig): what it holds
 * besides the signature is the `x-id` operation name, and nothing else.
 */
export async function generatePresignedPutUrl(
  key: string,
  contentType: string,
  contentLength: number,
  expiresIn = 300,
): Promise<string> {
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new Error(`Invalid upload size for a presigned PUT: ${String(contentLength)}`);
  }
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
    CacheControl: 'public, max-age=31536000, immutable',
    // NO ServerSideEncryption here — see ensureBucketEncryption() above.
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}

/** Whether an S3 error means "no such object" (HeadObject answers `NotFound`). */
function isMissingObjectError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!e && (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);
}

export interface S3ObjectHead {
  size: number;
  contentType: string | null;
}

/**
 * Read an object's stored size and type without its body. Resolves `null`
 * when the object does not exist; every other failure is rethrown (callers
 * fail closed on it).
 */
export async function headS3Object(key: string): Promise<S3ObjectHead | null> {
  try {
    const res = await getS3Client().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    if (typeof res.ContentLength !== 'number') {
      throw new Error(`HeadObject returned no size for ${key}`);
    }
    return { size: res.ContentLength, contentType: res.ContentType ?? null };
  } catch (err) {
    if (isMissingObjectError(err)) return null;
    throw err;
  }
}

/**
 * Read the bytes [start, end] (inclusive) of an object. Resolves `null` when
 * the object does not exist; every other failure is rethrown.
 */
export async function getS3ObjectRange(key: string, start: number, end: number): Promise<Buffer | null> {
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key, Range: `bytes=${start}-${end}` }),
    );
    if (!res.Body) return Buffer.alloc(0);
    const bytes = await res.Body.transformToByteArray();
    // A store that ignores Range would hand back the whole object: keep only
    // what was asked for
    return Buffer.from(bytes.subarray(0, end - start + 1));
  } catch (err) {
    if (isMissingObjectError(err)) return null;
    throw err;
  }
}

/**
 * Server-side copy of an object to a new key (metadata, type and cache headers
 * kept). Resolves `false` when the source does not exist; every other failure
 * is rethrown. The destination is a key no client was ever given an upload URL
 * for, which is what makes a check on the copy final.
 */
export async function copyS3Object(sourceKey: string, destKey: string): Promise<boolean> {
  try {
    await getS3Client().send(new CopyObjectCommand({
      Bucket: getBucket(),
      Key: destKey,
      CopySource: `${getBucket()}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      MetadataDirective: 'COPY',
    }));
    return true;
  } catch (err) {
    if (isMissingObjectError(err)) return false;
    throw err;
  }
}

/**
 * Generate a presigned GET URL for direct client download from S3.
 * Sets ResponseCacheControl so S3 returns cache headers.
 */
export async function generatePresignedGetUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ResponseCacheControl: 'public, max-age=31536000, immutable',
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
}

/**
 * List all objects in the S3 bucket, optionally filtered by prefix.
 * Handles pagination via ContinuationToken.
 */
export async function listAllS3Objects(prefix?: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await getS3Client().send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size !== undefined) {
          objects.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString() ?? null,
          });
        }
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Fetch an object from S3 for proxy streaming. Returns metadata + body stream.
 */
export async function getS3Object(key: string) {
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getS3Client().send(command);
}

/**
 * Delete an object from S3. Idempotent (ignores NoSuchKey).
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
    );
  } catch (err: unknown) {
    // Rethrow everything except NoSuchKey (idempotent delete)
    const isNoSuchKey = err instanceof Error && err.name === 'NoSuchKey';
    if (!isNoSuchKey) throw err;
  }
}

/**
 * Delete multiple objects from S3 in batches of 1000. Returns how many keys S3
 * actually ACCEPTED — DeleteObjects answers 200 with a populated `Errors[]`
 * when, say, the credentials lack s3:DeleteObject, so a caller that reads "no
 * throw" as "all gone" reports success while nothing moved.
 */
export async function deleteMultipleFromS3(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const response = await getS3Client().send(
      new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );
    if (response.Errors && response.Errors.length > 0) {
      failed += response.Errors.length;
      // The count and the store's error codes, never the keys: an attachment
      // key carries the cleaned-up original file name the user chose
      const codes = [...new Set(response.Errors.map((e) => e.Code ?? 'unknown'))].join(', ');
      console.error(`[S3] Failed to delete ${response.Errors.length} of ${batch.length} objects (${codes})`);
    }
  }
  return keys.length - failed;
}
