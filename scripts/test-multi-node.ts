/**
 * Multi-Node Horizontal Scaling Test
 *
 * Spawns 2 server instances on different ports and verifies cross-node behavior:
 * 1. Socket.IO Redis adapter (events cross nodes)
 * 2. Presence (user online on node-1 visible from node-2)
 * 3. DM voice state in Redis (cross-node call setup)
 * 4. Server voice metadata in Redis (connecting client sees voice state from other node)
 * 5. Config propagation (feature flag change propagates across nodes)
 *
 * Usage:
 *   npx tsx scripts/test-multi-node.ts
 *
 * Requires: PostgreSQL + Redis running, apps/server/.env configured.
 */

import { spawn, type ChildProcess } from 'child_process';
import axios from 'axios';
import { io as ioClient, type Socket } from 'socket.io-client';
import path from 'path';

const NODE1_PORT = 3001;
const NODE2_PORT = 3002;
const API1 = `http://localhost:${NODE1_PORT}/api/v1`;
const API2 = `http://localhost:${NODE2_PORT}/api/v1`;
const WS1 = `http://localhost:${NODE1_PORT}`;
const WS2 = `http://localhost:${NODE2_PORT}`;
const PASSWORD = 'password123';

let node1: ChildProcess | null = null;
let node2: ChildProcess | null = null;
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

async function waitForServer(port: number, maxWait = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
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
  const child = spawn('npx', ['tsx', serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ID: nodeId,
      MEDIASOUP_MIN_PORT: String(mediasoupMinPort),
      MEDIASOUP_MAX_PORT: String(mediasoupMaxPort),
      MEDIASOUP_NUM_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
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
    const res = await axios.post(`${api}/auth/register`, {
      username,
      email: `${username}@multinode.test`,
      password: PASSWORD,
    });
    return res.data.data.accessToken;
  } catch (err: any) {
    if (err.response?.status === 409) {
      // Already exists, login
      const res = await axios.post(`${api}/auth/login`, {
        email: `${username}@multinode.test`,
        password: PASSWORD,
      });
      return res.data.data.accessToken;
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

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function cleanup() {
  if (node1) { node1.kill(); node1 = null; }
  if (node2) { node2.kill(); node2 = null; }
  await sleep(1000);
}

process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Multi-Node Horizontal Scaling Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 1: Start two server instances
  console.log('Starting node-1 on port 3001...');
  node1 = startServer(NODE1_PORT, 'node-1', 10000, 10100);

  console.log('Starting node-2 on port 3002...');
  node2 = startServer(NODE2_PORT, 'node-2', 10101, 10200);

  console.log('Waiting for servers to be ready...');
  const [ready1, ready2] = await Promise.all([
    waitForServer(NODE1_PORT),
    waitForServer(NODE2_PORT),
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
    await cleanup();
    process.exit(1);
  }

  // Step 4: Ensure both users are in a shared server (create one if needed)
  let serverId: string | null = null;
  try {
    const serverRes = await axios.post(`${API1}/servers`, { name: 'MultiNode Test Server' }, {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    serverId = serverRes.data.data.id;

    // Create an invite and have user2 join
    const inviteRes = await axios.post(`${API1}/invites/servers/${serverId}`, {}, {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    const code = inviteRes.data.data.code;
    await axios.post(`${API2}/invites/${code}/join`, {}, {
      headers: { Authorization: `Bearer ${user2Token}` },
    });
    console.log(`Shared server created: ${serverId}\n`);
  } catch (err: any) {
    console.warn('Server setup warning:', err.response?.data?.error || err.message);
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
