/**
 * Voice Optimization Verification Script — Multi-Server Stress Test
 *
 * Tests silence detection, producer pause/resume, mute override,
 * and bandwidth caps across multiple servers with real mediasoup connections.
 *
 * Usage:
 *   npx tsx scripts/test-voice-optimizations.ts [USERS_PER_CHANNEL] [NUM_SERVERS]
 *
 * Defaults: 25 users per channel, 4 servers = 100 total users.
 * Requires: backend running on localhost:3001, seed data (alice@example.com).
 */

import axios from 'axios';
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
  Producer,
} from 'mediasoup-client/types';
import wrtc from '@roamhq/wrtc';
import { nonstandard } from '@roamhq/wrtc';

// Inject Node.js WebRTC globals
(globalThis as any).RTCPeerConnection = wrtc.RTCPeerConnection;
(globalThis as any).RTCSessionDescription = wrtc.RTCSessionDescription;
(globalThis as any).RTCIceCandidate = wrtc.RTCIceCandidate;
(globalThis as any).MediaStream = wrtc.MediaStream;
(globalThis as any).MediaStreamTrack = wrtc.MediaStreamTrack;
(globalThis as any).RTCRtpSender = wrtc.RTCRtpSender;
(globalThis as any).RTCRtpReceiver = wrtc.RTCRtpReceiver;

const API = 'http://localhost:3001/api/v1';
const WS = 'http://localhost:3001';
const PASSWORD = 'password123';
const SEED_EMAIL = 'alice@example.com';
const USERS_PER_CHANNEL = parseInt(process.argv[2] || '25', 10);
const NUM_SERVERS = parseInt(process.argv[3] || '4', 10);
const MEDIA_BATCH = 3; // users joined in parallel per batch (limits wrtc memory pressure)

