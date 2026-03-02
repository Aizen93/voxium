/**
 * Optimizes the Opus codec parameters in an SDP offer/answer for voice chat.
 *
 * - usedtx=1        — 20x bandwidth reduction during silence (Discontinuous Transmission)
 * - useinbandfec=1   — embeds redundant audio data for packet loss recovery
 * - maxaveragebitrate — 32kbps is excellent quality for mono voice
 * - stereo=0         — mono voice halves bandwidth vs stereo
 */
export function optimizeOpusSDP(sdp: string): string {
  // Find the Opus codec payload type (e.g., "a=rtpmap:111 opus/48000/2")
  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  if (!opusMatch) return sdp;

  const pt = opusMatch[1];
  const opusParams: Record<string, string> = {
    usedtx: '1',
    useinbandfec: '1',
    maxaveragebitrate: '32000',
    stereo: '0',
  };

  const fmtpRe = new RegExp(`(a=fmtp:${pt} )(.+)`);
  const fmtpMatch = sdp.match(fmtpRe);

  if (fmtpMatch) {
    // Merge into existing fmtp line
    const params = new Map<string, string>();
    fmtpMatch[2].split(';').forEach((p) => {
      const eq = p.indexOf('=');
      if (eq !== -1) {
        params.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
      }
    });
    for (const [k, v] of Object.entries(opusParams)) {
      params.set(k, v);
    }
    const merged = Array.from(params.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    return sdp.replace(fmtpRe, `a=fmtp:${pt} ${merged}`);
  }

  // No fmtp line yet — insert one after the rtpmap line
  const newFmtp = Object.entries(opusParams)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt} opus/48000/2)`),
    `$1\r\na=fmtp:${pt} ${newFmtp}`,
  );
}
