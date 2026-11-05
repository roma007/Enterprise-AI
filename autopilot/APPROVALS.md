# Autopilot 执行授权（本地开发）

> 记录用户对“外部资源”类前置条件的明确授权，供定时器读取。
> 不包含生产环境、客户数据或真实支付。

## 本地数据库

- `DATABASE_URL=postgres://127.0.0.1:5432/ai_delivery` 已写入 `backend/.env`（gitignored）。
- 授权在该库执行：迁移、种子、`verify:write`、`verify:report`、清理 dry-run 与清理确认。
- 该库是本地开发/测试库，测试组织与测试数据可被创建、归档或删除。
- 禁止连接生产库、客户环境或任何非本机数据库。

## npm registry

- 授权为 T05 访问公共 npm registry，安装 Vitest / jsdom / Testing Library 及其类型包。
- 安装后必须提交 `frontend/package.json` 与 `frontend/package-lock.json`。
- 选择与 React 19、Vite 8、Node 22 兼容的版本；若版本冲突，标记 blocked 并说明。

## 文档口径

- `backend/README.md` 中带日期“全新库演练（历史记录，2026-11-04）”保留当时数字，不改写成当前值。
- 当前状态数字以 2026-11-05 实测为准：24 条 e2e、58 个迁移、86 张表、81 张启用 RLS、`verify:write` 51 项。

## T01 完成记录

- 2026-11-05：已按实测更新 `TODO.md`、`06_实施计划.md`、`企业AI化项目管理系统/README.md`、`backend/README.md` 的历史标注。
- 验收：`playwright test --list` = 20；migrations = 58；tables = 86；RLS = 81。
