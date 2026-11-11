/**
 * Multi-Node Horizontal Scaling Test
 *
 * Spawns 2 server instances on different ports and verifies cross-node behavior:
 * 1. Socket.IO Redis adapter (events cross nodes)
 * 2. Presence (user online on node-1 visible from node-2)
 * 3. DM voice state in Redis (cross-node call setup)
 * 4. Server voice metadata in Redis (connecting client sees voice state from other node)
 * 5. Config propagation (feature flag change propagates across nodes)
 * 6. SERVER VOICE with real WebRTC media across nodes (HIGH-15 / P2-MN):
 *    channel-affinity ownership, signaling relay for remote participants,
 *    bidirectional RTP through the owner node, cross-node mute/moderation/
 *    screen-share slot authority, cleanup on leave
 * 7. Visibility resync across nodes, with a silent peer on the adapter's
 *    request channel (issue #71): a member on node-2 loses and regains a
 *    private channel's `message:new` live, without reconnecting, when the
 *    owner changes their role, the channel's override or deletes the role
 *    through node-1
 * 8. Owner-node crash: dead owner's channel taken over by the surviving node
 *    (skip with SKIP_CRASH_TEST=1 — it waits out the 30s heartbeat TTL)
 *
 * Usage:
 *   npx tsx scripts/test-multi-node.ts
 *
 * Requires: PostgreSQL + Redis running, apps/server/.env configured, and
 * ports 3001/3002 free (the run refuses to start next to a dev backend).
 *
 * Repeatable: the run creates its space "MultiNode Test Server" and deletes it
 * at the end; one an interrupted run left behind is deleted at the next start
 * (the test account may own only MAX_SERVERS_PER_USER spaces). Both servers
 * are stopped with their whole process tree on every exit path (Windows:
 * taskkill /T, scripts/lib/processTree.mjs), so none is left holding a port.
 */

import { spawn, type ChildProcess } from 'child_process';
import axios from 'axios';
import { killProcessTree } from './lib/processTree.mjs';
import { portProblem } from './lib/portProbe.mjs';
import { registerTestUser, closeRegisterTestUserDb } from './lib/registerTestUser';
import { io as ioClient, type Socket } from 'socket.io-client';
import path from 'path';
import { createClient as createRedisClient } from 'redis';
import { Device } from 'mediasoup-client';
import { Chrome111 } from 'mediasoup-client/handlers/Chrome111';
import type {
  RtpCapabilities,
  IceParameters,
  IceCandidate,
  DtlsParameters,
  RtpParameters,
  Transport,
} from 'mediasoup-client/types';
import wrtc from '@roamhq/wrtc';
import { nonstandard } from '@roamhq/wrtc';

// Inject Node.js WebRTC globals for mediasoup-client
(globalThis as any).RTCPeerConnection = wrtc.RTCPeerConnection;
(globalThis as any).RTCSessionDescription = wrtc.RTCSessionDescription;
(globalThis as any).RTCIceCandidate = wrtc.RTCIceCandidate;
(globalThis as any).MediaStream = wrtc.MediaStream;
(globalThis as any).MediaStreamTrack = wrtc.MediaStreamTrack;
(globalThis as any).RTCRtpSender = wrtc.RTCRtpSender;
(globalThis as any).RTCRtpReceiver = wrtc.RTCRtpReceiver;

const NODE1_PORT = 3001;
const NODE2_PORT = 3002;
// Must match the ranges passed to startServer() below — used to prove WHERE
// a transport's media actually lives (channel affinity: always the owner node).
// Neither range starts at 10000: with one WebRtcServer per worker a node binds
// MIN_PORT + slot deterministically, so a range shared with `pnpm dev`'s
// server (apps/server/.env, MIN_PORT=10000) would make whichever boots second
// fail at startup instead of coexisting as the old random-port mode did.
const NODE1_PORTS: [number, number] = [10100, 10199];
const NODE2_PORTS: [number, number] = [10200, 10299];
const API1 = `http://localhost:${NODE1_PORT}/api/v1`;
const API2 = `http://localhost:${NODE2_PORT}/api/v1`;
const WS1 = `http://localhost:${NODE1_PORT}`;
const WS2 = `http://localhost:${NODE2_PORT}`;
const PASSWORD = 'password123';
const TEST_SPACE_NAME = 'MultiNode Test Server';

let node1: ChildProcess | null = null;
let node2: ChildProcess | null = null;
/** The space this run created, deleted by cleanup() as its owner. */
let testSpace: { id: string; ownerToken: string } | null = null;
let passed = 0;
let failed = 0;
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    results.push({ name, pass: false, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRunning(child: ChildProcess | null): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function waitForServer(port: number, child: ChildProcess, maxWait = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    // A server that died at boot never answers: stop waiting for it
    if (!isRunning(child)) return false;
    try {
      await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

function startServer(port: number, nodeId: string, mediasoupMinPort: number, mediasoupMaxPort: number): ChildProcess {
  const serverEntry = path.resolve('apps/server/src/index.ts');
  // This node binary with tsx's loader, no shell and no npx: the pid we hold
  // IS the server, so stopping it stops the server (its mediasoup workers are
  // its own children, which the tree kill in cleanup() also ends). `--import
  // tsx` resolves from the cwd, apps/server, which depends on tsx.
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    // dotenv resolves .env from CWD — must be apps/server or the boot-time
    // env validation kills the process before it ever listens
    cwd: path.resolve('apps/server'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ID: nodeId,
      MEDIASOUP_MIN_PORT: String(mediasoupMinPort),
      MEDIASOUP_MAX_PORT: String(mediasoupMaxPort),
      MEDIASOUP_NUM_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Prefix output with node ID
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`    [${nodeId}] ${line}`);
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`    [${nodeId}:err] ${line}`);
    }
  });

  return child;
}

