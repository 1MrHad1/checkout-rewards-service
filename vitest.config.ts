import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Both suites share one database. Running files sequentially keeps each
    // file's TRUNCATE from wiping another file's fixtures mid-run; the
    // concurrency being tested happens *inside* a test, via Promise.all.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://postgres:postgres@localhost:5432/checkout_test',
    },
  },
});
