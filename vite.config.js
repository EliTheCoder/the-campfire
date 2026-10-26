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
  // Cloudflare gives files in public/ a 4h browser cache, so audio URLs carry the build time
  define: { __BUILD__: JSON.stringify(String(Date.now())) },
});
