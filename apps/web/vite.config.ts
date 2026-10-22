import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server's Host/Origin checks admit the dev server through CBOARD_DEV_ORIGINS,
// which the server's `dev` scripts set to this origin.
const DEV_PORT = 5173;
const serverPort = Number(process.env.CBOARD_PORT) || 4317;
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/auth': { target },
      '/ws': { target, ws: true },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
