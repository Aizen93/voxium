import { test as base } from '@playwright/test';
import { clearRateLimits } from './api';

// Clear rate limits before each test to prevent 429 errors accumulating
// across tests (the in-memory fallback limiter persists in the server process).
export const test = base.extend({
  page: async ({ page }, use) => {
    await clearRateLimits();
    await use(page);
  },
});

export { expect } from '@playwright/test';
