import { test as base } from '@playwright/test';

// Rate limit keys are cleared once per run in global-setup.ts.
// Re-export base test — no per-test fixture overhead needed.
export const test = base;

export { expect } from '@playwright/test';
