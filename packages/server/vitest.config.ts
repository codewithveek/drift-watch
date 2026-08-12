import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    /*
     * Above vitest's 5s default because every test here boots a real Fastify
     * instance, and the static-console ones additionally create a temp
     * directory and let @fastify/static stat the filesystem. That is fast in
     * isolation but has been observed to exceed 5s under the contention of a
     * workspace-wide `pnpm -r test`, where three packages' suites run at once
     * — a flake in exactly the command someone is most likely to run. This is
     * headroom for a slow machine, not cover for a slow test.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
