import type { RouterRtpCodecCapability, WorkerLogLevel, TransportListenInfo } from 'mediasoup/node/lib/types';

// Audio + video codecs for the mediasoup Router
export const mediaCodecs: RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      usedtx: 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];

// Max outgoing bitrate for recv transports (server → client).
// Caps each consumer connection to prevent bandwidth abuse.
export const RECV_TRANSPORT_MAX_BITRATE = 1_500_000;

// Lazy getters — env vars not available at module scope (ES import hoisting)
export function getWebRtcTransportOptions() {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';
  return {
    listenInfos: [
      { protocol: 'udp', ip: listenIp, announcedAddress },
      { protocol: 'tcp', ip: listenIp, announcedAddress },
    ] as TransportListenInfo[],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 600_000,
  };
}

export function getWorkerSettings() {
  return {
    rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
    rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '10500', 10),
    logLevel: 'warn' as WorkerLogLevel,
  };
}
