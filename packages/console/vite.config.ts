import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Served in production from the server at the ROOT (see server.ts
// @fastify/static). In dev, server paths are proxied to Fastify on :4300 so the
// console runs on :5173 making the same same-origin fetches as in production.
//
// This list used to enumerate every resource (/agents, /audit, /tools, ...)
// because the API sat at the root alongside the console's own page routes. Now
// that the API is namespaced under /api, two prefixes cover everything:
//
//   /api  — both /api/v1 (DriftWatch) and /api/auth (better-auth). The auth
//           entry is not optional: login POSTs from :5173 must reach Fastify, or
//           they resolve against Vite, which answers unknown paths with the SPA
//           shell — so the fetch "succeeds" and JSON.parse fails on '<'.
//   /health
//
// Everything else falls through to Vite's SPA handling, which is what makes
// console deep links work in dev.
const SERVER_PATHS = ['/api', '/health'];

export default defineConfig({
  base: '/',
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
      SERVER_PATHS.map((path) => [
        path,
        {
          target: 'http://localhost:4300',
          // `changeOrigin: false` is required now that auth uses cookies.
          // Rewriting the Host header to localhost:4300 makes better-auth set
          // the session cookie for that host, which the browser then refuses to
          // store against the :5173 origin — login appears to succeed and never
          // sticks. Keeping the original Host means the cookie matches.
          changeOrigin: false,
        },
      ]),
    ),
  },
});
