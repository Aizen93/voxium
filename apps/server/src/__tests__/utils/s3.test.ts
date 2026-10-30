import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the AWS SDK to avoid real S3 connections
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  // Regular function (not arrow) — s3.ts calls `new S3Client(...)` and arrow
  // functions cannot be constructed
  S3Client: vi.fn(function () { return { send: mockSend }; }),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  GetBucketEncryptionCommand: vi.fn(),
  PutBucketEncryptionCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
}));

describe('utils/s3 — lazy initialization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('importing does NOT read S3 env vars or create S3Client', async () => {
    const saved = {
      S3_ASSETS_ENDPOINT: process.env.S3_ASSETS_ENDPOINT,
      S3_ASSETS_REGION: process.env.S3_ASSETS_REGION,
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
      S3_SECRET_KEY: process.env.S3_SECRET_KEY,
      S3_ASSETS_BUCKET: process.env.S3_ASSETS_BUCKET,
    };

    // Remove all S3 env vars
    delete process.env.S3_ASSETS_ENDPOINT;
    delete process.env.S3_ASSETS_REGION;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    delete process.env.S3_ASSETS_BUCKET;

    // Importing should not throw — env vars are only read when functions are called
    const mod = await import('../../utils/s3');
    expect(mod).toBeDefined();
    expect(mod.VALID_S3_KEY_RE).toBeDefined();

    // Restore
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('S3Client is NOT instantiated at import time', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    vi.mocked(S3Client).mockClear();

    await import('../../utils/s3');
    expect(S3Client).not.toHaveBeenCalled();
  });
});

describe('utils/s3 — S3_SSE bucket-default encryption', () => {
  const savedSSE = process.env.S3_SSE;

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    delete process.env.S3_SSE;
  });

  afterEach(() => {
    if (savedSSE !== undefined) {
      process.env.S3_SSE = savedSSE;
    } else {
      delete process.env.S3_SSE;
    }
    vi.restoreAllMocks();
  });

  it('presigned PUT NEVER carries SSE params — even with S3_SSE set (unhoistable header would 403 every client upload)', async () => {
    process.env.S3_SSE = 'AES256';
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    vi.mocked(PutObjectCommand).mockClear();
    const { generatePresignedPutUrl } = await import('../../utils/s3');

    await generatePresignedPutUrl('avatars/user1-123.webp', 'image/webp', 2048);

    const input = vi.mocked(PutObjectCommand).mock.calls[0][0] as Record<string, unknown>;
    expect('ServerSideEncryption' in input).toBe(false);
  });

  it('ensureBucketEncryption is a no-op when S3_SSE is unset', async () => {
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await ensureBucketEncryption();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('applies PutBucketEncryption when the bucket has no default encryption', async () => {
    process.env.S3_SSE = 'AES256';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { GetBucketEncryptionCommand, PutBucketEncryptionCommand } = await import('@aws-sdk/client-s3');
    vi.mocked(PutBucketEncryptionCommand).mockClear();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof (GetBucketEncryptionCommand as unknown as new () => object)) {
        return Promise.reject(new Error('ServerSideEncryptionConfigurationNotFoundError'));
      }
      return Promise.resolve({});
    });
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await ensureBucketEncryption();

    expect(PutBucketEncryptionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Enabled default encryption'));
  });

  it('skips PutBucketEncryption when the bucket already matches', async () => {
    process.env.S3_SSE = 'AES256';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { PutBucketEncryptionCommand } = await import('@aws-sdk/client-s3');
    vi.mocked(PutBucketEncryptionCommand).mockClear();
    mockSend.mockResolvedValue({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await ensureBucketEncryption();

    expect(PutBucketEncryptionCommand).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already has default encryption'));
  });

  it('logs but does NOT throw when the provider rejects PutBucketEncryption', async () => {
    process.env.S3_SSE = 'AES256';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('NotImplemented'));
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await expect(ensureBucketEncryption()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not enable default encryption'));
  });

  it('warns and no-ops on an unsupported S3_SSE value', async () => {
    process.env.S3_SSE = 'rot13';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureBucketEncryption } = await import('../../utils/s3');

    await ensureBucketEncryption();
    await ensureBucketEncryption();

    // Memoized: single warning across repeated calls, and no S3 traffic
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rot13'));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('utils/s3 — presigned PUT is bound to the declared size', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
  });

  it('signs an exact ContentLength with only content-type and content-length as signable headers', async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    vi.mocked(PutObjectCommand).mockClear();
    vi.mocked(getSignedUrl).mockClear();
    const { generatePresignedPutUrl } = await import('../../utils/s3');

    const url = await generatePresignedPutUrl('attachments/ch-c1/abc-file.pdf', 'application/pdf', 12345);

    expect(url).toBe('https://signed-url.example.com');
    const input = vi.mocked(PutObjectCommand).mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      Key: 'attachments/ch-c1/abc-file.pdf',
      ContentType: 'application/pdf',
      ContentLength: 12345,
    });
    const options = vi.mocked(getSignedUrl).mock.calls[0][2] as { expiresIn: number; signableHeaders: Set<string> };
    expect(options.expiresIn).toBe(300);
    // Exactly the headers a browser sends on its own for a Blob PUT
    expect([...options.signableHeaders].sort()).toEqual(['content-length', 'content-type']);
  });

  it('keeps a custom expiry as the fourth argument', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    vi.mocked(getSignedUrl).mockClear();
    const { generatePresignedPutUrl } = await import('../../utils/s3');

    await generatePresignedPutUrl('avatars/u1-1.webp', 'image/webp', 10, 60);

    expect((vi.mocked(getSignedUrl).mock.calls[0][2] as { expiresIn: number }).expiresIn).toBe(60);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses to sign a PUT for size %s',
    async (size) => {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      vi.mocked(getSignedUrl).mockClear();
      const { generatePresignedPutUrl } = await import('../../utils/s3');

      await expect(generatePresignedPutUrl('avatars/u1-1.webp', 'image/webp', size)).rejects.toThrow('Invalid upload size');
      expect(getSignedUrl).not.toHaveBeenCalled();
    },
  );
});

