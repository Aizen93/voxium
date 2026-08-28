import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the AWS SDK to avoid real S3 connections
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  // Regular function (not arrow) — s3.ts calls `new S3Client(...)` and arrow
  // functions cannot be constructed
  S3Client: vi.fn(function () { return { send: mockSend }; }),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
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

    await generatePresignedPutUrl('avatars/user1-123.webp', 'image/webp');

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
