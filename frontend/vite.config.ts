import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // mermaid 图表块按需加载（MarkdownView 懒加载），单块偏大但不进首屏
    chunkSizeWarningLimit: 1600,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // 开发时前端同源调用，避免 CORS；生产可改为网关反代
      '/api': 'http://127.0.0.1:8788',
    },
  },
});
