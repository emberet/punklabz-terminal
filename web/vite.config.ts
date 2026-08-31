import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4710,
    proxy: {
      '/api': { target: 'http://localhost:4700', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4700', ws: true },
    },
  },
});
