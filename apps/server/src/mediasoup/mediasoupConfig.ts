import type { RouterRtpCodecCapability, WorkerLogLevel, TransportListenInfo, WebRtcServer } from 'mediasoup/node/lib/types';

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

// Raised recv-transport cap while a screen-share video consumer is active.
// The 1.5 Mbps audio-era cap starves 1080p desktop content into permanent blur;
// screen video needs headroom on top of the channel's audio streams. Restored
// to RECV_TRANSPORT_MAX_BITRATE when the last video consumer closes.
export const SCREEN_SHARE_RECV_MAX_BITRATE = 4_000_000;

// Lazy getters — env vars not available at module scope (ES import hoisting)

function listenAddress() {
  return {
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
  };
}

const TRANSPORT_BASE_OPTIONS = {
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 600_000,
} as const;

/**
 * Whether every worker gets ONE WebRtcServer whose single UDP + TCP port pair
 * carries all of its transports (the default), or each transport binds its own
 * ports out of the worker range (the pre-2026-08 behaviour, kept as an escape
 * hatch: `MEDIASOUP_WEBRTC_SERVER=false`).
 *
 * The per-transport mode needs the WHOLE `MEDIASOUP_MIN_PORT..MAX_PORT` range
 * open on the firewall and caps concurrent voice users at (range ÷ 2) per node
 * — port exhaustion then fails the next join with a transport error. The
 * WebRtcServer mode needs `numWorkers` ports open and has no such ceiling.
 */
export function useWebRtcServer(): boolean {
  return process.env.MEDIASOUP_WEBRTC_SERVER !== 'false';
}

/**
 * The port a worker's WebRtcServer binds — for BOTH protocols, so the firewall
 * story stays "MIN_PORT .. MIN_PORT + workers − 1, udp and tcp". Deterministic
 * on the worker's slot index so a replacement worker after a crash re-binds
 * the exact ports the dead one held; nothing else in the cluster (or the
 * clients' firewalls) has to learn a new number.
 */
export function webRtcServerPort(workerIndex: number): number {
  const { rtcMinPort, rtcMaxPort } = getWorkerSettings();
  // parseInt of an unexpanded `${MIN_PORT}` or a stray quote is NaN, and every
  // comparison against NaN is false: the slot check below would PASS, mediasoup
  // would skip the NaN range and bind RANDOM ports out of its 10000-59999
  // default, behind a firewall that opens eight. Refuse the whole range.
  if (
    !Number.isInteger(rtcMinPort) || !Number.isInteger(rtcMaxPort) ||
    rtcMinPort < 1 || rtcMaxPort > 65535 || rtcMinPort > rtcMaxPort
  ) {
    throw new Error(
      `[mediasoup] MEDIASOUP_MIN_PORT/MAX_PORT must be integers with 1 <= MIN <= MAX <= 65535 ` +
      `(got ${process.env.MEDIASOUP_MIN_PORT ?? 'unset'} / ${process.env.MEDIASOUP_MAX_PORT ?? 'unset'})`,
    );
  }
  const port = rtcMinPort + workerIndex;
  if (!Number.isInteger(workerIndex) || workerIndex < 0 || port > rtcMaxPort) {
    throw new Error(
      `[mediasoup] MEDIASOUP_MIN_PORT..MAX_PORT (${rtcMinPort}-${rtcMaxPort}) has no port for worker #${workerIndex}: ` +
      'the range must hold at least one port per worker (MEDIASOUP_NUM_WORKERS, default = CPU cores, max 8).',
    );
  }
  return port;
}

/** Listen infos for a worker's WebRtcServer: one UDP + one TCP, same port number. */
export function getWebRtcServerListenInfos(workerIndex: number): TransportListenInfo[] {
  const { listenIp, announcedAddress } = listenAddress();
  const port = webRtcServerPort(workerIndex);
  return [
    { protocol: 'udp', ip: listenIp, announcedAddress, port },
    { protocol: 'tcp', ip: listenIp, announcedAddress, port },
  ];
}

/** Transport options when the router's worker owns a WebRtcServer. */
export function getWebRtcServerTransportOptions(webRtcServer: WebRtcServer) {
  return { webRtcServer, ...TRANSPORT_BASE_OPTIONS };
}

/**
 * Transport options for the per-transport listen mode (`MEDIASOUP_WEBRTC_SERVER=false`):
 * every transport binds its own UDP + TCP port out of the worker range.
 */
export function getWebRtcTransportOptions() {
  const { listenIp, announcedAddress } = listenAddress();
  return {
    listenInfos: [
      { protocol: 'udp', ip: listenIp, announcedAddress },
      { protocol: 'tcp', ip: listenIp, announcedAddress },
    ] as TransportListenInfo[],
    ...TRANSPORT_BASE_OPTIONS,
  };
}

export function getWorkerSettings() {
  return {
    rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
    rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '59999', 10),
    logLevel: 'warn' as WorkerLogLevel,
  };
}
