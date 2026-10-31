import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Assets use relative URLs; the server injects <base href> at runtime so one build works at / and /webmail.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5304,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5300', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
