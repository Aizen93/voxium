/**
 * Voice Channel Load Test — Full Media
 *
 * Simulates N users per channel across multiple servers with actual
 * mediasoup producers and consumers (real WebRTC media flow).
 *
 * Usage:
 *   npx tsx scripts/load-test-voice.ts [USERS_PER_CHANNEL] [NUM_SERVERS]
 *
 * Defaults: 25 users per channel, 4 servers.
 * Requires the backend running on localhost:3001.
 *
 * It raises the rate limits it needs (admin overrides), joins every user with
 * full media and HOLDS them until Ctrl+C (or SIGTERM), then disconnects them
 * and restores the limits. Unattended runs set a hold time instead:
 *
 *   LOAD_TEST_HOLD_SECONDS=60 npx tsx scripts/load-test-voice.ts 10 2
 *
 * holds the clients 60 s after the last one joined, runs the same cleanup and
 * exits by itself: 0, or 1 when a user failed to join with media. A signal
 * still stops it earlier. A failure at any step also restores the limits.
 * The hold is 1 to 86400 s (a day); each request of the cleanup gives up
 * after 10 s, so a hung backend cannot keep the run alive.
 */

import axios from 'axios';
import { registerTestUser, closeRegisterTestUserDb } from './lib/registerTestUser';
import { signInOrRegister } from './lib/signInOrRegister';
import { io as ioClient, type Socket } from 'socket.io-client';
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

const API = 'http://localhost:3001/api/v1';
const WS = 'http://localhost:3001';
const USERS_PER_CHANNEL = parseInt(process.argv[2] || '25', 10);
const NUM_SERVERS = parseInt(process.argv[3] || '4', 10);
const PASSWORD = 'password123';
const SEED_EMAIL = 'alice@example.com';
const BATCH = 10;

// A day. setTimeout takes at most 2^31 - 1 ms (about 24.8 days) and fires at
// once above it, so the bound also keeps the timer meaningful.
const MAX_HOLD_SECONDS = 86_400;
// Each call on the way out (the seed sign-in, every limit reset) is bounded:
// a hung backend must not keep an unattended run alive
const CLEANUP_REQUEST_TIMEOUT_MS = 10_000;

/** Seconds to hold the clients before the automatic cleanup; null = until a signal. */
function parseHoldSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_HOLD_SECONDS) {
    console.error(`LOAD_TEST_HOLD_SECONDS must be a whole number of seconds from 1 to ${MAX_HOLD_SECONDS}, got "${raw}"`);
    process.exit(1);
  }
  return value;
}
const HOLD_SECONDS = parseHoldSeconds(process.env.LOAD_TEST_HOLD_SECONDS);