async function login(api: string, username: string): Promise<string> {
  const res = await axios.post(`${api}/auth/login`, { email: `${username}@example.com`, password: PASSWORD });
  return res.data.data.accessToken;
}

async function registerUser(api: string, username: string): Promise<string> {
  try {
    // Verify-first registration: proof-of-work + consent (dev difficulty is
    // tiny; same code path as production), then the known code set in the DB
    const data = await registerTestUser(api, {
      username,
      email: `${username}@multinode.test`,
      password: PASSWORD,
    });
    return data.accessToken;
  } catch (err: any) {
    if (err.response?.status === 409) {
      // Already exists, login
      const res = await axios.post(`${api}/auth/login`, {
        email: `${username}@multinode.test`,
        password: PASSWORD,
      });
      const token = res.data.data.accessToken;
      // An account left over from a run before consent-at-signup existed has
      // null acceptance timestamps, and the server refuses it everything —
      // the socket handshake included — until it accepts, exactly as a real
      // client would on its consent screen. Idempotent for one that already has.
      if (res.data.data.user?.consentRequired) {
        await axios.post(`${api}/auth/consent`, { acceptTerms: true, acceptPrivacy: true }, { headers: { Authorization: `Bearer ${token}` } });
      }
      return token;
    }
    throw err;
  }
}

function connectSocket(ws: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(ws, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connection timeout')), 10000);
  });
}

// ─── Test space ─────────────────────────────────────────────────────────────

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });

function errorText(err: any): string {
  return err?.response?.data?.error || err?.message || String(err);
}

/** Delete this account's leftover test spaces, then create a fresh one with
 *  the second user in it. Returns the space id. */
async function setUpTestSpace(ownerToken: string, memberToken: string): Promise<string> {
  const me = await axios.get(`${API1}/auth/me`, auth(ownerToken));
  const ownerId: string = me.data.data.id;
  const mine = await axios.get(`${API1}/servers`, auth(ownerToken));
  const leftovers = (mine.data.data as Array<{ id: string; name: string; ownerId: string }>)
    .filter((s) => s.ownerId === ownerId && s.name === TEST_SPACE_NAME);
  for (const s of leftovers) {
    await axios.delete(`${API1}/servers/${s.id}`, auth(ownerToken));
    console.log(`Deleted the test space an earlier run left behind: ${s.id}`);
  }

  const serverRes = await axios.post(`${API1}/servers`, { name: TEST_SPACE_NAME }, auth(ownerToken));
  const serverId: string = serverRes.data.data.id;
  testSpace = { id: serverId, ownerToken };

  // Create an invite and have user2 join
  const inviteRes = await axios.post(`${API1}/invites/servers/${serverId}`, {}, auth(ownerToken));
  const code = inviteRes.data.data.code;
  await axios.post(`${API2}/invites/${code}/join`, {}, auth(memberToken));
  return serverId;
}

/** Delete the run's space through a node still running (node-1 is gone after
 *  the crash test). Never throws: a space left behind is deleted at the next
 *  start. */
