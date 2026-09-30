import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3132',
    },
  },
  build: { outDir: 'dist' },
});
