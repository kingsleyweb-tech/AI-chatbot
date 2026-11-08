import { defineConfig, devices } from '@playwright/test';

// Signed-in chat tests against the LOCAL Firebase emulators (never the live project) with a
// scripted AI (no Gemini/OpenRouter quota is used). In three terminals:
//   1. npx firebase emulators:start --only firestore,auth --project demo-tessera
//   2. E2E_FAKE_AI=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 //      FIREBASE_PROJECT_ID=demo-tessera VITE_FIREBASE_PROJECT_ID=demo-tessera VITE_FIREBASE_EMULATORS=1 //      VITE_FIREBASE_MEASUREMENT_ID= VITE_APPCHECK_SITE_KEY= npx vite --port 5173 --host 127.0.0.1
//   3. node dev/seed-emulator.mjs   (once per emulator start: creates the approved test account)
//      npx playwright test -c playwright.emulator.config.ts
export default defineConfig({
  testDir: 'e2e-emulator',
  timeout: 360_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', ...devices['Desktop Safari'] },
});