describe('utils/s3 — headS3Object', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
  });

  it('returns the stored size and type', async () => {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    vi.mocked(HeadObjectCommand).mockClear();
    mockSend.mockResolvedValue({ ContentLength: 4096, ContentType: 'image/webp' });
    const { headS3Object } = await import('../../utils/s3');

    await expect(headS3Object('avatars/u1-1.webp')).resolves.toEqual({ size: 4096, contentType: 'image/webp' });
    expect(vi.mocked(HeadObjectCommand).mock.calls[0][0]).toMatchObject({ Key: 'avatars/u1-1.webp' });
  });

  it('returns a null content type when the store has none', async () => {
    mockSend.mockResolvedValue({ ContentLength: 0 });
    const { headS3Object } = await import('../../utils/s3');

    await expect(headS3Object('k')).resolves.toEqual({ size: 0, contentType: null });
  });

  it.each([
    ['NotFound', { name: 'NotFound' }],
    ['NoSuchKey', { name: 'NoSuchKey' }],
    ['a bare 404', { name: 'Unknown', $metadata: { httpStatusCode: 404 } }],
  ])('returns null for %s', async (_label, err) => {
    mockSend.mockRejectedValue(Object.assign(new Error('missing'), err));
    const { headS3Object } = await import('../../utils/s3');

    await expect(headS3Object('k')).resolves.toBeNull();
  });

  it('rethrows every other failure (callers fail closed)', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    const { headS3Object } = await import('../../utils/s3');

    await expect(headS3Object('k')).rejects.toThrow('denied');
  });

  it('throws when the store answers without a size', async () => {
    mockSend.mockResolvedValue({ ContentType: 'image/webp' });
    const { headS3Object } = await import('../../utils/s3');

    await expect(headS3Object('k')).rejects.toThrow('no size');
  });
});

