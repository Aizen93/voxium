import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    // .tsx so component tests can use JSX like the components they render
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@voxium/shared': path.resolve(__dirname, '../../packages/shared/dist'),
      '@': path.resolve(__dirname, './src'),
    },
  },
});
