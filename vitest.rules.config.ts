import { defineConfig } from 'vitest/config';

// Firestore security-rules tests. Run through `npm run test:rules`, which starts
// the local emulator with a demo project (never touches the live database).
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    fileParallelism: false,
  },
});
