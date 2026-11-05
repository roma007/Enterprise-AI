import { defineConfig } from 'vitest/config';

// T05 · 组件级单测基础设施（纯前端，无后端、无数据库）
// 使用 esbuild 的 automatic JSX runtime（tsconfig jsx: react-jsx），不加载 @vitejs/plugin-react，
// 避免与 e2e 的 Playwright 配置互相影响。
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
});
