import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_PORT } from './server/port.ts';

// `npm run dev`: Vite serves the UI on the default port and proxies /api to the API on the next one up.
// LOCAL_REVIEW_WEB_PORT / LOCAL_REVIEW_API_PORT override both (e.g. to run a second dev instance).
const webPort = Number(process.env.LOCAL_REVIEW_WEB_PORT ?? DEFAULT_PORT);
const apiPort = Number(process.env.LOCAL_REVIEW_API_PORT ?? DEFAULT_PORT + 1);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  // the built UI, served by the compiled server (dist/server, from `npm run build:server`)
  build: { outDir: 'dist/web', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