async function deleteTestSpace(): Promise<void> {
  if (!testSpace) return;
  const { id, ownerToken } = testSpace;
  testSpace = null;
  const apis = [isRunning(node2) ? API2 : null, isRunning(node1) ? API1 : null].filter((a): a is string => a !== null);
  for (const api of apis) {
    try {
      await axios.delete(`${api}/servers/${id}`, auth(ownerToken));
      console.log(`Test space deleted: ${id}`);
      return;
    } catch (err: any) {
      console.warn(`Could not delete the test space through ${api}: ${errorText(err)}`);
    }
  }
  console.warn(`The test space ${id} was left behind; the next run deletes it before it starts`);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

let cleanupDone: Promise<void> | null = null;

/** Delete the test space, then stop both servers with their process trees.
 *  Idempotent: every exit path calls it, and they can overlap. */
function cleanup(): Promise<void> {
  if (!cleanupDone) {
    cleanupDone = (async () => {
      try {
        await deleteTestSpace();
      } catch (err) {
        console.warn('Test space cleanup failed:', errorText(err));
      }
      const running = [node1, node2];
      node1 = null;
      node2 = null;
      await Promise.all(running.map((child) => killProcessTree(child)));
      await sleep(1000);
    })();
  }
  return cleanupDone;
}

async function exitAfterCleanup(code: number): Promise<never> {
  await cleanup();
  process.exit(code);
}

process.on('SIGINT', () => { void exitAfterCleanup(1); });
process.on('SIGTERM', () => { void exitAfterCleanup(1); });
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  void exitAfterCleanup(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void exitAfterCleanup(1);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testPresenceCrossNode(token1: string, token2: string) {
  console.log('\n── Test: Presence Cross-Node ──');

  const sock1 = await connectSocket(WS1, token1);
  // Give time for node-1 to broadcast online
  await sleep(1000);

  // Connect to node-2 and check if user from node-1 is visible
  // Node-2 should see the user as online via Redis
  const res = await axios.get(`${API2}/admin/stats/live`, {
    headers: { Authorization: `Bearer ${token2}` },
  }).catch(() => null);

  if (res) {
    assert(res.data.data.onlineUsers >= 1, 'Online user count visible from node-2');
  } else {
    assert(false, 'Online user count visible from node-2', 'API call failed (user may not be admin)');
  }

  sock1.disconnect();
  await sleep(500);
}

async function testSocketEventsCrossNode(token1: string, token2: string, serverId: string) {
  console.log('\n── Test: Socket Events Cross-Node ──');

  const sock1 = await connectSocket(WS1, token1);
  const sock2 = await connectSocket(WS2, token2);
  await sleep(1000);

  // Test: presence update from node-1 should reach node-2
  let presenceReceived = false;
  sock2.on('presence:update', (data: any) => {
    if (data.userId && data.status === 'online') {
      presenceReceived = true;
    }
  });

  // Wait a bit for any pending events
  await sleep(2000);

  // Test: typing indicator cross-node
  // Both sockets should be in the same server's channel rooms
  // Find a text channel in the server
  let typingReceived = false;
  const channelsRes = await axios.get(`${API1}/servers/${serverId}/channels`, {
    headers: { Authorization: `Bearer ${token1}` },
  }).catch(() => null);

  if (channelsRes) {
    const textChannel = channelsRes.data.data.find((c: any) => c.type === 'text');
    if (textChannel) {
      sock2.on('typing:start', (data: any) => {
        if (data.channelId === textChannel.id) {
          typingReceived = true;
        }
      });

      sock1.emit('typing:start', textChannel.id);
      await sleep(1000);

      assert(typingReceived, 'Typing indicator crosses nodes via Redis adapter');
    } else {
      assert(false, 'Typing indicator crosses nodes via Redis adapter', 'No text channel found');
    }
  } else {
    assert(false, 'Typing indicator crosses nodes via Redis adapter', 'Could not fetch channels');
  }

  sock1.disconnect();
  sock2.disconnect();
  await sleep(500);
}

async function testDMVoiceStateCrossNode(token1: string, token2: string) {
  console.log('\n── Test: DM Voice State in Redis ──');

  const sock1 = await connectSocket(WS1, token1);
  const sock2 = await connectSocket(WS2, token2);
  await sleep(1000);

  // Create a DM conversation between the two users
  const user1Res = await axios.get(`${API1}/auth/me`, {
    headers: { Authorization: `Bearer ${token1}` },
  });
  const user2Res = await axios.get(`${API2}/auth/me`, {
    headers: { Authorization: `Bearer ${token2}` },
  });

  const user1Id = user1Res.data.data.id;
  const user2Id = user2Res.data.data.id;

  // Start or get DM conversation
  let convId: string | null = null;
  try {
    const dmRes = await axios.post(`${API1}/dm`, { userId: user2Id }, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    convId = dmRes.data.data.id;
  } catch (err: any) {
    // Might already exist — try fetching
    const convRes = await axios.get(`${API1}/dm`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const conv = convRes.data.data.find((c: any) =>
      (c.user1Id === user1Id && c.user2Id === user2Id) ||
      (c.user1Id === user2Id && c.user2Id === user1Id)
    );
    convId = conv?.id ?? null;
  }

  if (!convId) {
    assert(false, 'DM voice: create conversation', 'Could not create or find DM conversation');
    sock1.disconnect();
    sock2.disconnect();
    return;
  }

  assert(true, 'DM voice: conversation exists');

  // Join DM rooms
  sock1.emit('dm:join', convId);
  sock2.emit('dm:join', convId);
  await sleep(500);

  // User 1 starts a DM call from node-1
  let offerReceived = false;
  sock2.on('dm:voice:offer', (data: any) => {
    if (data.conversationId === convId) {
      offerReceived = true;
    }
  });

  sock1.emit('dm:voice:join', convId, { selfMute: false, selfDeaf: false });
  await sleep(2000);

  assert(offerReceived, 'DM voice offer received on node-2 (cross-node via Redis adapter)');

  // User 2 joins the call from node-2
  let joinedReceived = false;
  sock1.on('dm:voice:joined', (data: any) => {
    if (data.conversationId === convId && data.user?.id === user2Id) {
      joinedReceived = true;
    }
  });

  sock2.emit('dm:voice:join', convId, { selfMute: false, selfDeaf: false });
  await sleep(2000);

  assert(joinedReceived, 'DM voice joined event received on node-1 (cross-node)');

  // Test signal relay cross-node
  let signalReceived = false;
  sock2.on('dm:voice:signal', (data: any) => {
    if (data.from === user1Id && data.signal?.test === true) {
      signalReceived = true;
    }
  });

  sock1.emit('dm:voice:signal', { to: user2Id, signal: { test: true } });
  await sleep(1000);

  assert(signalReceived, 'DM voice signal relayed cross-node via Redis');

  // Test mute state update cross-node
  let muteReceived = false;
  sock2.on('dm:voice:state_update', (data: any) => {
    if (data.userId === user1Id && data.selfMute === true) {
      muteReceived = true;
    }
  });

  sock1.emit('dm:voice:mute', true);
  await sleep(1000);

  assert(muteReceived, 'DM voice mute state update received cross-node');

  // Leave the call
  let endedReceived = false;
  sock2.on('dm:voice:ended', (data: any) => {
    if (data.conversationId === convId) {
      endedReceived = true;
    }
  });

  sock1.emit('dm:voice:leave', convId);
  await sleep(1000);

  assert(endedReceived, 'DM voice ended event received cross-node');

  sock1.disconnect();
  sock2.disconnect();
  await sleep(500);
}

async function testConfigPropagation(token1: string) {
  console.log('\n── Test: Config Propagation ──');

  // Get current feature flags from both nodes
  const flags1Before = await axios.get(`${API1}/admin/feature-flags`, {
    headers: { Authorization: `Bearer ${token1}` },
  }).catch(() => null);

  const flags2Before = await axios.get(`${API2}/admin/feature-flags`, {
    headers: { Authorization: `Bearer ${token1}` },
  }).catch(() => null);

  if (!flags1Before || !flags2Before) {
    assert(false, 'Config propagation', 'Could not fetch feature flags (user may not be admin)');
    return;
  }

  // Toggle a feature flag on node-1
  const supportFlag = flags1Before.data.data.find((f: any) => f.name === 'support');
  const originalState = supportFlag?.enabled ?? true;

  await axios.put(`${API1}/admin/feature-flags/support`, { enabled: !originalState }, {
    headers: { Authorization: `Bearer ${token1}` },
  });

  // Wait for propagation
  await sleep(1000);

  // Check node-2 sees the change
  const flags2After = await axios.get(`${API2}/admin/feature-flags`, {
    headers: { Authorization: `Bearer ${token1}` },
  });

  const supportFlag2 = flags2After.data.data.find((f: any) => f.name === 'support');
  assert(supportFlag2?.enabled === !originalState, 'Feature flag change propagated to node-2');

  // Restore original state
  await axios.post(`${API1}/admin/feature-flags/support/reset`, {}, {
    headers: { Authorization: `Bearer ${token1}` },
  });
  await sleep(500);
}

async function testAdminStatsCrossNode(token: string) {
  console.log('\n── Test: Admin Stats Aggregation ──');

  // Both nodes should report stats from Redis (aggregated)
  const stats1 = await axios.get(`${API1}/admin/stats/live`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  const stats2 = await axios.get(`${API2}/admin/stats/live`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  if (stats1 && stats2) {
    assert(
      stats1.data.data.onlineUsers === stats2.data.data.onlineUsers,
      'Online user count consistent across nodes'
    );
    assert(
      stats1.data.data.voiceChannels === stats2.data.data.voiceChannels,
      'Voice channel count consistent across nodes'
    );
    assert(
      stats1.data.data.dmCalls === stats2.data.data.dmCalls,
      'DM call count consistent across nodes'
    );
  } else {
    assert(false, 'Admin stats accessible from both nodes', 'API calls failed');
  }
}

// ─── Server voice with real media (HIGH-15 / P2-MN validation) ──────────────

interface TransportOptions {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

interface TransportCreatedPayload {
  routerRtpCapabilities: unknown;
  sendTransport: TransportOptions;
  recvTransport: TransportOptions;
}

/** Ports a transport's ICE candidates listen on — proves which node hosts the media. */
function candidatePorts(t: TransportOptions): number[] {
  return ((t.iceCandidates as Array<{ port: number }>) ?? []).map((c) => c.port);
}

function portsInRange(ports: number[], [min, max]: [number, number]): boolean {
  return ports.length > 0 && ports.every((p) => p >= min && p <= max);
}

/** A full WebRTC voice participant (mediasoup-client + wrtc, like the real app). */
class VoiceClient {
  socket!: Socket;
  userId = '';
  transportInfo: TransportCreatedPayload | null = null;
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private audioInterval: ReturnType<typeof setInterval> | null = null;
  private sinks: Array<{ stop: () => void }> = [];
  /** producerUserId -> decoded audio frames received (proof RTP flows) */
  readonly framesFrom = new Map<string, number>();
  /** recorded broadcast events for assertions */
  readonly events: Array<{ name: string; data: any }> = [];

  constructor(readonly label: string, private readonly ws: string, private readonly token: string, private readonly api: string) {}

  async connect(): Promise<void> {
    const meRes = await axios.get(`${this.api}/auth/me`, { headers: { Authorization: `Bearer ${this.token}` } });
    this.userId = meRes.data.data.id;
    this.socket = await connectSocket(this.ws, this.token);
    for (const name of [
      'voice:user_joined', 'voice:user_left', 'voice:state_update', 'voice:speaking',
      'voice:screen_share:start', 'voice:screen_share:stop', 'voice:error',
    ]) {
      this.socket.on(name, (data: any) => this.events.push({ name, data }));
    }
  }

  /** Wait until a recorded event matches (events arrive async across nodes). */
  async waitFor(name: string, pred: (data: any) => boolean, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.events.some((e) => e.name === name && pred(e.data))) return true;
      await sleep(100);
    }
    return false;
  }

  join(channelId: string): Promise<TransportCreatedPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: voice:join timed out`)), 15000);
      this.socket.once('voice:transport_created', (data: TransportCreatedPayload) => {
        clearTimeout(timer);
        this.transportInfo = data;
        resolve(data);
      });
      this.socket.once('voice:error', (err: any) => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: voice:error — ${err?.message}`));
      });
      this.socket.emit('voice:join', channelId, { selfMute: false, selfDeaf: false });
    });
  }

  /** Device + transports + consumer plumbing (mirrors the desktop client). */
  async setupMedia(): Promise<void> {
    const data = this.transportInfo!;
    const device = new Device({ handlerFactory: Chrome111.createFactory({}) });
    await device.load({ routerRtpCapabilities: data.routerRtpCapabilities as RtpCapabilities });
    this.device = device;

    this.sendTransport = device.createSendTransport({
      id: data.sendTransport.id,
      iceParameters: data.sendTransport.iceParameters as IceParameters,
      iceCandidates: data.sendTransport.iceCandidates as IceCandidate[],
      dtlsParameters: data.sendTransport.dtlsParameters as DtlsParameters,
    });
    this.sendTransport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, cb: () => void) => {
      this.socket.emit('voice:transport:connect', { transportId: this.sendTransport!.id, dtlsParameters });
      cb();
    });
    this.sendTransport.on('produce', ({ kind, rtpParameters, appData }: { kind: string; rtpParameters: RtpParameters; appData: Record<string, unknown> }, cb: (arg: { id: string }) => void, errb: (err: Error) => void) => {
      this.socket.emit('voice:produce', { kind, rtpParameters, appData }, (resp: { producerId?: string; error?: string }) => {
        if (resp?.producerId) cb({ id: resp.producerId });
        else errb(new Error(resp?.error || 'produce rejected'));
      });
    });

    this.recvTransport = device.createRecvTransport({
      id: data.recvTransport.id,
      iceParameters: data.recvTransport.iceParameters as IceParameters,
      iceCandidates: data.recvTransport.iceCandidates as IceCandidate[],
      dtlsParameters: data.recvTransport.dtlsParameters as DtlsParameters,
    });
    this.recvTransport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, cb: () => void) => {
      this.socket.emit('voice:transport:connect', { transportId: this.recvTransport!.id, dtlsParameters });
      cb();
    });

    this.socket.on('voice:new_consumer', async (cd: {
      id: string; producerId: string; kind: string; rtpParameters: unknown; producerUserId: string;
    }) => {
      try {
        const consumer = await this.recvTransport!.consume({
          id: cd.id,
          producerId: cd.producerId,
          kind: cd.kind as 'audio' | 'video',
          rtpParameters: cd.rtpParameters as RtpParameters,
        });
        this.socket.emit('voice:consumer:resume', { consumerId: consumer.id });
        if (cd.kind === 'audio') {
          // Count decoded frames — the strongest possible "audio actually
          // arrives" proof, well beyond signaling assertions
          const sink = new nonstandard.RTCAudioSink(consumer.track as any);
          if (!this.framesFrom.has(cd.producerUserId)) this.framesFrom.set(cd.producerUserId, 0);
          (sink as any).ondata = () => {
            this.framesFrom.set(cd.producerUserId, (this.framesFrom.get(cd.producerUserId) ?? 0) + 1);
          };
          this.sinks.push(sink);
        }
      } catch { /* consumer failures surface via frame counts staying 0 */ }
    });

    this.socket.emit('voice:rtp_capabilities', { rtpCapabilities: device.rtpCapabilities });
  }

  async produceAudio(): Promise<void> {
    const source = new nonstandard.RTCAudioSource();
    const track = source.createTrack();
    const samples = new Int16Array(480); // 10ms @ 48kHz — audible sine so DTX won't silence it
    for (let i = 0; i < samples.length; i++) samples[i] = Math.floor(Math.sin(i * 0.06) * 3000);
    this.audioInterval = setInterval(() => {
      try {
        source.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: samples.length });
      } catch {
        if (this.audioInterval) clearInterval(this.audioInterval);
      }
    }, 10);
    await this.sendTransport!.produce({
      track,
      codecOptions: { opusStereo: false, opusDtx: false, opusFec: true },
      appData: { type: 'audio' },
    });
  }

  screenShareStart(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 10000);
      this.socket.emit('voice:screen_share:start', (resp: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(resp ?? { ok: false, error: 'empty ack' });
      });
    });
  }

  close(leave = true): void {
    if (this.audioInterval) clearInterval(this.audioInterval);
    for (const sink of this.sinks) { try { sink.stop(); } catch { /* */ } }
    try { this.sendTransport?.close(); } catch { /* */ }
    try { this.recvTransport?.close(); } catch { /* */ }
    if (this.socket) {
      if (leave) this.socket.emit('voice:leave');
      this.socket.disconnect();
    }
  }
}

