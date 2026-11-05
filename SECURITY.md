# 依赖安全与审计记录

> 更新时间：2026-11-05
> 范围：`backend` 与 `frontend` 的 npm 依赖。
> 原则：记录实测结果，区分“已修复”与“已知风险”；不在自动推进中执行破坏性降级。

---

## 1. 当前结论

| 范围 | 命令 | 结果 | 处置 |
|---|---|---|---|
| 后端生产依赖 | `cd backend && npm audit --omit=dev` | **5 moderate / 0 high / 0 critical** | 已知风险，记录并跟踪上游 |
| 后端含开发依赖 | `cd backend && npm audit` | **9 vulnerabilities（6 moderate、3 high）** | 开发/演练工具链，不进入生产镜像 |
| 前端 | `cd frontend && npm audit --omit=dev` | **0 vulnerabilities** | 无需处置 |

> `npm audit fix --force` 会执行破坏性降级（`s3rver@2.2.9`、`exceljs@3.4.0`），**禁止**在自动推进或发布流程中直接执行。

---

## 2. 生产依赖明细

| 依赖链 | 严重级别 | 公告 | 影响面 | 可用修复 | 当前决定 |
|---|---|---|---|---|---|
| `@fastify/static` → `glob` 9.0.0–14.0.1 | moderate | GHSA-3g3m-2fjr-6pw4：`AbortSignal` 取消绕过，超时后仍可能遍历文件系统 | 静态文件服务；本项目未把用户可控路径传给 `glob` | `npm audit fix`（非破坏性） | 待依赖升级窗口执行，升级后跑后端回归与前端 build/e2e |
| `@fastify/static` → `minimatch` 7.0.0–11.0.0 | moderate | GHSA-g3hv-75wg-m249：`globparts` 放大导致潜在 DoS | 静态文件匹配；输入不是外部任意模式 | `npm audit fix`（非破坏性） | 同上 |
| `exceljs` → `uuid` < 11.1.1 | moderate | GHSA-w5hq-g745-h8pq：v3/v5/v6 传入 `buf` 时缺少边界检查 | 仅用于 Excel 导入/模板；`exceljs@4.4.0` 内部只调用 `uuid.v4()`，当前路径不触发该公告场景 | `npm audit fix --force` 会把 `exceljs` 降到 3.4.0（破坏性） | **不降级**；等 `exceljs` 升级 `uuid` 或替换导入库 |

---

## 3. 开发依赖明细

| 依赖链 | 严重级别 | 说明 | 当前决定 |
|---|---|---|---|
| `s3rver` → `busboy` → `dicer` | high | 仅用于本地 S3 兼容演练（`drill:s3`），不进入生产运行时 | 不降级，接受为本地测试风险 |
| `s3rver` → `fast-xml-parser` | moderate | 同上，XML 解析只在本地演练中使用 | 不降级，接受为本地测试风险 |

> 开发依赖的漏洞不会随生产镜像发布；但运行 `npm run drill:s3` 的机器应视为测试环境，不处理不可信文件。

---

## 4. 处置与验收要求

### 4.1 允许的非破坏性修复

```bash
cd backend
npm audit fix
npm run typecheck
npm run verify:write
```

- 必须提交 `package-lock.json`。
- 必须串行跑后端 `typecheck` / `verify:write`；如涉及前端锁文件，再跑前端 `typecheck` / `build` / e2e。
- 若 `npm audit fix` 产生 `@fastify/static` 主版本变化，按破坏性变更处理，先单独开任务评估。

### 4.2 禁止项

- 禁止 `npm audit fix --force`。
- 禁止为“清空 audit”而把 `exceljs` / `s3rver` 降到旧版本。
- 禁止在未跑回归的情况下提交锁文件变更。
- 禁止把“已记录风险”写成“已修复”。

### 4.3 升级触发条件

满足任一条件时重新评估：

1. `exceljs` 发布升级 `uuid` 的版本，且 `npm audit --omit=dev` 清零。
2. `@fastify/static` 上游修复 `glob/minimatch`，`npm audit fix` 可直接完成。
3. 本项目开始处理外部上传的 Excel 或对外暴露静态目录。
4. 安全评审要求生产依赖 0 moderate。

---

## 5. 复核记录

| 日期 | 执行者 | 命令 | 结果 |
|---|---|---|---|
| 2026-11-05 | 协调者 | `npm audit --omit=dev`（backend / frontend）；`npm audit`（backend） | 后端生产 5 moderate；前端 0；后端含开发依赖 9（6 moderate、3 high） |
