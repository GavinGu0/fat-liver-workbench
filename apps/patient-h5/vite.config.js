import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/patient/',
  plugins: [vue()],
  build: {
    outDir: '../../dist/patient',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  }
});
