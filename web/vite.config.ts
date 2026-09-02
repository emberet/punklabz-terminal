import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const mobileExamples = fileURLToPath(
  new URL('../node_modules/libphonenumber-js/examples.mobile.json', import.meta.url),
);
const oxEntry = fileURLToPath(new URL('../node_modules/ox/_esm/index.js', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Privy's SDK imports the JSON compatibility path, which Vite 5 cannot
    // resolve through npm workspaces. The package exports this ESM twin.
    alias: [
      { find: 'libphonenumber-js/examples.mobile.json', replacement: mobileExamples },
      { find: /^ox$/, replacement: oxEntry },
    ],
  },
  server: {
    port: 4710,
    proxy: {
      '/api': { target: 'http://localhost:4700', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4700', ws: true },
    },
  },
});
