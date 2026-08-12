import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Served in production from the server at /console/ (see server.ts @fastify/static).
// In dev, the API paths are proxied to the Fastify server on :3000 so the
// console can run on :5173 with the same fetch('/agents/...') calls as in
// prod. Every console-facing route is now nested under /agents/:agentId/...
// (or /agents itself for list/register) except the fleet-wide /drift/scan
// and bare /drift alias (both under /drift) and /health.
// `/tools` belongs here for the same reason as the rest: the console's tool
// registry lookups (Config's tool list, Overview's tool-access card) are
// same-origin fetches in production. Without the proxy entry they resolve
// against Vite in dev, which answers every unknown path with the SPA's
// index.html — so the fetch succeeds and JSON.parse fails on '<'.
const API_PATHS = [
  '/agents',
  '/api-keys',
  '/audit',
  '/drift',
  '/health',
  '/tools',
];

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        /*
         * Recharts and its d3 dependencies are roughly half the bundle, and
         * they change on a completely different cadence to this app's code.
         * Splitting them out means a console deploy re-downloads ~120 kB
         * instead of ~270 kB, and the two chunks fetch in parallel on a cold
         * load. Split by package boundary only — hand-partitioning app modules
         * is how module init order gets broken.
         */
        manualChunks: (id) =>
          /node_modules[\\/](recharts|d3-|victory-|internmap|decimal\.js)/.test(id)
            ? 'charts'
            : undefined,
      },
    },
  },
  resolve: {
    // Must mirror tsconfig.json's `paths` — that only satisfies tsc, not the
    // bundler. shadcn-generated components import via `@/`.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PATHS.map((path) => [path, { target: 'http://localhost:3000', changeOrigin: true }]),
    ),
  },
});