interface TransportOptions {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

interface TestUser {
  username: string;
  token: string;
  socket: Socket | null;
  device: Device | null;
  sendTransport: Transport | null;
  recvTransport: Transport | null;
  audioSource: any | null;
}

interface Target {
  serverId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  users: TestUser[];
}

const targets: Target[] = [];
const h = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
// registerDaily/registerSubnet/registerAttempt/registerAttemptSubnet: the
// long-window anti-bot buckets would cap a 25-user single-IP load test at 5 —
// they must be raised alongside 'register'. The two *Attempt buckets count
// every POST regardless of outcome and are never refunded, so a rerun after a
// partial failure hits them before the others; registerAttemptSubnet (300/day
// per /24) is the one a third default run of the day hits from one host.
// A raised limit does not shorten a counter that existed before it, so the
// accounts are signed in first and registered only when unknown
// (scripts/lib/signInOrRegister.ts): a rerun starts no registration at all.
// 'loginSubnet' is raised for the first run, whose sign-ins are all refused
// as unknown before the accounts exist (60 failures a minute per /24).
const LIMITS_TO_RAISE = ['login', 'loginSubnet', 'register', 'registerAttempt', 'registerAttemptSubnet', 'registerDaily', 'registerSubnet', 'registerComplete', 'registerDomain', 'admin', 'general'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** `timeoutMs` bounds each request (0, axios' default, waits forever). */
async function login(email: string, timeoutMs = 0): Promise<{ token: string; userId: string }> {
  const { data } = await axios.post(`${API}/auth/login`, { email, password: PASSWORD }, { timeout: timeoutMs });
  const r = data.data || data;
  // Accounts from runs before consent-at-signup existed are refused every
  // functional route and the socket until they accept (CNIL/GDPR gate) —
  // do what a real client does on its consent screen. Idempotent.
  if (r.user?.consentRequired) {
    await axios.post(`${API}/auth/consent`, { acceptTerms: true, acceptPrivacy: true }, { ...h(r.accessToken), timeout: timeoutMs });
  }
  return { token: r.accessToken, userId: r.user.id };
}

function errorText(err: unknown): string {
  if (axios.isAxiosError(err)) return err.response?.data?.error || err.message;
  return err instanceof Error ? err.message : String(err);
}

async function raiseRateLimits(token: string): Promise<void> {
  for (const name of LIMITS_TO_RAISE) {
    try {
      await axios.put(`${API}/admin/rate-limits/${name}`, { points: 99999, duration: 60, blockDuration: 0 }, h(token));
    } catch (err) {
      console.warn(`  could not raise '${name}': ${errorText(err)}`);
    }
  }
}

async function resetRateLimits(token: string): Promise<void> {
  // 'admin' last — once it is reset, the remaining reset calls are throttled
  // by the restored admin bucket and would be swallowed, leaving overrides up
  const order = [...LIMITS_TO_RAISE.filter((n) => n !== 'admin' && n !== 'general'), 'general', 'admin'];
  for (const name of order) {
    try {
      await axios.post(`${API}/admin/rate-limits/${name}/reset`, {}, { ...h(token), timeout: CLEANUP_REQUEST_TIMEOUT_MS });
    } catch (err) {
      console.warn(`  could not restore '${name}' (reset it from the admin dashboard): ${errorText(err)}`);
    }
  }
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(WS, { auth: { token }, transports: ['websocket'], timeout: 15000 });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Socket timeout')); }, 15000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Create a fake audio track producing silence (441 Hz sine tone at very low volume). */
function createFakeAudioTrack(): { track: MediaStreamTrack; source: any } {
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();

  // Generate 10ms of silence / low-level noise at 48kHz mono
  const sampleRate = 48000;
  const samples = new Int16Array(sampleRate / 100); // 480 samples = 10ms
  // Fill with near-silence (tiny sine so it's not literally zero)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.floor(Math.sin(i * 0.01) * 10);
  }

  const interval = setInterval(() => {
    try {
      source.onData({
        samples,
        sampleRate,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: samples.length,
      });
    } catch {
      clearInterval(interval);
    }
  }, 10);

  // Attach cleanup
  (track as any)._ltInterval = interval;
  return { track, source };
}

/** Full mediasoup setup: device → transports → produce audio → consume others. */
function setupMedia(user: TestUser, channelId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = user.socket!;
    const timer = setTimeout(() => resolve(), 20000);

    socket.once('voice:transport_created', async (data: {
      routerRtpCapabilities: unknown;
      sendTransport: TransportOptions;
      recvTransport: TransportOptions;
    }) => {
      clearTimeout(timer);
      try {
        // 1. Create Device
        const device = new Device({ handlerFactory: Chrome111.createFactory({}) });
        await device.load({ routerRtpCapabilities: data.routerRtpCapabilities as RtpCapabilities });
        user.device = device;

        // 2. Send transport
        const sendTransport = device.createSendTransport({
          id: data.sendTransport.id,
          iceParameters: data.sendTransport.iceParameters as IceParameters,
          iceCandidates: data.sendTransport.iceCandidates as IceCandidate[],
          dtlsParameters: data.sendTransport.dtlsParameters as DtlsParameters,
        });

        sendTransport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, callback: () => void) => {
          socket.emit('voice:transport:connect', { transportId: sendTransport.id, dtlsParameters });
          callback();
        });

        sendTransport.on('produce', ({ kind, rtpParameters, appData }: { kind: string; rtpParameters: RtpParameters; appData: Record<string, unknown> }, callback: (arg: { id: string }) => void) => {
          socket.emit('voice:produce', { kind, rtpParameters, appData }, (response: { producerId: string }) => {
            callback({ id: response.producerId });
          });
        });

        user.sendTransport = sendTransport;

        // 3. Recv transport
        const recvTransport = device.createRecvTransport({
          id: data.recvTransport.id,
          iceParameters: data.recvTransport.iceParameters as IceParameters,
          iceCandidates: data.recvTransport.iceCandidates as IceCandidate[],
          dtlsParameters: data.recvTransport.dtlsParameters as DtlsParameters,
        });

        recvTransport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, callback: () => void) => {
          socket.emit('voice:transport:connect', { transportId: recvTransport.id, dtlsParameters });
          callback();
        });

        user.recvTransport = recvTransport;

        // 4. Send RTP capabilities so server can create consumers for us
        socket.emit('voice:rtp_capabilities', { rtpCapabilities: device.rtpCapabilities });

        // 5. Handle incoming consumers
        socket.on('voice:new_consumer', async (consumerData: {
          id: string;
          producerId: string;
          kind: string;
          rtpParameters: unknown;
          producerUserId: string;
        }) => {
          try {
            const consumer = await recvTransport.consume({
              id: consumerData.id,
              producerId: consumerData.producerId,
              kind: consumerData.kind as 'audio' | 'video',
              rtpParameters: consumerData.rtpParameters as RtpParameters,
            });
            // Resume the consumer
            socket.emit('voice:consumer:resume', { consumerId: consumer.id });
          } catch { /* ignore consumer failures */ }
        });

        // 6. Produce fake audio
        if (device.canProduce('audio')) {
          const { track, source } = createFakeAudioTrack();
          user.audioSource = source;
          (user as any)._ltInterval = (track as any)._ltInterval;

          await sendTransport.produce({
            track,
            codecOptions: {
              opusStereo: false,
              opusDtx: true,
              opusFec: true,
            },
            appData: { type: 'audio' },
          });
        }

        resolve();
      } catch (err) {
        reject(err);
      }
    });

    socket.once('voice:error', (err: any) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });

    socket.emit('voice:join', channelId, { selfMute: false, selfDeaf: false });
  });
}

