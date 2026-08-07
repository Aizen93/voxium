import { test as base } from '@playwright/test';
import { clearRateLimits } from './api';

// Clear rate limits before each test to prevent 429 errors accumulating
// across tests. An AUTO fixture, not a `page` override: API-only tests that
// never touch `page` (e.g. pure `request` tests) must be cleared too — one
// slipped through and inherited the previous test's register spend, tripping
// the 3/min IP limit with its 10-minute block.
export const test = base.extend<{ clearLimits: void }>({
  clearLimits: [
    async ({}, use) => {
      await clearRateLimits();
      await use(undefined as void);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
