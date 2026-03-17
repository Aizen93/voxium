import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@voxium/shared': path.resolve(__dirname, '../../packages/shared/dist'),
      '@': path.resolve(__dirname, './src'),
    },
  },
});