describe('utils/s3 — getS3ObjectRange', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
  });

  it('asks for the inclusive byte range and returns its bytes', async () => {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    vi.mocked(GetObjectCommand).mockClear();
    mockSend.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const { getS3ObjectRange } = await import('../../utils/s3');

    const buf = await getS3ObjectRange('avatars/u1-1.webp', 0, 63);

    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    expect(vi.mocked(GetObjectCommand).mock.calls[0][0]).toMatchObject({ Key: 'avatars/u1-1.webp', Range: 'bytes=0-63' });
  });

  it('keeps only the asked range when the store ignores Range', async () => {
    mockSend.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array(1000).fill(7) } });
    const { getS3ObjectRange } = await import('../../utils/s3');

    const buf = await getS3ObjectRange('k', 0, 63);

    expect(buf?.length).toBe(64);
  });

  it('returns an empty buffer for a body-less answer', async () => {
    mockSend.mockResolvedValue({});
    const { getS3ObjectRange } = await import('../../utils/s3');

    await expect(getS3ObjectRange('k', 0, 63)).resolves.toEqual(Buffer.alloc(0));
  });

  it('returns null for a missing object and rethrows other failures', async () => {
    const { getS3ObjectRange } = await import('../../utils/s3');
    mockSend.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(getS3ObjectRange('k', 0, 63)).resolves.toBeNull();

    mockSend.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(getS3ObjectRange('k', 0, 63)).rejects.toThrow('socket hang up');
  });
});

describe('utils/s3 — VALID_S3_KEY_RE', () => {
  let VALID_S3_KEY_RE: RegExp;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../utils/s3');
    VALID_S3_KEY_RE = mod.VALID_S3_KEY_RE;
  });

  it('matches valid avatar keys', () => {
    expect(VALID_S3_KEY_RE.test('avatars/user123-1700000000.webp')).toBe(true);
    expect(VALID_S3_KEY_RE.test('avatars/abc-def_ghi-12345.webp')).toBe(true);
  });

  it('matches valid server-icon keys', () => {
    expect(VALID_S3_KEY_RE.test('server-icons/server123-1700000000.webp')).toBe(true);
  });

  it('rejects keys with invalid prefixes', () => {
    expect(VALID_S3_KEY_RE.test('uploads/user123-1700000000.webp')).toBe(false);
    expect(VALID_S3_KEY_RE.test('images/user123-1700000000.webp')).toBe(false);
  });

  it('rejects keys with wrong extensions', () => {
    expect(VALID_S3_KEY_RE.test('avatars/user123-1700000000.png')).toBe(false);
    expect(VALID_S3_KEY_RE.test('avatars/user123-1700000000.jpg')).toBe(false);
  });

  it('rejects keys with path traversal', () => {
    expect(VALID_S3_KEY_RE.test('avatars/../etc/passwd')).toBe(false);
    expect(VALID_S3_KEY_RE.test('avatars/../../secret.webp')).toBe(false);
  });

  it('rejects empty or malformed keys', () => {
    expect(VALID_S3_KEY_RE.test('')).toBe(false);
    expect(VALID_S3_KEY_RE.test('avatars/')).toBe(false);
    expect(VALID_S3_KEY_RE.test('avatars/.webp')).toBe(false);
  });
});

describe('utils/s3 — VALID_ATTACHMENT_KEY_RE', () => {
  let VALID_ATTACHMENT_KEY_RE: RegExp;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../utils/s3');
    VALID_ATTACHMENT_KEY_RE = mod.VALID_ATTACHMENT_KEY_RE;
  });

  it('matches valid channel attachment keys', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/ch-abc123/clxyz-report.pdf')).toBe(true);
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/ch-channel1/id123-file.txt')).toBe(true);
  });

  it('matches valid DM attachment keys', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/dm-conv123/id456-image.png')).toBe(true);
  });

  it('matches keys with dots in the filename', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/ch-abc/id-file.name.ext')).toBe(true);
  });

  it('rejects keys with invalid prefix segment', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/xx-abc/id-file.txt')).toBe(false);
    expect(VALID_ATTACHMENT_KEY_RE.test('other/ch-abc/id-file.txt')).toBe(false);
  });

  it('rejects keys missing the hyphen in filename', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/ch-abc/filename')).toBe(false);
  });

  it('rejects empty or malformed keys', () => {
    expect(VALID_ATTACHMENT_KEY_RE.test('')).toBe(false);
    expect(VALID_ATTACHMENT_KEY_RE.test('attachments/')).toBe(false);
  });
});
