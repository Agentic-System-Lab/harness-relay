import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5173,
    // Trailing slash matters: a bare '/api' prefix would also swallow the client module '/api.ts'.
    proxy: { '/api/': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
