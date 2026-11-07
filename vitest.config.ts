import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./server/shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    exclude: ['tests/rules/**', 'node_modules/**'],
    environment: 'node',
  },
});
