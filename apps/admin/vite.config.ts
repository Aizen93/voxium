import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 8082,
    strictPort: true,
    // Loopback only by default: a dev server reachable from the LAN serves source
    // files and the dev-only middleware to anyone on the network. Set
    // VOXIUM_DEV_LAN=1 to open it for testing from another machine.
    host: process.env.VOXIUM_DEV_LAN === '1' ? true : 'localhost',
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});
