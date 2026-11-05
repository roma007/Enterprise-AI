// T05 · 组件级单测 setup（mock / 非真实联调：纯展示/交互组件，无后端、无数据库）
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每个用例后卸载已渲染组件，避免 DOM 互相污染。
afterEach(() => {
  cleanup();
});