async function findOrCreateVoiceChannel(api: string, token: string, serverId: string): Promise<string> {
  const h = { headers: { Authorization: `Bearer ${token}` } };
  const chRes = await axios.get(`${api}/servers/${serverId}/channels`, h);
  const existing = (chRes.data.data as Array<{ id: string; type: string }>).find((c) => c.type === 'voice');
  if (existing) return existing.id;
  const created = await axios.post(`${api}/servers/${serverId}/channels`, { name: 'multinode-voice', type: 'voice' }, h);
  return created.data.data.id;
}

async function testServerVoiceCrossNode(redis: any, token1: string, token2: string, serverId: string) {
  console.log('\n── Test: Server Voice Cross-Node (real media) ──');

  const channelId = await findOrCreateVoiceChannel(API1, token1, serverId);
  const ownerKey = `voice:channel:node:${channelId}`;

  const alice = new VoiceClient('alice@node1', WS1, token1, API1);
  const bob = new VoiceClient('bob@node2', WS2, token2, API2);
  await alice.connect();
  await bob.connect();
  await sleep(500);

  try {
    // 1. First joiner's node claims channel ownership
    await alice.join(channelId);
    const owner = await redis.get(ownerKey);
    assert(owner === 'node-1', 'Channel ownership claimed by first joiner\'s node', `owner=${owner}`);
    assert(
      portsInRange(candidatePorts(alice.transportInfo!.sendTransport), NODE1_PORTS),
      'Local participant transports listen on owner node ports',
      `ports=${candidatePorts(alice.transportInfo!.sendTransport).join(',')}`
    );

    await alice.setupMedia();
    await alice.produceAudio();

    // 2. Remote participant (socket on node-2) joins the node-1-owned channel
    await bob.join(channelId);
    assert(
      portsInRange(candidatePorts(bob.transportInfo!.sendTransport), NODE1_PORTS) &&
      portsInRange(candidatePorts(bob.transportInfo!.recvTransport), NODE1_PORTS),
      'CHANNEL AFFINITY: remote participant\'s media transports live on the OWNER node',
      `send=${candidatePorts(bob.transportInfo!.sendTransport).join(',')} recv=${candidatePorts(bob.transportInfo!.recvTransport).join(',')}`
    );
    assert((await redis.get(ownerKey)) === 'node-1', 'Ownership unchanged after remote join');

    const aliceSawBob = await alice.waitFor('voice:user_joined', (d) => JSON.stringify(d).includes(bob.userId));
    assert(aliceSawBob, 'voice:user_joined for remote participant crosses nodes');

    await bob.setupMedia();
    await bob.produceAudio();

    // 3. Real RTP both directions through the owner node's SFU
    await sleep(3000);
    assert(bob.framesFrom.get(alice.userId)! > 0, `RTP flows node1→SFU→node2 client (${bob.framesFrom.get(alice.userId) ?? 0} frames decoded)`);
    assert(alice.framesFrom.get(bob.userId)! > 0, `RTP flows node2→SFU→node1 client (${alice.framesFrom.get(bob.userId) ?? 0} frames decoded)`);

    // 4. Redis mirror sees both participants
    const mirror = await redis.hGetAll(`voice:channel:users:${channelId}`);
    assert(
      !!mirror[alice.userId] && !!mirror[bob.userId],
      'Redis mirror lists both participants',
      `keys=${Object.keys(mirror).join(',')}`
    );

    // 5. Self-mute from the relayed participant reaches the other node
    bob.socket.emit('voice:mute', true);
    const aliceSawMute = await alice.waitFor('voice:state_update', (d) => d?.userId === bob.userId && d?.selfMute === true);
    assert(aliceSawMute, 'Remote participant mute state crosses nodes');
    bob.socket.emit('voice:mute', false);

    // 6. Speaking indicator crosses nodes
    bob.socket.emit('voice:speaking', true);
    const aliceSawSpeaking = await alice.waitFor('voice:speaking', (d) => d?.userId === bob.userId && d?.speaking === true);
    assert(aliceSawSpeaking, 'Speaking indicator crosses nodes');

    // 7. Screen-share slot authority is enforced on the owner node
    const bobClaim = await bob.screenShareStart();
    assert(bobClaim.ok === true, 'Remote participant claims screen-share slot (relayed ACK)', bobClaim.error);
    const aliceClaim = await alice.screenShareStart();
    assert(aliceClaim.ok === false, 'Second sharer rejected while slot is taken (single authority)', JSON.stringify(aliceClaim));
    bob.socket.emit('voice:screen_share:stop');
    const aliceSawStop = await alice.waitFor('voice:screen_share:stop', (d) => JSON.stringify(d).includes(bob.userId));
    assert(aliceSawStop, 'Screen-share stop broadcast crosses nodes');
    const aliceReclaim = await alice.screenShareStart();
    assert(aliceReclaim.ok === true, 'Slot claimable again after remote stop', aliceReclaim.error);
    alice.socket.emit('voice:screen_share:stop');

    // 8. Cross-node moderation: node-1 moderator server-mutes the node-2 target
    alice.socket.emit('voice:server_mute', { userId: bob.userId, muted: true });
    const bobSawServerMute = await bob.waitFor('voice:state_update', (d) => d?.userId === bob.userId && d?.serverMuted === true);
    assert(bobSawServerMute, 'MODERATION: server-mute of a remote participant executes on owner + reaches target node');
    alice.socket.emit('voice:server_mute', { userId: bob.userId, muted: false }); // clear persisted state
    await bob.waitFor('voice:state_update', (d) => d?.userId === bob.userId && d?.serverMuted === false);

    // 9. Leave propagates + full cleanup once the channel empties
    bob.socket.emit('voice:leave');
    const aliceSawLeave = await alice.waitFor('voice:user_left', (d) => JSON.stringify(d).includes(bob.userId));
    assert(aliceSawLeave, 'voice:user_left crosses nodes');
    alice.socket.emit('voice:leave');
    await sleep(2000);
    const ownerAfter = await redis.get(ownerKey);
    const mirrorAfter = await redis.hGetAll(`voice:channel:users:${channelId}`);
    assert(ownerAfter === null, 'Ownership key released when channel empties', `owner=${ownerAfter}`);
    assert(Object.keys(mirrorAfter).length === 0, 'Redis mirror empty after both leave', `left=${Object.keys(mirrorAfter).join(',')}`);
  } finally {
    alice.close(false);
    bob.close(false);
    await sleep(500);
  }
}

