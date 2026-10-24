import { test as base } from '@playwright/test';
import { clearRateLimits } from './api';

// Clear rate limits before each test to prevent 429 errors accumulating
// across tests. An AUTO fixture, not a `page` override: API-only tests that
// never touch `page` (e.g. pure `request` tests) must be cleared too — one
// slipped through and inherited the previous test's register spend, tripping
// the registration burst limit with its block (3/min and 10 minutes then; 5/min and 2 minutes now).
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
