import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Firefox (Gecko) variant for cross-engine validation of secure voice
// (RTCRtpScriptTransform path — Firefox has no createEncodedStreams).
// Untracked helper: run with
//   npx playwright test secure-voice --config=playwright-firefox.config.ts
// Differences from the Chromium config:
// - fake mic via firefoxUserPrefs (Chromium's --use-fake-* flags don't exist)
// - no `permissions: ['microphone']` — Playwright can't grant it on Firefox;
//   media.navigator.permission.disabled covers it
export default defineConfig({
  ...base,
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
          },
        },
      },
    },
  ],
});
