import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A UI fala com o servidor local via /api e /media. O proxy do Vite evita CORS
// no desenvolvimento e faz a mesma URL valer dentro do Electron.
const API = `http://127.0.0.1:${process.env.REVISOR_PORT || 5273}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5274,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
