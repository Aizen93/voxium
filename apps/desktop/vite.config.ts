import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 8080,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  // Prevent clearing the terminal so Tauri logs are visible
  clearScreen: false,
});
