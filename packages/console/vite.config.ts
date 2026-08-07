import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Served in production from the server at /console/ (see server.ts @fastify/static).
// In dev, the API paths are proxied to the Fastify server on :3000 so the
// console can run on :5173 with the same fetch('/agents/...') calls as in
// prod. Every console-facing route is now nested under /agents/:agentId/...
// (or /agents itself for list/register) except the fleet-wide /drift/scan
// and bare /drift alias (both under /drift) and /health.
const API_PATHS = [
  '/agents',
  '/drift',
  '/health',
];

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PATHS.map((path) => [path, { target: 'http://localhost:3000', changeOrigin: true }]),
    ),
  },
});
