import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    // .tsx so component tests can use JSX like the components they render
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Node 25+ defines its own localStorage/sessionStorage globals, and vitest 4's
    // jsdom environment keeps them instead of jsdom's (vitest 5 fixes it): with
    // Node's Web Storage off, the tests get jsdom's. Remove with vitest 5.
    execArgv: ['--no-experimental-webstorage'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@voxium/shared': path.resolve(import.meta.dirname, '../../packages/shared/dist'),
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
