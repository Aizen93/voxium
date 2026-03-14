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
    expect(settings.rtcMaxPort).toBe(10500);
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
