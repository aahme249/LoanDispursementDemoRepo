import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Containers and the Temporal test server take a while to boot.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Integration tests share one Postgres container per file; keep files isolated.
    fileParallelism: false,
  },
});