// ─── Cleanup (every way out: a signal, the hold elapsing, a failure) ─────────

let seedToken: string | null = null;
let limitsRaised = false;
let stopping = false;

function disconnectAll(): void {
  for (const t of targets) {
    for (const u of t.users) {
      if ((u as any)._ltInterval) clearInterval((u as any)._ltInterval);
      try { u.sendTransport?.close(); } catch (err) { console.warn(`  ${u.username}: closing the send transport failed: ${errorText(err)}`); }
      try { u.recvTransport?.close(); } catch (err) { console.warn(`  ${u.username}: closing the recv transport failed: ${errorText(err)}`); }
      if (u.socket) { u.socket.emit('voice:leave'); u.socket.disconnect(); }
    }
  }
}

async function restoreRateLimits(): Promise<void> {
  if (!limitsRaised) return;
  console.log('Restoring rate limits...');
  // A fresh token: the one from the start may have expired during a long hold.
  // Bounded like the resets; a timeout falls back to the first token.
  let token = seedToken;
  try {
    token = (await login(SEED_EMAIL, CLEANUP_REQUEST_TIMEOUT_MS)).token;
  } catch (err) {
    console.warn(`  could not sign the seed user in again (${errorText(err)}); trying the first token`);
  }
  if (!token) {
    console.warn('  no seed token: reset the overrides from the admin dashboard');
    return;
  }
  await resetRateLimits(token);
}

