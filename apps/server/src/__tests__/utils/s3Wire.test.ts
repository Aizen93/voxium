import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { crc32 } from 'node:zlib';

/**
 * The real SDK and the real presigner, with the network replaced by a handler
 * that records each request and answers it. What is pinned here is what goes
 * on the wire: which query parameters a presigned URL carries, which headers
 * each call the server makes sends. utils/s3.test.ts mocks the SDK and can only
 * see the arguments it is given.
 *
 * Presigning never touches the network, and nothing here resolves a host.
 */

interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body: unknown;
}

const captured = vi.hoisted(() => [] as CapturedRequest[]);

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  const { Readable: NodeReadable } = await import('node:stream');

  const xml = (body: string) => NodeReadable.from([Buffer.from(body)]);
  const answer = (statusCode: number, headers: Record<string, string>, body: string | Buffer = '') => ({
    response: { statusCode, headers, body: NodeReadable.from([Buffer.from(body)]) },
  });

  const requestHandler = {
    handle: async (request: CapturedRequest & { headers: Record<string, string> }) => {
      captured.push({
        method: request.method,
        path: request.path,
        query: { ...request.query },
        headers: { ...request.headers },
        body: request.body,
      });
      const q = request.query ?? {};
      if (request.method === 'POST' && 'delete' in q) {
        return { response: { statusCode: 200, headers: {}, body: xml('<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>') } };
      }
      if (request.method === 'HEAD') return answer(200, { 'content-length': '10', 'content-type': 'image/webp' });
      if (request.method === 'GET' && 'list-type' in q) {
        return { response: { statusCode: 200, headers: {}, body: xml('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>') } };
      }
      if ('encryption' in q || 'cors' in q) return answer(200, {});
      if (request.method === 'GET') return answer(206, { 'content-length': '4', 'content-type': 'image/webp' }, Buffer.from([1, 2, 3, 4]));
      if (request.method === 'PUT' && request.headers['x-amz-copy-source']) {
        return { response: { statusCode: 200, headers: {}, body: xml('<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>') } };
      }
      if (request.method === 'DELETE') return answer(204, {});
      return answer(200, {});
    },
  };

  class S3Client extends actual.S3Client {
    constructor(config: ConstructorParameters<typeof actual.S3Client>[0]) {
      // The server's own settings, only the transport swapped
      super({ ...config, requestHandler, maxAttempts: 1 });
    }
  }
  return { ...actual, S3Client };
});

const SAVED_ENV = { ...process.env };

function setStoreEnv() {
  process.env.S3_ASSETS_ENDPOINT = 'http://store.example.test:9000';
  process.env.S3_ASSETS_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY = 'test-access-key';
  process.env.S3_SECRET_KEY = 'test-secret-key';
  process.env.S3_ASSETS_BUCKET = 'test-bucket';
  // The SDK reads the shared AWS files for some settings: none of the
  // developer's own may leak into the test
  process.env.AWS_CONFIG_FILE = '/nonexistent/voxium-test/aws-config';
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/voxium-test/aws-credentials';
  delete process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
  delete process.env.AWS_RESPONSE_CHECKSUM_VALIDATION;
  delete process.env.S3_SSE;
}

/** Every query parameter a presigned URL may carry besides the signature's own. */
const SIGV4_QUERY = [
  'X-Amz-Algorithm',
  'X-Amz-Content-Sha256',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-Signature',
  'X-Amz-SignedHeaders',
];

function headerNames(req: CapturedRequest): string[] {
  return Object.keys(req.headers).map((h) => h.toLowerCase());
}

function checksumHeaders(req: CapturedRequest): string[] {
  return headerNames(req).filter((h) => h.startsWith('x-amz-checksum-') || h.startsWith('x-amz-sdk-checksum-'));
}

function bodyBytes(body: unknown): Buffer {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error(`unexpected request body type: ${typeof body}`);
}

/** The base64 big-endian CRC32 the SDK sends in x-amz-checksum-crc32. */
function crc32Base64(bytes: Buffer): string {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc32(bytes));
  return out.toString('base64');
}

beforeEach(() => {
  vi.resetModules();
  captured.length = 0;
  setStoreEnv();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks();
});

