import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 8080,
    strictPort: true,
    // Loopback only by default: a dev server reachable from the LAN serves source
    // files and the dev-only middleware to anyone on the network. Set
    // VOXIUM_DEV_LAN=1 to open it for testing from another machine. IPv4
    // loopback, not 'localhost': Node may resolve that to ::1 alone, and Firefox
    // then fails the voice transports' DTLS against the IPv4 address mediasoup
    // announces (http://localhost:8080 still reaches 127.0.0.1).
    host: process.env.VOXIUM_DEV_LAN === '1' ? true : '127.0.0.1',
    // Tauri builds into src-tauri/target while this server runs; watching it locks
    // the files cargo writes (EBUSY on Windows) and reloads nothing useful.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    sourcemap: false,
  },
  // Prevent clearing the terminal so Tauri logs are visible
  clearScreen: false,
});