/** Disconnect every client, restore the rate limits, exit. Runs once. */
async function stop(code: number, reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n${reason}: disconnecting...`);
  disconnectAll();
  await restoreRateLimits();
  console.log('Done.');
  process.exit(code);
}

function onSignal(signal: NodeJS.Signals): void {
  if (stopping) {
    console.warn(`\n${signal} again: exiting now; the rate limits may still be raised (reset them from the admin dashboard)`);
    process.exit(1);
  }
  void stop(0, signal);
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const totalUsers = USERS_PER_CHANNEL * NUM_SERVERS;
  console.log(`\n=== Voice Load Test: ${NUM_SERVERS} servers x ${USERS_PER_CHANNEL} users = ${totalUsers} total (full media) ===\n`);

  // Step 1
  console.log('[1/5] Logging in as seed user...');
  const seed = await login(SEED_EMAIL);
  seedToken = seed.token;
  console.log(`  OK`);

  // Step 2
  console.log('\n[2/5] Raising rate limits...');
  limitsRaised = true; // before the calls: a partial raise is restored too
  await raiseRateLimits(seed.token);
  console.log('  Done');

  // Step 3
  console.log(`\n[3/5] Finding ${NUM_SERVERS} servers with voice channels...`);
  const { data: serverData } = await axios.get(`${API}/servers`, h(seed.token));
  const servers = serverData.data;
  if (servers.length < NUM_SERVERS) throw new Error(`Need ${NUM_SERVERS} servers, seed is in ${servers.length}.`);

  for (let s = 0; s < NUM_SERVERS; s++) {
    const srv = servers[s];
    const { data: chData } = await axios.get(`${API}/servers/${srv.id}/channels`, h(seed.token));
    const voiceCh = (chData.data as any[]).find((c) => c.type === 'voice');
    if (!voiceCh) throw new Error(`No voice channel in "${srv.name}".`);
    targets.push({ serverId: srv.id, serverName: srv.name, channelId: voiceCh.id, channelName: voiceCh.name, users: [] });
    console.log(`  [${s + 1}] ${srv.name} → #${voiceCh.name}`);
  }

  // Step 4
  console.log(`\n[4/5] Creating ${totalUsers} users...`);
  let created = 0;
  for (let s = 0; s < targets.length; s++) {
    const target = targets[s];
    for (let i = 0; i < USERS_PER_CHANNEL; i += BATCH) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH, USERS_PER_CHANNEL); j++) {
        const username = `lt_s${s}_u${j}`;
        const email = `${username}@loadtest.local`;
        batch.push(
          (async () => {
            // Signed in first, registered only when the account does not exist
            // yet (an earlier run made it): scripts/lib/signInOrRegister.ts
            const { token } = await signInOrRegister(
              () => login(email),
              async () => {
                try {
                  // Verify-first: start, known code set in the DB, complete
                  await registerTestUser(API, { username, email, password: PASSWORD });
                } catch (err) {
                  console.warn(`  register ${username} failed:`, axios.isAxiosError(err) ? err.response?.data ?? err.message : (err as Error).message);
                  throw err;
                }
                return login(email);
              },
            );
            try {
              const { data: inv } = await axios.post(`${API}/invites/servers/${target.serverId}`, {}, h(seed.token));
              const code = inv.data?.code || inv.code;
              await axios.post(`${API}/invites/${code}/join`, {}, h(token));
            } catch { /* already member */ }
            target.users.push({ username, token, socket: null, device: null, sendTransport: null, recvTransport: null, audioSource: null });
            created++;
          })()
        );
      }
      await Promise.all(batch);
      process.stdout.write(`  ${created}/${totalUsers}\r`);
    }
  }
  console.log(`  ${created} users ready                `);
  await closeRegisterTestUserDb();

  // Step 5
  console.log(`\n[5/5] Joining voice channels with full media...`);
  let connected = 0;
  let failed = 0;
  const MEDIA_BATCH = 3; // smaller batches — each user does full WebRTC setup

  for (const target of targets) {
    console.log(`  ${target.serverName} → #${target.channelName}...`);
    for (let i = 0; i < target.users.length; i += MEDIA_BATCH) {
      const batch = [];
      for (let j = i; j < Math.min(i + MEDIA_BATCH, target.users.length); j++) {
        const u = target.users[j];
        batch.push(
          (async () => {
            try {
              u.socket = await connectSocket(u.token);
              await setupMedia(u, target.channelId);
              connected++;
            } catch (err: any) {
              failed++;
              console.error(`    FAIL ${u.username}: ${err.message}`);
            }
          })()
        );
      }
      await Promise.all(batch);
      process.stdout.write(`    ${connected} connected, ${failed} failed\r`);
    }
    const sc = target.users.filter((u) => u.socket?.connected).length;
    console.log(`    ${sc}/${target.users.length} connected          `);
  }

  console.log(`\n=== Results ===`);
  console.log(`Connected with media: ${connected}/${totalUsers}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
  console.log(`\nCheck admin dashboard SFU stats — you should see producers + consumers.`);
  if (HOLD_SECONDS === null) {
    console.log(`Press Ctrl+C to disconnect and restore rate limits.\n`);
  } else {
    console.log(`Holding for ${HOLD_SECONDS} s, then disconnecting and restoring rate limits (Ctrl+C stops earlier).\n`);
    setTimeout(() => { void stop(failed > 0 ? 1 : 0, `${HOLD_SECONDS} s elapsed`); }, HOLD_SECONDS * 1000);
  }
}

run().catch((err) => {
  console.error('\nLoad test failed:', err.response?.data || err.message);
  void stop(1, 'Load test failed');
});