interface TransportOptions {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

interface TestUser {
  username: string;
  token: string;
  socket: Socket;
  device: Device;
  sendTransport: Transport;
  recvTransport: Transport;
  producer: Producer | null;
  audioInterval: ReturnType<typeof setInterval> | null;
}

interface Target {
  serverId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  users: TestUser[];
}

interface DiagUser {
  userId: string;
  selfMute: boolean;
  producers: { id: string; kind: string; paused: boolean; type: string }[];
  consumerCount: number;
}

interface DiagChannel {
  channelId: string;
  userCount: number;
  users: DiagUser[];
}

const h = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function login(email: string): Promise<{ token: string; userId: string }> {
  const { data } = await axios.post(`${API}/auth/login`, { email, password: PASSWORD });
  const r = data.data || data;
  return { token: r.accessToken, userId: r.user.id };
}

async function raiseRateLimits(token: string): Promise<void> {
  for (const name of ['login', 'register', 'admin', 'general']) {
    try {
      await axios.put(`${API}/admin/rate-limits/${name}`, { points: 99999, duration: 60, blockDuration: 0 }, h(token));
    } catch { /* */ }
  }
}

async function resetRateLimits(token: string): Promise<void> {
  for (const name of ['login', 'register', 'admin', 'general']) {
    try {
      await axios.post(`${API}/admin/rate-limits/${name}/reset`, {}, h(token));
    } catch { /* */ }
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

function createFakeAudioTrack(): { track: MediaStreamTrack; interval: ReturnType<typeof setInterval> } {
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();
  const sampleRate = 48000;
  const samples = new Int16Array(sampleRate / 100);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.floor(Math.sin(i * 0.01) * 10);
  }
  const interval = setInterval(() => {
    try {
      source.onData({ samples, sampleRate, bitsPerSample: 16, channelCount: 1, numberOfFrames: samples.length });
    } catch { clearInterval(interval); }
  }, 40);
  return { track, interval };
}

function setupMedia(user: { socket: Socket; token: string; username: string }, channelId: string): Promise<TestUser> {
  return new Promise((resolve, reject) => {
    const socket = user.socket;
    const timer = setTimeout(() => reject(new Error(`Media setup timeout for ${user.username}`)), 30000);

    socket.once('voice:transport_created', async (data: {
      routerRtpCapabilities: unknown;
      sendTransport: TransportOptions;
      recvTransport: TransportOptions;
    }) => {
      clearTimeout(timer);
      try {
        const device = new Device({ handlerFactory: Chrome111.createFactory() });
        await device.load({ routerRtpCapabilities: data.routerRtpCapabilities as RtpCapabilities });

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

        socket.emit('voice:rtp_capabilities', { rtpCapabilities: device.rtpCapabilities });

        socket.on('voice:new_consumer', async (consumerData: {
          id: string; producerId: string; kind: string; rtpParameters: unknown; producerUserId: string;
        }) => {
          try {
            const consumer = await recvTransport.consume({
              id: consumerData.id,
              producerId: consumerData.producerId,
              kind: consumerData.kind as 'audio' | 'video',
              rtpParameters: consumerData.rtpParameters as RtpParameters,
            });
            socket.emit('voice:consumer:resume', { consumerId: consumer.id });
          } catch { /* */ }
        });

        let producer: Producer | null = null;
        let audioInterval: ReturnType<typeof setInterval> | null = null;
        if (device.canProduce('audio')) {
          const { track, interval } = createFakeAudioTrack();
          audioInterval = interval;
          producer = await sendTransport.produce({
            track,
            codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
            appData: { type: 'audio' },
          });
        }

        resolve({ username: user.username, token: user.token, socket, device, sendTransport, recvTransport, producer, audioInterval });
      } catch (err) {
        reject(err);
      }
    });

    socket.once('voice:error', (err: { message: string }) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });

    socket.emit('voice:join', channelId, { selfMute: false, selfDeaf: false });
  });
}

async function getDiag(token: string): Promise<DiagChannel[]> {
  const { data } = await axios.get(`${API}/admin/stats/voice-diag`, h(token));
  return data.data;
}

function findUserByProducer(diag: DiagChannel[], channelId: string, producer: Producer): DiagUser | undefined {
  const channel = diag.find((c) => c.channelId === channelId);
  if (!channel) return undefined;
  return channel.users.find((u) => u.producers.some((p) => p.id === producer.id));
}

function getProducerState(diag: DiagChannel[], channelId: string, producer: Producer): boolean | undefined {
  const user = findUserByProducer(diag, channelId, producer);
  return user?.producers.find((p) => p.id === producer.id)?.paused;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const totalUsers = USERS_PER_CHANNEL * NUM_SERVERS;
  console.log(`\n=== Voice Optimization Stress Test: ${NUM_SERVERS} servers x ${USERS_PER_CHANNEL} users = ${totalUsers} total ===\n`);

  // Step 1: Login & setup
  console.log('[1/6] Logging in as seed user...');
  const seed = await login(SEED_EMAIL);
  await raiseRateLimits(seed.token);

  // Step 2: Find servers with voice channels
  console.log(`\n[2/6] Finding ${NUM_SERVERS} servers with voice channels...`);
  const { data: serverData } = await axios.get(`${API}/servers`, h(seed.token));
  const servers = serverData.data;
  if (servers.length < NUM_SERVERS) throw new Error(`Need ${NUM_SERVERS} servers, seed is in ${servers.length}.`);

  const targets: Target[] = [];
  for (let s = 0; s < NUM_SERVERS; s++) {
    const srv = servers[s];
    const { data: chData } = await axios.get(`${API}/servers/${srv.id}/channels`, h(seed.token));
    const voiceCh = (chData.data as { id: string; type: string; name: string }[]).find((c) => c.type === 'voice');
    if (!voiceCh) throw new Error(`No voice channel in "${srv.name}".`);
    targets.push({ serverId: srv.id, serverName: srv.name, channelId: voiceCh.id, channelName: voiceCh.name, users: [] });
    console.log(`  [${s + 1}] ${srv.name} → #${voiceCh.name}`);
  }

  // Step 3: Create and register test users
  console.log(`\n[3/6] Creating ${totalUsers} users...`);
  let created = 0;
  for (let s = 0; s < targets.length; s++) {
    const target = targets[s];
    for (let i = 0; i < USERS_PER_CHANNEL; i += 10) {
      const batch = [];
      for (let j = i; j < Math.min(i + 10, USERS_PER_CHANNEL); j++) {
        const username = `vopt_s${s}_u${j}`;
        const email = `${username}@test.local`;
        batch.push(
          (async () => {
            try { await axios.post(`${API}/auth/register`, { username, email, password: PASSWORD }); } catch { /* exists */ }
            const { token } = await login(email);
            try {
              const { data: inv } = await axios.post(`${API}/invites/servers/${target.serverId}`, {}, h(seed.token));
              const code = inv.data?.code || inv.code;
              await axios.post(`${API}/invites/${code}/join`, {}, h(token));
            } catch { /* already member */ }
            return { username, token };
          })()
        );
      }
      const results = await Promise.all(batch);
      created += results.length;
      // Store temporarily — we'll connect sockets next
      for (const r of results) {
        (target as any)._pending = (target as any)._pending || [];
        (target as any)._pending.push(r);
      }
      process.stdout.write(`  ${created}/${totalUsers}\r`);
    }
  }
  console.log(`  ${created} users registered                `);

  // Step 4: Connect sockets and join voice (batched to limit wrtc pressure)
  console.log(`\n[4/6] Joining voice channels with full media (batch size ${MEDIA_BATCH})...`);
  let connected = 0;
  let failedConnections = 0;

  for (const target of targets) {
    console.log(`  ${target.serverName} → #${target.channelName}...`);
    const pending: { username: string; token: string }[] = (target as any)._pending || [];
    delete (target as any)._pending;

    for (let i = 0; i < pending.length; i += MEDIA_BATCH) {
      const batch = pending.slice(i, i + MEDIA_BATCH);
      const results = await Promise.allSettled(
        batch.map(async (u) => {
          const socket = await connectSocket(u.token);
          return setupMedia({ socket, token: u.token, username: u.username }, target.channelId);
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          target.users.push(r.value);
          connected++;
        } else {
          failedConnections++;
          console.error(`    FAIL: ${r.reason?.message}`);
        }
      }
      process.stdout.write(`    ${connected} connected, ${failedConnections} failed\r`);
    }
    console.log(`    ${target.users.length}/${pending.length} connected          `);
  }

  console.log(`\n[Setup complete] ${connected}/${totalUsers} users connected across ${NUM_SERVERS} servers.\n`);
  await sleep(2000); // Let mediasoup settle with 100 users

  // ─── TEST 1: Baseline — all producers active ─────────────────────────
  console.log('[Test 1] Baseline — all producers active across all servers');
  let diag = await getDiag(seed.token);
  for (const target of targets) {
    let ok = 0;
    for (const user of target.users) {
      if (!user.producer) continue;
      const paused = getProducerState(diag, target.channelId, user.producer);
      if (paused === false) ok++;
    }
    assert(ok === target.users.length, `${target.serverName}: ${ok}/${target.users.length} producers active`);
  }

  // ─── TEST 2: Silence detection — half per channel stop speaking ──────
  console.log('\n[Test 2] Silence detection — half per channel stop speaking');
  for (const target of targets) {
    const half = Math.floor(target.users.length / 2);
    for (let i = 0; i < half; i++) {
      target.users[i].socket.emit('voice:speaking', false);
    }
  }
  await sleep(800);

  diag = await getDiag(seed.token);
  for (const target of targets) {
    const half = Math.floor(target.users.length / 2);
    let pausedOk = 0;
    let activeOk = 0;
    for (let i = 0; i < target.users.length; i++) {
      const user = target.users[i];
      if (!user.producer) continue;
      const paused = getProducerState(diag, target.channelId, user.producer);
      if (i < half && paused === true) pausedOk++;
      if (i >= half && paused === false) activeOk++;
    }
    assert(pausedOk === half, `${target.serverName}: ${pausedOk}/${half} correctly paused`);
    assert(activeOk === target.users.length - half, `${target.serverName}: ${activeOk}/${target.users.length - half} still active`);
  }

  // Summary
  const totalPaused = targets.reduce((sum, t) => sum + Math.floor(t.users.length / 2), 0);
  const totalActive = connected - totalPaused;
  console.log(`  Summary: ${totalPaused} paused / ${totalActive} active across all servers`);

  // ─── TEST 3: Resume all ──────────────────────────────────────────────
  console.log('\n[Test 3] Resume speaking — all users resume');
  for (const target of targets) {
    for (const user of target.users) {
      user.socket.emit('voice:speaking', true);
    }
  }
  await sleep(800);

  diag = await getDiag(seed.token);
  for (const target of targets) {
    let ok = 0;
    for (const user of target.users) {
      if (!user.producer) continue;
      if (getProducerState(diag, target.channelId, user.producer) === false) ok++;
    }
    assert(ok === target.users.length, `${target.serverName}: ${ok}/${target.users.length} resumed`);
  }

  // ─── TEST 4: Mute override (one user per server) ─────────────────────
  console.log('\n[Test 4] Mute override — one user per server mutes, speaking=true should NOT resume');
  for (const target of targets) {
    target.users[0].socket.emit('voice:mute', true);
  }
  await sleep(500);

  diag = await getDiag(seed.token);
  for (const target of targets) {
    const p = target.users[0].producer;
    if (!p) continue;
    assert(getProducerState(diag, target.channelId, p) === true, `${target.serverName}/${target.users[0].username}: paused after mute`);
  }

  // speaking=true should not override mute
  for (const target of targets) {
    target.users[0].socket.emit('voice:speaking', true);
  }
  await sleep(500);

  diag = await getDiag(seed.token);
  for (const target of targets) {
    const p = target.users[0].producer;
    if (!p) continue;
    assert(getProducerState(diag, target.channelId, p) === true, `${target.serverName}/${target.users[0].username}: STILL paused (mute overrides)`);
  }

  // Unmute
  for (const target of targets) {
    target.users[0].socket.emit('voice:mute', false);
    target.users[0].socket.emit('voice:speaking', true);
  }
  await sleep(500);

  diag = await getDiag(seed.token);
  for (const target of targets) {
    const p = target.users[0].producer;
    if (!p) continue;
    assert(getProducerState(diag, target.channelId, p) === false, `${target.serverName}/${target.users[0].username}: resumed after unmute`);
  }

  // ─── TEST 5: Bulk mute all 100 users ─────────────────────────────────
  console.log(`\n[Test 5] Bulk mute — all ${connected} users mute simultaneously`);
  for (const target of targets) {
    for (const user of target.users) {
      user.socket.emit('voice:mute', true);
    }
  }
  await sleep(1000);

  diag = await getDiag(seed.token);
  let totalMutePaused = 0;
  for (const target of targets) {
    let ok = 0;
    for (const user of target.users) {
      if (!user.producer) continue;
      if (getProducerState(diag, target.channelId, user.producer) === true) ok++;
    }
    totalMutePaused += ok;
    assert(ok === target.users.length, `${target.serverName}: ${ok}/${target.users.length} paused (bulk mute)`);
  }
  console.log(`  Total: ${totalMutePaused}/${connected} producers paused`);

  // Unmute all
  console.log('  Unmuting all...');
  for (const target of targets) {
    for (const user of target.users) {
      user.socket.emit('voice:mute', false);
    }
  }
  await sleep(1000);

  diag = await getDiag(seed.token);
  let totalUnmuted = 0;
  for (const target of targets) {
    let ok = 0;
    for (const user of target.users) {
      if (!user.producer) continue;
      if (getProducerState(diag, target.channelId, user.producer) === false) ok++;
    }
    totalUnmuted += ok;
    assert(ok === target.users.length, `${target.serverName}: ${ok}/${target.users.length} resumed (bulk unmute)`);
  }
  console.log(`  Total: ${totalUnmuted}/${connected} producers resumed`);

  // ─── TEST 6: Rapid toggle stress ─────────────────────────────────────
  console.log(`\n[Test 6] Rapid toggle — 10 cycles across all ${connected} users`);
  for (let cycle = 0; cycle < 10; cycle++) {
    const speaking = cycle % 2 === 0;
    for (const target of targets) {
      for (const user of target.users) {
        user.socket.emit('voice:speaking', speaking);
      }
    }
    await sleep(50);
  }
  // Last cycle (index 9): 9%2=1 → speaking=false → all paused
  await sleep(800);

  diag = await getDiag(seed.token);
  let rapidOk = 0;
  for (const target of targets) {
    for (const user of target.users) {
      if (!user.producer) continue;
      if (getProducerState(diag, target.channelId, user.producer) === true) rapidOk++;
    }
  }
  assert(rapidOk === connected, `All ${connected} producers paused after rapid toggle (got ${rapidOk})`);

  // Resume all
  for (const target of targets) {
    for (const user of target.users) {
      user.socket.emit('voice:speaking', true);
    }
  }
  await sleep(500);

  // ─── TEST 7: Consumer mesh per channel ────────────────────────────────
  console.log('\n[Test 7] Consumer mesh — verify per-channel consumer counts');
  diag = await getDiag(seed.token);
  for (const target of targets) {
    const ch = diag.find((c) => c.channelId === target.channelId);
    if (!ch) { assert(false, `${target.serverName}: channel not found in diag`); continue; }
    const producerCount = ch.users.reduce((sum, u) => sum + u.producers.length, 0);
    const expectedPerUser = producerCount - 1; // each user consumes all others
    let meshOk = 0;
    for (const u of ch.users) {
      if (u.consumerCount === expectedPerUser) meshOk++;
    }
    assert(meshOk === ch.users.length, `${target.serverName}: ${meshOk}/${ch.users.length} users have ${expectedPerUser} consumers each`);
  }

  // ─── TEST 8: SFU aggregate stats ─────────────────────────────────────
  console.log('\n[Test 8] SFU stats — global aggregate');
  const { data: sfuData } = await axios.get(`${API}/admin/stats/sfu`, h(seed.token));
  const sfu = sfuData.data;
  const expectedProducers = connected;
  const expectedConsumers = targets.reduce((sum, t) => sum + t.users.length * (t.users.length - 1), 0);
  const expectedTransports = connected * 2;

  assert(sfu.totalProducers >= expectedProducers, `SFU totalProducers >= ${expectedProducers} (got ${sfu.totalProducers})`);
  assert(sfu.totalConsumers >= expectedConsumers, `SFU totalConsumers >= ${expectedConsumers} (got ${sfu.totalConsumers})`);
  assert(sfu.totalTransports >= expectedTransports, `SFU totalTransports >= ${expectedTransports} (got ${sfu.totalTransports})`);
  assert(sfu.workers.length > 0, `SFU has ${sfu.workers.length} worker(s)`);

  console.log(`  Producers: ${sfu.totalProducers} | Consumers: ${sfu.totalConsumers} | Transports: ${sfu.totalTransports}`);

  // ─── TEST 9: Cross-server isolation ──────────────────────────────────
  console.log('\n[Test 9] Cross-server isolation — silence in one server does not affect others');
  // Silence all users in server 0
  for (const user of targets[0].users) {
    user.socket.emit('voice:speaking', false);
  }
  await sleep(800);

  diag = await getDiag(seed.token);
  // Server 0: all paused
  let s0paused = 0;
  for (const user of targets[0].users) {
    if (!user.producer) continue;
    if (getProducerState(diag, targets[0].channelId, user.producer) === true) s0paused++;
  }
  assert(s0paused === targets[0].users.length, `${targets[0].serverName}: all ${s0paused}/${targets[0].users.length} paused`);

  // Other servers: all still active
  for (let s = 1; s < targets.length; s++) {
    let active = 0;
    for (const user of targets[s].users) {
      if (!user.producer) continue;
      if (getProducerState(diag, targets[s].channelId, user.producer) === false) active++;
    }
    assert(active === targets[s].users.length, `${targets[s].serverName}: all ${active}/${targets[s].users.length} still active (isolated)`);
  }

  // Resume server 0
  for (const user of targets[0].users) {
    user.socket.emit('voice:speaking', true);
  }
  await sleep(300);

  // ─── Results ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log(`Scale: ${connected} users, ${sfu.totalProducers} producers, ${sfu.totalConsumers} consumers, ${sfu.totalTransports} transports`);
  console.log(`${'='.repeat(60)}\n`);

  // Cleanup
  console.log('[Cleanup] Disconnecting users...');
  for (const target of targets) {
    for (const u of target.users) {
      if (u.audioInterval) clearInterval(u.audioInterval);
      if (u.sendTransport) try { u.sendTransport.close(); } catch { /* */ }
      if (u.recvTransport) try { u.recvTransport.close(); } catch { /* */ }
      u.socket.emit('voice:leave');
      u.socket.disconnect();
    }
  }

  await resetRateLimits(seed.token);
  console.log('[Cleanup] Done.\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nTest failed:', err.response?.data || err.message);
  try {
    const seed = await login(SEED_EMAIL);
    await resetRateLimits(seed.token);
  } catch { /* */ }
  process.exit(1);
});
