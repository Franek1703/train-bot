import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/*.browser.test.ts'], testTimeout: 20_000, hookTimeout: 30_000, fileParallelism: !process.env.TEST_DATABASE_URL },
});
