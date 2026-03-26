import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
    pool: 'forks', // process isolation — prevents module-scope state leaking between tests
  },
  resolve: {
    alias: {
      '@voxium/shared': path.resolve(__dirname, '../../packages/shared/dist'),
    },
  },
});
