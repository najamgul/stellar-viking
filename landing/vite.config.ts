import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Build straight into the Fastify static root so the landing page
    // is served at "/" by the main app (and shipped by the existing
    // Dockerfile, which copies public/). Never wipe public/ — it also
    // holds admin.html, login.html, etc.
    outDir: '../public',
    emptyOutDir: false,
  },
  server: {
    // In `npm run dev`, proxy API calls to the local Fastify server
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
