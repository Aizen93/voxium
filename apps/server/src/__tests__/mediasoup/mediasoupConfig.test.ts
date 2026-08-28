import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('mediasoup/mediasoupConfig — lazy getters', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    // Save and clear mediasoup env vars
    const keys = [
      'MEDIASOUP_LISTEN_IP',
      'MEDIASOUP_ANNOUNCED_IP',
      'MEDIASOUP_MIN_PORT',
      'MEDIASOUP_MAX_PORT',
      'MEDIASOUP_WEBRTC_SERVER',
    ];
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('importing the module does NOT throw even without env vars', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    expect(mod).toBeDefined();
  });

  it('mediaCodecs is a constant array available at import time', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    expect(Array.isArray(mod.mediaCodecs)).toBe(true);
    expect(mod.mediaCodecs.length).toBeGreaterThan(0);
    // Check audio/opus codec is present
    const opusCodec = mod.mediaCodecs.find((c) => c.mimeType === 'audio/opus');
    expect(opusCodec).toBeDefined();
    expect(opusCodec!.clockRate).toBe(48000);
  });

  it('RECV_TRANSPORT_MAX_BITRATE is a numeric constant', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    expect(typeof mod.RECV_TRANSPORT_MAX_BITRATE).toBe('number');
    expect(mod.RECV_TRANSPORT_MAX_BITRATE).toBe(1_500_000);
  });

  it('getWebRtcTransportOptions() reads env vars at call time, not import time', async () => {
    // Import with no env vars set
    const mod = await import('../../mediasoup/mediasoupConfig');

    // Now set env vars AFTER import
    process.env.MEDIASOUP_LISTEN_IP = '192.168.1.100';
    process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.42';

    const opts = mod.getWebRtcTransportOptions();
    expect(opts.listenInfos[0].ip).toBe('192.168.1.100');
    expect(opts.listenInfos[0].announcedAddress).toBe('203.0.113.42');
  });

  it('getWebRtcTransportOptions() uses defaults when env vars are not set', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');

    const opts = mod.getWebRtcTransportOptions();
    expect(opts.listenInfos[0].ip).toBe('0.0.0.0');
    expect(opts.listenInfos[0].announcedAddress).toBe('127.0.0.1');
    expect(opts.enableUdp).toBe(true);
    expect(opts.enableTcp).toBe(true);
    expect(opts.preferUdp).toBe(true);
    expect(opts.initialAvailableOutgoingBitrate).toBe(600_000);
  });

  it('getWebRtcTransportOptions() includes both UDP and TCP listen infos', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');

    const opts = mod.getWebRtcTransportOptions();
    expect(opts.listenInfos).toHaveLength(2);
    expect(opts.listenInfos[0].protocol).toBe('udp');
    expect(opts.listenInfos[1].protocol).toBe('tcp');
  });

  it('getWorkerSettings() reads env vars at call time, not import time', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');

    // Set env vars AFTER import
    process.env.MEDIASOUP_MIN_PORT = '20000';
    process.env.MEDIASOUP_MAX_PORT = '30000';

    const settings = mod.getWorkerSettings();
    expect(settings.rtcMinPort).toBe(20000);
    expect(settings.rtcMaxPort).toBe(30000);
  });

  it('getWorkerSettings() uses defaults when env vars are not set', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');

    const settings = mod.getWorkerSettings();
    expect(settings.rtcMinPort).toBe(10000);
    expect(settings.rtcMaxPort).toBe(59999);
    expect(settings.logLevel).toBe('warn');
  });

  it('getWorkerSettings() parses port strings as integers', async () => {
    process.env.MEDIASOUP_MIN_PORT = '15000';
    process.env.MEDIASOUP_MAX_PORT = '25000';

    const mod = await import('../../mediasoup/mediasoupConfig');
    const settings = mod.getWorkerSettings();

    expect(settings.rtcMinPort).toBe(15000);
    expect(typeof settings.rtcMinPort).toBe('number');
    expect(settings.rtcMaxPort).toBe(25000);
    expect(typeof settings.rtcMaxPort).toBe('number');
  });

  it('getWebRtcTransportOptions() reflects env changes between calls', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');

    // First call — defaults
    const opts1 = mod.getWebRtcTransportOptions();
    expect(opts1.listenInfos[0].ip).toBe('0.0.0.0');

    // Change env var
    process.env.MEDIASOUP_LISTEN_IP = '10.0.0.1';

    // Second call — picks up the change (no caching)
    const opts2 = mod.getWebRtcTransportOptions();
    expect(opts2.listenInfos[0].ip).toBe('10.0.0.1');
  });
});

