/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional `stun:host[:port]` override; defaults to the VITE_WS_URL host on 3478 (utils/stunUrl.ts). */
  readonly VITE_STUN_URL?: string;
  /** The public web client's origin, for links the desktop app hands out (utils/webClientUrl.ts). */
  readonly VITE_CLIENT_URL?: string;
}

declare module "@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url" {
  const url: string;
  export default url;
}
