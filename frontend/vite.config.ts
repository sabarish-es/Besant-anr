import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const frontendRoot = fileURLToPath(new URL('./', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, projectRoot, '');
  const env = loadEnv(mode, frontendRoot, '');
  const target = new URL(env.API_TARGET || `http://127.0.0.1:${rootEnv.API_PORT || '8787'}`);
  const proxy: ProxyOptions = {
    target: target.origin,
    changeOrigin: true,
    configure(server) {
      server.on('proxyReq', (proxyRequest, request) => {
        // Only translate this frontend's own Origin to the API's Origin.
        // Foreign origins and cross-site Fetch Metadata reach the API unchanged.
        const frontendOrigin = `http://${request.headers.host}`;
        if (request.headers.origin === frontendOrigin) {
          proxyRequest.setHeader('origin', target.origin);
        }
      });
    },
  };
  return {
    root: frontendRoot,
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) } },
    server: {
      host: '0.0.0.0', port: Number(env.FRONTEND_PORT || '5174'), strictPort: false,
      proxy: { '/api': proxy },
    },
    preview: {
      host: '127.0.0.1', port: 4173, strictPort: true,
      proxy: { '/api': proxy },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
