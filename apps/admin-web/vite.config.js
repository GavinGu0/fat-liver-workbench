import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  build: {
    outDir: '../../dist/admin',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  }
});
