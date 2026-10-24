import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    // Same-origin websocket so a single tunnel/URL serves both page and game server.
    proxy: { '/ws': { target: 'ws://localhost:7777', ws: true } },
  },
  base: './',
});
