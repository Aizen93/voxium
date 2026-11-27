import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function tokenFor(userId: string) {
  return jwt.sign({ userId, username: userId, tokenVersion: 0 }, JWT_SECRET, { algorithm: 'HS256' });
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  user: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0), update: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  jobSetting: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  jobRun: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, { get(_target, prop) { return prismaMock[prop as string]; } }),
}));

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) })),
}));

vi.mock('../../middleware/rateLimiter', () => {
  const passthrough = (_req: any, _res: any, next: () => void) => next();
  return { rateLimitAdmin: passthrough, normalizeIp: (ip: string) => ip };
});

vi.mock('../../utils/redis', () => ({ getOnlineUsers: vi.fn().mockResolvedValue([]), NODE_ID: () => 'node-under-test' }));

vi.mock('../../websocket/voiceHandler', () => ({
  cleanupServerVoice: vi.fn(),
  getVoiceMediaCounts: vi.fn().mockReturnValue({ producers: 0, consumers: 0, transports: 0 }),
  getTransportCountsByChannel: vi.fn().mockReturnValue({}),
  getActiveVoiceChannelCount: vi.fn().mockResolvedValue(0),
  getTotalVoiceUsers: vi.fn().mockResolvedValue(0),
  getVoiceDiagnostics: vi.fn().mockReturnValue({}),
}));
vi.mock('../../websocket/dmVoiceHandler', () => ({
  getActiveDMCallCount: vi.fn().mockResolvedValue(0),
  getTotalDMVoiceUsers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../mediasoup/mediasoupManager', () => ({
  getSfuStats: vi.fn().mockReturnValue({ workers: [], totalTransports: 0 }),
}));
vi.mock('../../utils/serverLimits', () => ({ getGlobalLimits: vi.fn().mockResolvedValue({}) }));
vi.mock('../../utils/sanitize', () => ({ sanitizeText: vi.fn((s: string) => s) }));
vi.mock('../../utils/memberBroadcast', () => ({
  broadcastMemberJoined: vi.fn().mockResolvedValue(undefined),
  broadcastMemberLeft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/s3', () => ({
  VALID_S3_KEY_RE: /^[a-zA-Z0-9\/_.-]+$/,
  VALID_ATTACHMENT_KEY_RE: /^attachments\//,
  listAllS3Objects: vi.fn().mockResolvedValue([]),
  deleteFromS3: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/auditLog', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(true) }));

// ─── App setup ──────────────────────────────────────────────────────────────

import { adminRouter } from '../../routes/admin';
import { errorHandler } from '../../middleware/errorHandler';
import { logAuditEvent } from '../../utils/auditLog';
import { JOBS } from '../../utils/jobs';
import { JOB_RUNS_PAGE_DEFAULT as RUNS_PAGE_DEFAULT, JOB_RUNS_PAGE_MAX as RUNS_PAGE_MAX } from '../../utils/jobStore';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const ROLES: Record<string, string> = { 'superadmin-1': 'superadmin', 'admin-1': 'admin', 'user-1': 'user' };

function mockAccounts() {
  prismaMock.user.findUnique.mockImplementation(({ where }: any) => {
    const role = ROLES[where.id];
    if (!role) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id, bannedAt: null, tokenVersion: 0, role,
      emailVerified: true, termsAcceptedAt: new Date(0), privacyAcceptedAt: new Date(0),
    });
  });
}

const superadmin = tokenFor('superadmin-1');
const admin = tokenFor('admin-1');
const user = tokenFor('user-1');

interface Row {
  id: number; job: string; startedAt: Date; finishedAt: Date; nodeId: string; mode: string;
  outcome: string; skipReason: string | null; summary: unknown; error: string | null;
}
function run(over: Partial<Row> = {}): Row {
  return {
    id: 1, job: 'session-sweep', startedAt: new Date('2026-11-27T06:00:00.000Z'), finishedAt: new Date('2026-11-27T06:00:01.250Z'),
    nodeId: 'node-a', mode: 'on', outcome: 'success', skipReason: null, summary: { sessions: 3, redemptions: 0 }, error: null, ...over,
  };
}

/** The two DISTINCT ON statements: the last run of each job, and the last failure. */
function lastRuns(last: Row[], failures: Row[]) {
  prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join('?').includes("outcome = 'failed'") ? failures : last));
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  mockAccounts();
  prismaMock.jobSetting.findMany.mockResolvedValue([]);
  prismaMock.jobSetting.findUnique.mockResolvedValue(null);
  prismaMock.jobSetting.upsert.mockResolvedValue({});
  prismaMock.jobRun.findMany.mockResolvedValue([]);
  lastRuns([], []);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── GET /admin/jobs ───────────────────────────────────────────────────────

