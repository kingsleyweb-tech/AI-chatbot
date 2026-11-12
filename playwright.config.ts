import { defineConfig, devices } from '@playwright/test';

// Mobile smoke tests against the production build (vite preview), in WebKit
// with an iPhone profile. These cover the signed-out surfaces; signed-in flows
// need a real Firebase test account and are documented as manual checks.
export default defineConfig({
  testDir: 'e2e',
  // signed-out pages wait for Firebase Auth over the network (seconds on a slow connection); several pages are checked per test
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'] } },
    { name: 'iphone-se-webkit', use: { ...devices['iPhone SE'] } },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
