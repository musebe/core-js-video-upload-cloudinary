import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    rollupOptions: {
      // Multi-page app — both HTML files must be declared so Vite includes them in dist/.
      input: {
        main: resolve(__dirname, 'index.html'),
        gallery: resolve(__dirname, 'gallery.html'),
      },
    },
  },
});