describe('GET /admin/jobs', () => {
  it('lists every job of the registry, in its order, with what the page shows', async () => {
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${superadmin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((j: { name: string }) => j.name)).toEqual(JOBS.map((j) => j.name));
    const sessions = res.body.data.find((j: { name: string }) => j.name === 'session-sweep');
    expect(sessions).toEqual({
      name: 'session-sweep',
      title: 'Session sweep',
      description: expect.stringContaining('sign-in sessions'),
      schedule: { kind: 'interval', seconds: 21600 },
      scheduleText: expect.any(String),
      switchable: true,
      notSwitchableReason: null,
      supportsCountOnly: false,
      defaultMode: 'on',
      mode: 'on',
      setAt: null,
      setBy: null,
      lastRun: null,
      lastFailure: null,
      nextRunAt: null,
      overdue: false,
    });
    const presence = res.body.data.find((j: { name: string }) => j.name === 'presence-reaper');
    expect(presence).toMatchObject({ switchable: false, notSwitchableReason: expect.stringContaining('online for ever') });
  });

  it('is open to every administrator, not only superadmins', async () => {
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  it('refuses an account that is not an administrator', async () => {
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${user}`);
    expect(res.status).toBe(403);
    expect(prismaMock.jobSetting.findMany).not.toHaveBeenCalled();
  });

  it('shows the stored mode, who set it and when; a job that cannot be switched always shows its default', async () => {
    prismaMock.jobSetting.findMany.mockResolvedValue([
      { job: 'report-retention', mode: 'off', setAt: new Date('2026-11-26T10:00:00.000Z'), setBy: { id: 'superadmin-1', username: 'root' } },
      { job: 'presence-reaper', mode: 'off', setAt: new Date('2026-11-26T10:00:00.000Z'), setBy: null },
    ]);
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    const byName = Object.fromEntries(res.body.data.map((j: { name: string }) => [j.name, j]));
    expect(byName['report-retention']).toMatchObject({ mode: 'off', setAt: '2026-11-26T10:00:00.000Z', setBy: { id: 'superadmin-1', username: 'root' }, nextRunAt: null });
    expect(byName['presence-reaper'].mode).toBe('on');
    expect(prismaMock.jobSetting.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { job: { in: JOBS.map((j) => j.name) } } }));
  });

  it('gives each job its last run and its last failure, read by one DISTINCT ON statement each', async () => {
    lastRuns(
      [run({ id: 9, outcome: 'skipped', skipReason: 'guard-refused', summary: { sessions: 0, redemptions: 0, mismatch: 'version' } })],
      [run({ id: 7, outcome: 'failed', summary: null, error: 'Error: db down' })],
    );
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    const sessions = res.body.data.find((j: { name: string }) => j.name === 'session-sweep');
    expect(sessions.lastRun).toEqual({
      id: 9, startedAt: '2026-11-27T06:00:00.000Z', finishedAt: '2026-11-27T06:00:01.250Z', durationMs: 1250, nodeId: 'node-a',
      mode: 'on', outcome: 'skipped', skipReason: 'guard-refused', summary: { sessions: 0, redemptions: 0, mismatch: 'version' }, error: null,
    });
    expect(sessions.lastFailure).toMatchObject({ id: 7, outcome: 'failed', error: 'Error: db down', summary: null });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.$queryRaw.mock.calls) {
      const sql = (call[0] as string[]).join('?').replace(/\s+/g, ' ');
      expect(sql).toMatch(/^ SELECT DISTINCT ON \(job\) /);
      expect(sql).toContain('FROM job_runs WHERE job = ANY(?::text[])');
      expect(sql).toContain('ORDER BY job DESC, id DESC');
      expect(call[1]).toEqual(JOBS.map((j) => j.name));
    }
  });

  it('leaves out a stored summary that is not numbers and listed words', async () => {
    lastRuns([run({ summary: { sessions: 1, note: 'someone@example.com' } })], []);
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.find((j: { name: string }) => j.name === 'session-sweep').lastRun.summary).toBeNull();
  });

  it('gives a daily job its next slot in the server\'s time, an interval job none', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 27, 5, 10, 0), toFake: ['Date'] });
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    const byName = Object.fromEntries(res.body.data.map((j: { name: string; nextRunAt: string | null }) => [j.name, j.nextRunAt]));
    expect(byName['report-retention']).toBe(new Date(2026, 10, 27, 5, 30, 0).toISOString());
    expect(byName['attachment-cleanup']).toBe(new Date(2026, 10, 28, 4, 0, 0).toISOString());
    expect(byName['key-share-sweep']).toBeNull();
  });

  it('marks a job overdue after twice the longest gap of its records, never one that is off', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-27T20:00:00.000Z'), toFake: ['Date'] });
    lastRuns([
      run({ job: 'session-sweep', startedAt: new Date('2026-11-27T07:59:00.000Z'), finishedAt: new Date('2026-11-27T07:59:01.000Z') }),
      run({ job: 'key-share-sweep', startedAt: new Date('2026-11-27T08:01:00.000Z'), finishedAt: new Date('2026-11-27T08:01:01.000Z'), summary: null }),
      run({ job: 'report-retention', startedAt: new Date('2026-11-24T05:30:00.000Z'), finishedAt: new Date('2026-11-24T05:30:01.000Z'), summary: null }),
    ], []);
    prismaMock.jobSetting.findMany.mockResolvedValue([{ job: 'report-retention', mode: 'off', setAt: new Date(), setBy: null }]);
    const res = await request(app).get('/api/v1/admin/jobs').set('Authorization', `Bearer ${admin}`);
    const byName = Object.fromEntries(res.body.data.map((j: { name: string; overdue: boolean }) => [j.name, j.overdue]));
    expect(byName['session-sweep']).toBe(true); // 12 h 1 min since its last run, every 6 h
    expect(byName['key-share-sweep']).toBe(false); // 11 h 59 min
    expect(byName['report-retention']).toBe(false); // three days, but switched off
    expect(byName['orphan-cleanup']).toBe(false); // no run recorded yet
  });
});

// ─── GET /admin/jobs/:name/runs ────────────────────────────────────────────

describe('GET /admin/jobs/:name/runs', () => {
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => run({ id: from - i }));

  it('answers an unknown job as missing', async () => {
    const res = await request(app).get('/api/v1/admin/jobs/no-such-job/runs').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(prismaMock.jobRun.findMany).not.toHaveBeenCalled();
  });

  it('the first page: newest first by id, the default size, and a cursor when more exist', async () => {
    prismaMock.jobRun.findMany.mockResolvedValue(rows(100, RUNS_PAGE_DEFAULT + 1));
    const res = await request(app).get('/api/v1/admin/jobs/session-sweep/runs').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(prismaMock.jobRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { job: 'session-sweep' }, orderBy: { id: 'desc' }, take: RUNS_PAGE_DEFAULT + 1,
    }));
    expect(prismaMock.jobRun.findMany.mock.calls[0][0]).not.toHaveProperty('cursor');
    expect(prismaMock.jobRun.findMany.mock.calls[0][0]).not.toHaveProperty('skip');
    expect(res.body.data.runs).toHaveLength(RUNS_PAGE_DEFAULT);
    expect(res.body.data.runs[0]).toMatchObject({ id: 100, durationMs: 1250, summary: { sessions: 3, redemptions: 0 } });
    expect(res.body.data.nextCursor).toBe(String(100 - RUNS_PAGE_DEFAULT + 1));
  });

  it('the next page: the runs below the cursor, and no cursor on the last page', async () => {
    prismaMock.jobRun.findMany.mockResolvedValue(rows(75, 3));
    const res = await request(app).get('/api/v1/admin/jobs/session-sweep/runs?before=76&limit=10').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(prismaMock.jobRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { job: 'session-sweep', id: { lt: 76 } }, take: 11 }));
    expect(res.body.data.runs.map((r: { id: number }) => r.id)).toEqual([75, 74, 73]);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('takes a limit up to the maximum', async () => {
    const res = await request(app).get(`/api/v1/admin/jobs/session-sweep/runs?limit=${RUNS_PAGE_MAX}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(prismaMock.jobRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: RUNS_PAGE_MAX + 1 }));
  });

  it.each(['0', '101', 'ten', '-1', '1.5', ''])('refuses the limit %j', async (limit) => {
    const res = await request(app).get(`/api/v1/admin/jobs/session-sweep/runs?limit=${limit}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`limit must be a whole number from 1 to ${RUNS_PAGE_MAX}`);
    expect(prismaMock.jobRun.findMany).not.toHaveBeenCalled();
  });

  it.each(['0', 'abc', '-5', '2147483648', ''])('refuses the cursor %j', async (before) => {
    const res = await request(app).get(`/api/v1/admin/jobs/session-sweep/runs?before=${before}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('before must be a run id');
  });
});

// ─── PUT /admin/jobs/:name ─────────────────────────────────────────────────

describe('PUT /admin/jobs/:name', () => {
  const put = (name: string, body: unknown, token = superadmin) =>
    request(app).put(`/api/v1/admin/jobs/${name}`).set('Authorization', `Bearer ${token}`).send(body as object);

  it('switches a job off, records who and when, audits the old and the new mode, and answers the job as listed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00.000Z'), toFake: ['Date'] });
    prismaMock.jobSetting.findMany.mockResolvedValue([
      { job: 'session-sweep', mode: 'off', setAt: new Date('2026-11-27T12:00:00.000Z'), setBy: { id: 'superadmin-1', username: 'root' } },
    ]);
    const res = await put('session-sweep', { mode: 'off' });
    expect(res.status).toBe(200);
    expect(prismaMock.jobSetting.upsert).toHaveBeenCalledWith({
      where: { job: 'session-sweep' },
      create: { job: 'session-sweep', mode: 'off', setAt: new Date('2026-11-27T12:00:00.000Z'), setById: 'superadmin-1' },
      update: { mode: 'off', setAt: new Date('2026-11-27T12:00:00.000Z'), setById: 'superadmin-1' },
    });
    expect(logAuditEvent).toHaveBeenCalledWith({
      actorId: 'superadmin-1', action: 'job.update', targetType: 'job', targetId: 'session-sweep',
      metadata: { oldMode: 'on', newMode: 'off' },
    });
    expect(res.body.data).toMatchObject({ name: 'session-sweep', mode: 'off', setBy: { id: 'superadmin-1', username: 'root' }, setAt: '2026-11-27T12:00:00.000Z' });
    expect(prismaMock.jobSetting.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { job: { in: ['session-sweep'] } } }));
  });

  it('audits the stored mode as the old one', async () => {
    prismaMock.jobSetting.findUnique.mockResolvedValue({ mode: 'off' });
    await put('report-retention', { mode: 'on' });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'report-retention', metadata: { oldMode: 'off', newMode: 'on' } }));
  });

  it('refuses an administrator who is not a superadmin, and writes nothing', async () => {
    const res = await put('session-sweep', { mode: 'off' }, admin);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Super admin access required');
    expect(prismaMock.jobSetting.upsert).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown job', 'no-such-job', { mode: 'off' }, 'Unknown job'],
    ['a job that cannot be switched, even to on', 'presence-reaper', { mode: 'on' }, 'This job cannot be switched'],
    ['the voice reaper switched off', 'voice-reaper', { mode: 'off' }, 'This job cannot be switched'],
    ['an unknown mode', 'session-sweep', { mode: 'paused' }, 'Provide a mode: "off", "count" or "on"'],
    ['a mode that is not a string', 'session-sweep', { mode: false }, 'Provide a mode: "off", "count" or "on"'],
    ['no mode', 'session-sweep', {}, 'Provide a mode: "off", "count" or "on"'],
    ['count on a job without it', 'orphan-cleanup', { mode: 'count' }, 'This job has no count mode'],
  ])('answers 400 for %s, and writes nothing', async (_name, job, body, error) => {
    const res = await put(job, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(prismaMock.jobSetting.upsert).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is refused like a missing mode', async () => {
    const res = await request(app).put('/api/v1/admin/jobs/session-sweep').set('Authorization', `Bearer ${superadmin}`).set('Content-Type', 'text/plain').send('off');
    expect(res.status).toBe(400);
    expect(prismaMock.jobSetting.upsert).not.toHaveBeenCalled();
  });

  it('a failed write is an error, and nothing is audited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.jobSetting.upsert.mockRejectedValue(new Error('db down'));
    const res = await put('session-sweep', { mode: 'off' });
    expect(res.status).toBe(500);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