describe('utils/s3 on the wire — presigned PUT', () => {
  it('carries exactly the signature parameters and the operation name: no checksum, nothing about encryption', async () => {
    const { generatePresignedPutUrl } = await import('../../utils/s3');

    const url = new URL(await generatePresignedPutUrl('attachments/ch-c1/abc-file.pdf', 'application/pdf', 12345));

    expect([...url.searchParams.keys()].sort()).toEqual([...SIGV4_QUERY, 'x-id'].sort());
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    // Bound to the exact size and type the server signed: a store refuses a
    // body of another length or another Content-Type
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.pathname).toBe('/test-bucket/attachments/ch-c1/abc-file.pdf');
    expect(url.search).not.toMatch(/checksum|server-side-encryption/i);
    // Presigning is offline
    expect(captured).toHaveLength(0);
  });

  it('stays so with S3_SSE set (encryption is bucket-default, never on the URL)', async () => {
    process.env.S3_SSE = 'AES256';
    const { generatePresignedPutUrl } = await import('../../utils/s3');

    const url = new URL(await generatePresignedPutUrl('avatars/u1-1.webp', 'image/webp', 2048));

    expect([...url.searchParams.keys()].sort()).toEqual([...SIGV4_QUERY, 'x-id'].sort());
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });

  it('stays so when the environment asks the SDK for checksums (the client settings win)', async () => {
    process.env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_SUPPORTED';
    process.env.AWS_RESPONSE_CHECKSUM_VALIDATION = 'WHEN_SUPPORTED';
    const { generatePresignedPutUrl, generatePresignedGetUrl } = await import('../../utils/s3');

    const put = new URL(await generatePresignedPutUrl('avatars/u1-1.webp', 'image/webp', 2048));
    const get = new URL(await generatePresignedGetUrl('avatars/u1-1.webp'));

    expect(put.search).not.toMatch(/checksum/i);
    expect(get.search).not.toMatch(/checksum/i);
  });
});

describe('utils/s3 on the wire — presigned GET', () => {
  it('carries the signature, the cache directive it was signed for and the operation name, and no checksum mode', async () => {
    const { generatePresignedGetUrl } = await import('../../utils/s3');

    const url = new URL(await generatePresignedGetUrl('server-icons/srv-456.webp'));

    expect([...url.searchParams.keys()].sort()).toEqual([...SIGV4_QUERY, 'response-cache-control', 'x-id'].sort());
    expect(url.searchParams.get('response-cache-control')).toBe('public, max-age=31536000, immutable');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});

describe('utils/s3 on the wire — the calls the server makes', () => {
  it('the multi-object delete still sends a CRC32 of its real body (an integrity header the operation requires)', async () => {
    const { deleteMultipleFromS3 } = await import('../../utils/s3');

    await expect(deleteMultipleFromS3(['attachments/ch-a/m1-x.png', 'attachments/ch-a/m2-y.png'])).resolves.toBe(2);

    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(req.method).toBe('POST');
    expect('delete' in req.query).toBe(true);
    const body = bodyBytes(req.body);
    expect(body.toString()).toContain('attachments/ch-a/m1-x.png');
    expect(req.headers['x-amz-checksum-crc32']).toBe(crc32Base64(body));
    expect(req.headers['x-amz-sdk-checksum-algorithm']).toBe('CRC32');
  });

  it('the bucket-encryption write still sends a CRC32 of its real body', async () => {
    process.env.S3_SSE = 'AES256';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await ensureBucketEncryption();

    const put = captured.find((r) => r.method === 'PUT' && 'encryption' in r.query);
    expect(put).toBeDefined();
    expect(put!.headers['x-amz-checksum-crc32']).toBe(crc32Base64(bodyBytes(put!.body)));
    // The read before it carries none
    const get = captured.find((r) => r.method === 'GET' && 'encryption' in r.query);
    expect(get && checksumHeaders(get)).toEqual([]);
  });

  it('a ranged read asks for no response checksum and sends none', async () => {
    const { getS3ObjectRange } = await import('../../utils/s3');

    await expect(getS3ObjectRange('avatars/u1-1.webp', 0, 3)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));

    const [req] = captured;
    expect(req.method).toBe('GET');
    expect(req.headers.range).toBe('bytes=0-3');
    expect(headerNames(req)).not.toContain('x-amz-checksum-mode');
    expect(checksumHeaders(req)).toEqual([]);
  });

  it('the proxied read asks for no response checksum', async () => {
    const { getS3Object } = await import('../../utils/s3');

    const res = await getS3Object('attachments/ch-a/m1-x.png');
    await res.Body?.transformToByteArray();

    expect(headerNames(captured[0])).not.toContain('x-amz-checksum-mode');
  });

  it('head, copy, list and single delete carry no checksum header', async () => {
    const { headS3Object, copyS3Object, listAllS3Objects, deleteFromS3 } = await import('../../utils/s3');

    await headS3Object('avatars/u1-1.webp');
    await copyS3Object('avatars/u1-1.webp', 'avatars/u1-2-abc.webp');
    await listAllS3Objects('avatars/');
    await deleteFromS3('avatars/u1-1.webp');

    expect(captured.map((r) => r.method)).toEqual(['HEAD', 'PUT', 'GET', 'DELETE']);
    for (const req of captured) expect(checksumHeaders(req)).toEqual([]);
  });
});
