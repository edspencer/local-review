import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev`: Vite serves the UI on 5000 and proxies /api to the API on 5001.
// LOCAL_REVIEW_WEB_PORT / LOCAL_REVIEW_API_PORT override both (e.g. to run a second dev instance).
const webPort = Number(process.env.LOCAL_REVIEW_WEB_PORT ?? 5000);
const apiPort = Number(process.env.LOCAL_REVIEW_API_PORT ?? 5001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 4000 },
});