async function testOwnerCrashTakeover(redis: any, token1: string, token2: string, serverId: string) {
  console.log('\n── Test: Owner-Node Crash Takeover (waits out the 30s heartbeat) ──');

  const channelId = await findOrCreateVoiceChannel(API1, token1, serverId);
  const ownerKey = `voice:channel:node:${channelId}`;

  // Establish node-1 as the channel owner with a remote participant on node-2
  const alice = new VoiceClient('alice@node1', WS1, token1, API1);
  const bob = new VoiceClient('bob@node2', WS2, token2, API2);
  await alice.connect();
  await bob.connect();
  await alice.join(channelId);
  await bob.join(channelId);
  assert((await redis.get(ownerKey)) === 'node-1', 'Pre-crash: node-1 owns the channel');

  // Crash the owner: no graceful shutdown hook runs (POSIX SIGKILL; Windows
  // taskkill /T /F, which also ends its mediasoup worker)
  console.log('    Killing node-1 (owner) hard...');
  await killProcessTree(node1, { signal: 'SIGKILL' });
  node1 = null;

  // Wait for the heartbeat to expire so the peer can detect the death
  const hbStart = Date.now();
  let heartbeatGone = false;
  while (Date.now() - hbStart < 45000) {
    if ((await redis.get('node:alive:node-1')) === null) { heartbeatGone = true; break; }
    await sleep(1000);
  }
  assert(heartbeatGone, `Dead node's heartbeat expired (${Math.round((Date.now() - hbStart) / 1000)}s)`);

  // A fresh join via the surviving node must take the channel over
  const carol = new VoiceClient('carol@node2', WS2, token1, API2); // token1 user, now via node-2
  await carol.connect();
  try {
    await carol.join(channelId);
    const newOwner = await redis.get(ownerKey);
    assert(newOwner === 'node-2', 'TAKEOVER: surviving node claimed the dead owner\'s channel', `owner=${newOwner}`);
    assert(
      portsInRange(candidatePorts(carol.transportInfo!.sendTransport), NODE2_PORTS),
      'Post-takeover transports live on the surviving node',
      `ports=${candidatePorts(carol.transportInfo!.sendTransport).join(',')}`
    );
    await carol.setupMedia();
    await carol.produceAudio();
    assert(true, 'Post-takeover producer created (channel fully functional)');
  } catch (err: any) {
    assert(false, 'Takeover join after owner crash', err.message);
  } finally {
    carol.close();
    alice.close(false);
    bob.close(false);
    await sleep(500);
  }
}