describe('mediasoup/mediasoupConfig — WebRtcServer helpers', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ['MEDIASOUP_LISTEN_IP', 'MEDIASOUP_ANNOUNCED_IP', 'MEDIASOUP_MIN_PORT', 'MEDIASOUP_MAX_PORT', 'MEDIASOUP_WEBRTC_SERVER'];
  beforeEach(() => {
    vi.resetModules();
    for (const k of keys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of keys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  });

  it('useWebRtcServer() is ON unless MEDIASOUP_WEBRTC_SERVER is exactly "false"', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    expect(mod.useWebRtcServer()).toBe(true);
    process.env.MEDIASOUP_WEBRTC_SERVER = 'false';
    expect(mod.useWebRtcServer()).toBe(false);
    for (const v of ['0', 'no', 'FALSE', 'true', '']) {
      process.env.MEDIASOUP_WEBRTC_SERVER = v;
      expect(mod.useWebRtcServer(), v).toBe(true);
    }
  });

  it('webRtcServerPort() is MIN_PORT + slot, read at call time', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    expect(mod.webRtcServerPort(0)).toBe(10000);
    process.env.MEDIASOUP_MIN_PORT = '40000';
    process.env.MEDIASOUP_MAX_PORT = '40007';
    expect(mod.webRtcServerPort(0)).toBe(40000);
    expect(mod.webRtcServerPort(7)).toBe(40007);
  });

  it('webRtcServerPort() refuses a slot the range cannot hold, and nonsense slots', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    process.env.MEDIASOUP_MIN_PORT = '40000';
    process.env.MEDIASOUP_MAX_PORT = '40001';
    expect(() => mod.webRtcServerPort(2)).toThrow(/40000-40001.*no port for worker #2/);
    expect(() => mod.webRtcServerPort(-1)).toThrow();
    expect(() => mod.webRtcServerPort(1.5)).toThrow();
  });

  it('getWebRtcServerListenInfos() binds udp AND tcp on the SAME port with the announced address', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    process.env.MEDIASOUP_LISTEN_IP = '10.0.1.11';
    process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.11';
    process.env.MEDIASOUP_MIN_PORT = '10000';
    expect(mod.getWebRtcServerListenInfos(1)).toEqual([
      { protocol: 'udp', ip: '10.0.1.11', announcedAddress: '203.0.113.11', port: 10001 },
      { protocol: 'tcp', ip: '10.0.1.11', announcedAddress: '203.0.113.11', port: 10001 },
    ]);
  });

  it('getWebRtcServerTransportOptions() carries the server and the shared flags, never listenInfos', async () => {
    const mod = await import('../../mediasoup/mediasoupConfig');
    const server = { id: 'srv' } as never;
    const opts = mod.getWebRtcServerTransportOptions(server);
    expect(opts.webRtcServer).toBe(server);
    expect(opts).not.toHaveProperty('listenInfos');
    expect(opts).toMatchObject({ enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 600_000 });
    // Same flags on both paths — a drift here changes ICE behaviour by mode
    const individual = mod.getWebRtcTransportOptions();
    for (const k of ['enableUdp', 'enableTcp', 'preferUdp', 'initialAvailableOutgoingBitrate'] as const) {
      expect(opts[k]).toBe(individual[k]);
    }
  });
});
