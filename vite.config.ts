import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
    proxy: {
      // Proxy Admin API calls through the dev server to avoid CORS.
      // Browser calls /api/cloudinary/... → Vite forwards to https://api.cloudinary.com/...
      '/api/cloudinary': {
        target: 'https://api.cloudinary.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cloudinary/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