// ─── Visibility resync across nodes (issue #71) ─────────────────────────────

/** Permissions.VIEW_CHANNEL (1n << 0n), as the role routes take it. */
const VIEW_CHANNEL = '1';
/** The Redis adapter's request channel for the default namespace: every node
 *  subscribes to it, and its subscriber count is how many replies a
 *  cluster-wide fetchSockets() waits for. */
const ADAPTER_REQUEST_CHANNEL = 'socket.io-request#/#';

/**
 * A member connected to node-2 sees a private channel through a role. The
 * owner, through node-1, takes the role away, gives it back, flips the role's
 * channel override both ways and finally deletes the role: after each step the
 * member's socket stops (or starts) receiving the channel's `message:new`
 * live, on the same socket, never reconnected.
 *
 * Throughout, a SILENT PEER is subscribed to the adapter's request channel: it
 * counts as a node but never answers a cluster request, like the stalled node
 * that shared the Redis on 2026-11-09. The old resync waited on every node's
 * answer to `io.in(room).fetchSockets()` and gave up after 5 s, so every
 * revocation below failed open. (Every cluster snapshot times out while it is
 * subscribed, so it is scoped to this test and always removed.)
 */
async function testVisibilityResyncCrossNode(redis: any, ownerToken: string, memberToken: string, serverId: string) {
  console.log('\n── Test: Visibility Resync Across Nodes, One Peer Silent ──');

  const silentPeer = redis.duplicate();
  await silentPeer.connect();
  await silentPeer.subscribe(ADAPTER_REQUEST_CHANNEL, () => { /* never answers */ });

  let member: Socket | null = null;
  try {
    const memberId: string = (await axios.get(`${API2}/auth/me`, auth(memberToken))).data.data.id;
    const channels = (await axios.get(`${API1}/servers/${serverId}/channels`, auth(ownerToken))).data.data as Array<{ id: string; type: string }>;
    const publicChannel = channels.find((c) => c.type === 'text');
    if (!publicChannel) throw new Error('the test space has no text channel');
    const privateChannel: string = (await axios.post(`${API1}/servers/${serverId}/channels`, { name: 'mn-private', type: 'text' }, auth(ownerToken))).data.data.id;
    const roles = (await axios.get(`${API1}/servers/${serverId}/roles`, auth(ownerToken))).data.data as Array<{ id: string; isDefault: boolean }>;
    const everyone = roles.find((r) => r.isDefault);
    if (!everyone) throw new Error('the test space has no @everyone role');
    const viewer: string = (await axios.post(`${API1}/servers/${serverId}/roles`, { name: 'mn-viewer' }, auth(ownerToken))).data.data.id;

    const override = (roleId: string, allow: string, deny: string) =>
      axios.put(`${API1}/servers/${serverId}/roles/channels/${privateChannel}/permissions/${roleId}`, { allow, deny }, auth(ownerToken));
    const assignRoles = (roleIds: string[]) =>
      axios.patch(`${API1}/servers/${serverId}/roles/members/${memberId}`, { roleIds }, auth(ownerToken));

    // Private: hidden from @everyone, shown to the role, the member holds the role
    await override(everyone.id, '0', VIEW_CHANNEL);
    await override(viewer, VIEW_CHANNEL, '0');
    await assignRoles([viewer]);

    member = await connectSocket(WS2, memberToken);
    const sock = member;
    const socketId = sock.id;
    let disconnects = 0;
    sock.on('disconnect', () => { disconnects++; });

    let probe = 0;
    /** Does the member receive a message posted to the private channel? A
     *  sentinel posted to the public channel right after it answers "no"
     *  without a bare sleep: node-1 publishes both in order on one connection,
     *  so once the sentinel is in, the private message would be too. */
    const receivesPrivate = async (): Promise<boolean> => {
      const tag = `mn-visibility-${Date.now()}-${++probe}`;
      let gotPrivate = false;
      let sentinelIn!: () => void;
      const sentinel = new Promise<void>((resolve) => { sentinelIn = resolve; });
      const onMessage = (msg: any) => {
        if (msg?.channelId === privateChannel && msg?.content === `${tag} private`) gotPrivate = true;
        if (msg?.channelId === publicChannel.id && msg?.content === `${tag} sentinel`) sentinelIn();
      };
      sock.on('message:new', onMessage);
      try {
        await axios.post(`${API1}/channels/${privateChannel}/messages`, { content: `${tag} private` }, auth(ownerToken));
        await axios.post(`${API1}/channels/${publicChannel.id}/messages`, { content: `${tag} sentinel` }, auth(ownerToken));
        const arrived = await Promise.race([sentinel.then(() => true), sleep(5000).then(() => false)]);
        if (!arrived) throw new Error('the sentinel in the public channel never reached the member');
        return gotPrivate;
      } finally {
        sock.off('message:new', onMessage);
      }
    };
    /** The resync is fire-and-forget after the response: look a few times
     *  (each look posts two messages; the owner may post 30 a minute). */
    const settlesTo = async (expected: boolean): Promise<boolean> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(500);
        if ((await receivesPrivate()) === expected) return true;
      }
      return false;
    };

    assert(await settlesTo(true), 'Baseline: the member on node-2 receives the private channel through the role');

    await assignRoles([]);
    assert(await settlesTo(false), 'Role taken away on node-1: the member on node-2 stops receiving the private channel (member-scoped resync)');
    await assignRoles([viewer]);
    assert(await settlesTo(true), 'Role given back: the member receives the private channel again, live');

    await override(viewer, '0', VIEW_CHANNEL);
    assert(await settlesTo(false), 'The role\'s channel override flipped to deny: the member stops receiving (channel-scoped resync)');
    await override(viewer, VIEW_CHANNEL, '0');
    assert(await settlesTo(true), 'The override flipped back to allow: the member receives the private channel again, live');

    await axios.delete(`${API1}/servers/${serverId}/roles/${viewer}`, auth(ownerToken));
    assert(await settlesTo(false), 'The role deleted: the member stops receiving (space-wide resync)');

    assert(
      sock.connected && sock.id === socketId && disconnects === 0,
      'The member\'s socket was never reconnected',
      `connected=${sock.connected} sameId=${sock.id === socketId} disconnects=${disconnects}`,
    );
  } finally {
    member?.disconnect();
    try {
      await silentPeer.unsubscribe(ADAPTER_REQUEST_CHANNEL);
      await silentPeer.quit();
    } catch (err: any) {
      console.warn('Could not close the silent peer\'s Redis connection:', err?.message ?? err);
    }
    await sleep(500);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Multi-Node Horizontal Scaling Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 0: a dev backend (or a server an earlier run left) on our ports would
  // answer /health for a node that never started. Probed on both wildcards
  // and both loopbacks (scripts/lib/portProbe.mjs).
  for (const port of [NODE1_PORT, NODE2_PORT]) {
    const problem = await portProblem(port);
    if (problem) {
      console.error(`\nFATAL: port ${port} cannot be used: ${problem}. Stop whatever holds it and run again`);
      process.exit(1);
    }
  }

  // Step 1: Start two server instances
  node1 = startServer(NODE1_PORT, 'node-1', NODE1_PORTS[0], NODE1_PORTS[1]);
  console.log(`Starting node-1 on port 3001 (pid ${node1.pid})...`);

  node2 = startServer(NODE2_PORT, 'node-2', NODE2_PORTS[0], NODE2_PORTS[1]);
  console.log(`Starting node-2 on port 3002 (pid ${node2.pid})...`);

  console.log('Waiting for servers to be ready...');
  const [ready1, ready2] = await Promise.all([
    waitForServer(NODE1_PORT, node1),
    waitForServer(NODE2_PORT, node2),
  ]);

  if (!ready1 || !ready2) {
    console.error(`\nFATAL: Servers failed to start (node-1: ${ready1}, node-2: ${ready2})`);
    await cleanup();
    process.exit(1);
  }
  console.log('Both nodes are ready!\n');

  // Step 2: Get admin token (use seed user alice)
  let adminToken: string;
  try {
    adminToken = await login(API1, 'alice');
    console.log('Logged in as alice (admin)');
  } catch (err: any) {
    console.error('Failed to login as alice:', err.response?.data || err.message);
    await cleanup();
    process.exit(1);
  }

  // Step 3: Register/login test users
  let user1Token: string;
  let user2Token: string;
  try {
    user1Token = await registerUser(API1, 'multinode_test1');
    user2Token = await registerUser(API2, 'multinode_test2');
    console.log('Test users ready\n');
  } catch (err: any) {
    console.error('Failed to create test users:', err.response?.data || err.message);
    await closeRegisterTestUserDb().catch((e) => console.warn('DB disconnect failed:', e.message));
    await cleanup();
    process.exit(1);
  }
  await closeRegisterTestUserDb().catch((e) => console.warn('DB disconnect failed:', e.message));

  // Step 4: Both users in a fresh shared space (cleanup() deletes it)
  let serverId: string | null = null;
  try {
    serverId = await setUpTestSpace(user1Token, user2Token);
    console.log(`Shared server created: ${serverId}\n`);
  } catch (err: any) {
    console.warn('Server setup warning:', errorText(err));
  }

  // ── Run tests ──────────────────────────────────────────────────────────

  try {
    await testAdminStatsCrossNode(adminToken);
  } catch (err: any) {
    assert(false, 'Admin stats test', err.message);
  }

  try {
    await testPresenceCrossNode(user1Token, adminToken);
  } catch (err: any) {
    assert(false, 'Presence cross-node test', err.message);
  }

  if (serverId) {
    try {
      await testSocketEventsCrossNode(user1Token, user2Token, serverId);
    } catch (err: any) {
      assert(false, 'Socket events cross-node test', err.message);
    }
  }

  try {
    await testDMVoiceStateCrossNode(user1Token, user2Token);
  } catch (err: any) {
    assert(false, 'DM voice cross-node test', err.message);
  }

  try {
    await testConfigPropagation(adminToken);
  } catch (err: any) {
    assert(false, 'Config propagation test', err.message);
  }

  // ── Server voice (real media) — the P2-MN validation ───────────────────
  const redis = createRedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await redis.connect();

  if (serverId) {
    try {
      await testServerVoiceCrossNode(redis, user1Token, user2Token, serverId);
    } catch (err: any) {
      assert(false, 'Server voice cross-node test', err.message);
    }

    try {
      await testVisibilityResyncCrossNode(redis, user1Token, user2Token, serverId);
    } catch (err: any) {
      assert(false, 'Visibility resync cross-node test', errorText(err));
    }

    if (process.env.SKIP_CRASH_TEST === '1') {
      console.log('\n── Skipping owner-crash test (SKIP_CRASH_TEST=1) ──');
    } else {
      try {
        // Runs LAST — it kills node-1
        await testOwnerCrashTakeover(redis, user1Token, user2Token, serverId);
      } catch (err: any) {
        assert(false, 'Owner crash takeover test', err.message);
      }
    }
  } else {
    assert(false, 'Server voice tests', 'No shared server available');
  }

  await redis.quit().catch(() => undefined);

  // ── Summary ────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed tests:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    console.log('');
  }

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await cleanup();
  process.exit(1);
});
