import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: vite serves the SPA and proxies API/auth to the BFF on :8080. In the
// cluster the BFF serves the built SPA itself (SPA_ROOT), behind oauth2-proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/oauth2': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});