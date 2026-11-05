# 企业 AI 化项目管理系统 · 后端

诊断阶段（S1）的可运行后端。把文档里的领域模型、四条硬规则和 R5 十四项校验落成了 **PostgreSQL + TypeScript**。

```
Fastify 5  ←  HTTP
   │
   ├── src/repo.ts          一次取出生成报告需要的完整快照
   ├── src/rules/           四条硬规则之外的跨表判断（C1–C14、传导链、分位）
   ├── src/templates/       物流行业诊断报告模板（决定局限出现在哪一节）
   └── src/services/        生成交付物：拦截 block、写审计、存快照
          │
          └── PostgreSQL 15
                ├── 001_schema.sql    30 张表（v1 21 + v2.2 9）
                ├── 002_functions.sql 触发器 / 分位 / 连乘 / 视图
                └── 003_seed.sql      宏远国际物流样例
```

## 快速开始

```bash
cd backend
npm install
npm run db:reset     # 清空 → 迁移 → 灌样例（本地开发）
npm run db:migrate   # 只跑增量迁移（已有库升级时用）
npm run verify       # 17 项数据库规则断言（R1–R4 / P1–P4），失败即非零退出
npm run verify:report # 11 项报告结构与生成接口回归（章节编号 / 流程 / 四维 / 并发）
npm run verify:write # 30 项 S1 录入闭环回归（从空客户建项目直到生成报告）
npm run demo         # 跑 14 项校验 + 打印组合数字 + 生成 1 份报告
npm run openapi      # 生成 docs/openapi.json
npm run dev          # http://127.0.0.1:8788
```

演示登录账号（`db:reset` 后可用）：

| 邮箱 | 密码 | 角色 |
|---|---|---|
| `zhang@hengzhi.ai` | `demo1234` | consultant |
| `wang@hengzhi.ai` | `demo1234` | pm |
| `liu@hengzhi.ai` | `demo1234` | tech_lead |
| `admin@hengzhi.ai` | `demo1234` | admin |

`AUTH_REQUIRED` 默认 `false`，本地不登录也能调接口（回退到第一个组织）；设为 `true` 后，除 health/login/config/docs 外都需要 `Authorization: Bearer <token>`。单资源归属校验按 `org_id` 执行，跨组织访问统一返回 404；列表按当前组织过滤。

**角色权限（有登录态时生效）**：

| 动作 | admin / director | pm | consultant / tech_lead |
|---|---|---|---|
| 普通业务录入（痛点/机会点/方案/POC/交付/UAT/运营） | ✅ | ✅ | ✅ |
| 查看审计日志、回收站 | ✅ | ✅ | ❌ |
| 删除客户/项目/交付物、恢复回收站 | ✅ | ✅ | ❌ |
| 交付物审批、外发、撤销外发 | ✅ | ✅ | ❌ |
| 知识审批（通过/退回） | ✅ | ✅ | ❌ |
| 行业标杆、指标字典维护 | ✅ | ❌ | ❌ |

匿名开发模式不做角色校验；`AUTH_REQUIRED=true` 时必须带有效 token。越权统一返回 403 `FORBIDDEN`。

**项目级成员权限**：

- `GET/POST /api/engagements/:id/members`、`PATCH/DELETE /api/engagement-members/:id`
- 角色：`manager`（负责人）/ `member`（成员）/ `viewer`（只读）
- 项目配置成员后，非成员访问项目资源返回 403 `PROJECT_FORBIDDEN`，列表中也不再出现该项目。
- `viewer` 只读，写操作返回 403 `PROJECT_READONLY`。
- 未配置成员的项目保持组织内可见，避免历史项目被锁死。
- 管理员/总监保留组织级可见性；项目经理可管理成员；项目至少保留一名负责人。
- 成员关系随项目硬删除级联清理。

**登录安全**：连续登录失败按 `IP + 邮箱` 计数，默认 5 次 / 15 分钟（`LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MS`）；超限返回 429 `LOGIN_RATE_LIMITED` + `retry-after`，限流期间即使密码正确也会被拦截。登录成功清空计数。优先使用 Redis（`REDIS_URL`），未配置或不可用时回退进程内存；多实例部署必须配置 Redis。

**会话缓存**：`sessionActive` 结果缓存 30 秒（Redis 或内存），撤销/强制下线/暂停租户会主动失效对应 key。`GET /api/system/cache`（平台管理员）查看驱动与健康状态。

**密码策略**：新建用户、管理员重置、自助改密统一校验：≥10 位、大小写/数字/符号至少 3 类、不能是常见弱口令或包含邮箱前缀；新密码不能与最近 5 次相同（`password_history`）。违反返回 422 `WEAK_PASSWORD` / `PASSWORD_REUSED`。

**多租户基础**：`organizations` 即供应商租户，新增 `slug/status/settings`；`POST /api/auth/register` 自助创建租户 + 管理员；登录支持 `org_slug`，同一邮箱属于多个组织时必须填写。

**PostgreSQL RLS**：迁移 `0029_rls.sql` 创建受限角色 `ai_delivery_app`、`app_org_id()`/`app_platform_admin()`，并为全部租户表启用 RLS。请求通过 `@fastify/request-context` 注入 `org_id`/平台管理员标记；每个 API 请求复用一条数据库连接并设置会话级 `SET ROLE ai_delivery_app + app.org_id`，请求结束释放并清理上下文。登录、公开分享、健康检查等使用服务角色绕过 RLS。`/api/system/db-context` 可验证当前数据库角色、org 与请求内连接复用。`benchmarks` / `metric_definitions` 为平台字典，仅平台管理员可改。连接池上限 `PG_POOL_MAX` 默认 20。

**平台运营**：`users.is_platform_admin` 标记平台管理员（seed 的 `admin@hengzhi.ai`）。`GET /api/platform/tenants` 列表（含近 30 天导出任务/行数/失败统计）、`GET /api/platform/tenants/export.csv` 用量 CSV、`PATCH /api/platform/tenants/:id` 暂停/恢复/套餐/试用到期/账单邮箱；暂停立即撤销该组织全部会话并阻止登录。`GET/PATCH /api/org` 供租户管理员维护组织名称与账单邮箱。

**节假日日历**：`holiday_calendar` 支持平台级（`org_id IS NULL`）与组织级节假日，按 `region` 区分；`GET/POST /api/holidays`、`DELETE /api/holidays/:id`，仅管理员/总监可维护。组织在 `settings.region` 配置 SLA 地区（默认 `CN`）；`GET /api/holidays?effective=1` 只返回该地区（或 `ALL`）的节假日。SLA 计算默认跳过周末，并跳过生效地区的已启用节假日。当前未预置法定节假日，需平台或客户自行维护。

**试用、配额与计费**：`tenant_plans` 为平台级套餐目录（trial/free/pro/enterprise，含用户/客户/项目/本月 PDF 任务上限与月费）。新注册租户自动获得 14 天 `trial`；`trial_ends_at` 到期后登录返回 403 `TRIAL_EXPIRED`，现有会话失效。创建用户/客户/项目/PDF 任务前执行配额检查，超限返回 403 `QUOTA_EXCEEDED`，`details` 带 `resource/limit/used/plan`。`GET /api/org/billing` 返回套餐、试用剩余、用量与价格；`GET /api/platform/plans` 返回套餐目录。当前支付支持 `mock`（本地模拟）/ `manual`（平台确认收款）/ `callback`（HMAC 网关回调）；未内置具体支付厂商 SDK。账单接口：`GET/POST /api/org/billing/*`、`GET /api/platform/invoices`、`POST /api/platform/invoices/:id/mark-paid|void`、`POST /api/billing/callback`。自动续费任务：`npm run billing:run`。

租户生命周期：`GET /api/platform/tenants/:id/impact` 影响评估；`GET /api/platform/tenants/:id/export` 导出组织/用户/客户/项目/机会点/交付物/知识库 JSON；`DELETE /api/platform/tenants/:id?confirm=<slug>` 删除租户并清理审计/归档/会话数据。

**站内通知**：`GET /api/notifications?unread=1&kind=copilot_batch_filter_view_shared&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=20&offset=0`、`GET /api/notifications/unread-count`、通知筛选视图：`GET/POST /api/notification-filter-views`、`DELETE /api/notification-filter-views/:id`（保存类型/未读/日期/收件箱或回收站，同名覆盖，`PATCH /:id` 可重命名；`shared=true` 共享给全员，`shared_role=admin|director|pm|consultant|tech_lead` 按角色共享，`shared_user_ids[]` 指定同事（最多 50 人，非本组织返回 `422 INVALID_SHARED_USERS`）；新增共享对象会写 `copilot_notification_view_shared` 站内通知（重复保存同一批对象不重复提醒），链接 `?notification_view=<viewId>#/notifications`，打开后自动套用该视图；列表返回 `is_owner` 与 `owner_name`，仅创建者可删除）。`POST /api/notifications/:id/read`、`POST /api/notifications/read`（按 `ids[]` 或 `{all:true,kind?,from?,to?}` 批量标为已读）、`POST /api/notifications/read-all`、`POST /api/notifications/delete`（body `{ ids[] }` 最多 100 条，或 `{ all: true, unread?, kind?, from?, to? }` 按当前筛选批量删除，均为软删除）。`GET /api/notifications?trash=1` 查看回收站；`POST /api/notifications/restore`、`POST /api/notifications/purge` 恢复或彻底删除。`from > to` 返回 `400 INVALID_DATE_RANGE`。删除/恢复/彻底删除写 `DELETE/RESTORE/PURGE copilot-notification` 审计事件。`GET /api/notification-audits?action=&from=&to=&actor_id=&limit=&offset=` 供管理员/总监查询通知审计；`GET /api/notification-audits/export.csv` 导出最多 5000 条 CSV（含操作人、数量、模式、筛选条件与通知 ID）。统一协作审计：`GET /api/collab-audits?type=all|notification|filter_view|export|decision&action=&from=&to=&actor_id=&limit=&offset=` 合并通知、筛选视图、导出与差异决策审计（列表返回 `object_id` / `request_id`；决策行还返回 `engagement_id`，便于跳转复核）；操作与类型不匹配返回 `400 INVALID_ACTION_TYPE`；`GET /api/collab-audits/export.csv` 导出 CSV；`GET /api/collab-audits/stats?from=&to=&actor_id=` 返回总数、按类型计数、Top 操作与 Top 操作人；`GET /api/collab-audits/archive?...` 查询 `audit_logs_archive` 中的归档协作审计（含 `archived_at` 与最近归档摘要）；`GET /api/collab-audits/archive/export.csv` 导出归档审计 CSV；`GET /api/collab-audits/archive-runs?from=&to=` 分页返回归档执行历史；`GET /api/collab-audits/snapshots?days=30&bucket=day|week|month` 返回连续日期序列（缺失日期补点、累计值顺延）及 `delta_*` 新增量，支持按周/月聚合，并返回 `comparison`（本周期 / 上一等长周期的 `delta_*` 与环比差值）；`GET /api/collab-audits/snapshots/export.csv?days=30&bucket=...` 导出同口径 CSV（含周期区间与新增）；`GET /api/collab-audits/snapshots/comparison/export.csv?days=30&bucket=...` 导出环比 CSV（指标、本/上周期区间与新增、环比）；`GET /api/collab-audits/snapshots/export-long.csv?days=30&bucket=...` 导出分面长表（周期 / 类型 / 累计 / 新增，便于透视与绘图）；`GET /api/collab-audits/report.md` / `report.docx?days=7&bucket=day|week|month` 生成协作审计报告（新增环比、类型分布、高频操作、活跃操作人、趋势），Word 导出写 `EXPORT copilot-collab-report` 审计事件；`GET /api/collab-audits/merged?...` 合并热表与归档（返回 `is_archived` / `archived_at`），`/merged/export.csv` 导出合并结果；`stats?scope=live|archive|all` 支持合并统计，`by_type` 含 `decision`。差异决策（`DECIDE copilot-reconcile-difference`）计入协作审计与每日快照。每日快照按组织 `settings.timezone`（默认 `Asia/Shanghai`，PATCH /api/org 时校验，非法值返回 `422 INVALID_TIMEZONE`）生成，统计口径同时包含热表 `audit_logs` 与归档表 `audit_logs_archive`，避免归档后累计量下降；查询窗口同样以组织时区的当天作为截止日，由 `COLLAB_AUDIT_SNAPSHOT_INTERVAL_SECONDS`（默认 86400 秒，0 关闭）触发，也可运行 `npm run collab-audits:snapshot`，写入 `collab_audit_snapshots`；快照保留期由 `COLLAB_AUDIT_SNAPSHOT_RETENTION_DAYS`（默认 365 天）控制，并随快照任务清理；清理写 `CLEANUP copilot-collab-snapshots`，导出写 `EXPORT copilot-collab-snapshots`。修改时区后可调用 `POST /api/org/snapshots/retime` 按 `created_at` 重算历史快照日期（同日保留最新一条），并写 `RETIME copilot-collab-snapshots` 审计事件。归档动作写 `ARCHIVE copilot-collab-audits`，归档导出写 `EXPORT copilot-collab-archive`。协作审计周报：API 进程按 `COLLAB_AUDIT_DIGEST_INTERVAL_SECONDS`（默认 3600 秒，0 关闭）巡检，向管理员/总监/项目经理发送 `copilot_collab_audit_digest` 站内通知（近 7 天统计与环比，同一用户 6 天内不重复），链接 `?collab_from=YYYY-MM-DD&collab_to=YYYY-MM-DD#/collab-audits`，点击即按该日期范围查看；也可运行 `npm run collab-audits:digest`。协作审计筛选项可保存为个人视图：`GET/POST /api/collab-audit-filter-views`、`DELETE /api/collab-audit-filter-views/:id`（类型/操作/日期/操作人/范围，同名覆盖，仅创建者可改/删，`PATCH /:id` 重命名；`shared` / `shared_role` / `shared_user_ids[]` 共享给同事，新增对象写 `copilot_collab_view_shared` 通知，链接 `?collab_view=<viewId>#/collab-audits`，仅通知可查看协作审计的成员）。协作审计热表保留期由 `COLLAB_AUDIT_RETENTION_DAYS` 控制（默认 365 天），API 进程按 `COLLAB_AUDIT_ARCHIVE_INTERVAL_SECONDS`（默认 86400 秒，0 关闭）自动归档到 `audit_logs_archive`，也可运行 `npm run collab-audits:archive`；导出动作记录 `EXPORT copilot-notification-audits` / `EXPORT copilot-collab-audits` 审计事件。回收站保留期由 `NOTIFICATION_TRASH_RETENTION_DAYS` 控制（默认 30 天），API 进程按 `NOTIFICATION_CLEANUP_INTERVAL_SECONDS`（默认 3600 秒，0 关闭）常驻清理，也可运行 `npm run notifications:cleanup`；打开回收站时会先清理当前用户过期通知。当前用于筛选视图共享：只通知本次新增的共享对象，重新保存不会重复提醒。

**用户管理**（仅管理员/总监）：`GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/reset-password`；支持创建账号、调整组织角色、禁用/启用、重置密码；禁用与重置会撤销该用户全部会话，组织至少保留一名启用管理员。

**会话撤销**：登录 token 携带 `jti`，`user_sessions` 记录会话；每个带 token 的请求校验会话未撤销未过期。接口：
- `POST /api/auth/change-password`：当前用户校验旧密码后改密，保留当前会话、撤销其他会话；连续错误同样受 `LOGIN_MAX_FAILURES` 限制
- `GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、`POST /api/auth/logout`、`POST /api/auth/logout-all`
- `GET /api/users/:id/sessions`、`POST /api/users/:id/revoke-sessions`（仅管理员/总监）
- 前端「登录会话」页可查看设备/IP/时间，撤销单个会话或全部退出。
- 会话清理：`POST /api/user-sessions/cleanup`（执行需 `confirm=CLEANUP`，仅管理员/总监，按当前组织）或 CLI `npm run sessions:cleanup -- --days=30 --dry-run`；只删除已过期/已撤销且超过保留期的会话，`USER_SESSION_RETENTION_DAYS` 默认 30 天。

**可观测性**：

- 每个响应带 `x-request-id`；上游传入合法 `x-request-id` 时原样透传，否则生成 UUID。
- 错误响应体包含 `requestId`，前端错误框直接展示，便于按 ID 查日志。
- 访问日志为结构化 JSON：`event=request_completed`、`requestId`、`method`、`route`、`statusCode`、`durationMs`、`orgId`、`userId`。
- 日志自动脱敏 `authorization` / `cookie` / `set-cookie`。
- `audit_logs.request_id` 与访问日志同源，审计页可直接看到请求 ID。
- 公开分享访问：默认每 IP + token 60 次/分钟（`PUBLIC_SHARE_RATE_LIMIT` / `PUBLIC_SHARE_RATE_WINDOW_MS`），超限返回 429 + `retry-after`；记录 browser/Word/PDF 访问明细与 IP/UA/Referer（`TRUST_PROXY=true` 时使用代理转发 IP）。

分享访问归档：`POST /api/share-views/archive`（执行需 `confirm=CLEANUP`，仅管理员/总监，按当前组织）或 CLI `npm run share:archive -- --days=180 --dry-run`；`SHARE_VIEW_RETENTION_DAYS` 默认 180 天。热表移入 `share_views_archive`，不物理删除。

分享归档查询/导出：`GET /api/share-views/archive` 支持 `share_id/token/kind/from/to` + 分页；`GET /api/share-views/archive/export.csv` 最多 5 万行。归档表带 `org_id`，分享链接删除后仍可按组织检索。
- 慢请求：`durationMs` 超过 `SLOW_REQUEST_MS`（默认 500ms）时额外输出 `event=slow_request` 警告日志。
- 指标端点 `GET /metrics`（Prometheus 文本格式，进程内计数，重启归零）：
  - `http_requests_total{method,route,status}`
  - `http_request_duration_ms` 直方图（50/100/200/500/1000/2000/5000ms）
  - `slow_requests_total`
  - `pdf_cache_hits_total` / `pdf_cache_misses_total`（进程内 PDF 缓存命中）
  - `process_uptime_seconds`
  - `db_up`（`SELECT 1` 探活）
  - `db_pool_total_connections` / `db_pool_idle_connections` / `db_pool_waiting_requests` / `db_pool_max_connections`
  - `redis_configured` / `redis_up`
  - `pdf_jobs_pending` / `pdf_jobs_running` / `pdf_jobs_done_24h` / `pdf_jobs_failed_24h` / `pdf_jobs_oldest_pending_seconds`
  - 设置 `METRICS_TOKEN` 后需 `Authorization: Bearer <token>` 或 `?token=`；`/metrics` 抓取本身不计入指标。
  - SLO、错误预算与告警 Runbook 见 `ops/slo.md`。

**审计归档**：

- 热表 `audit_logs` + 归档表 `audit_logs_archive`（同构，多 `archived_at`）。
- `POST /api/audit-logs/archive`：`{ before, dry_run, confirm }`；默认 dry-run，执行需 `confirm=ARCHIVE`。
- `GET /api/audit-logs/archive`：分页查询归档记录。
- `GET /api/audit-logs/facets?scope=live|archive`：返回可选的操作与对象类型，供页面下拉筛选。
- 导出：`GET /api/audit-logs/export.csv?scope=live|archive&q=&action=&object_type=&status=&from=&to=&columns=`，最多 5000 条；`columns` 逗号分隔（time/action/object_type/object_id/status/user/request_id/ip/user_agent/detail/archived_at），非法列返回 `400 INVALID_COLUMNS`，`archived_at` 仅归档范围可用；写 `EXPORT audit-logs` 审计事件。
- 异步导出：`POST /api/audit-exports`（scope/筛选/columns，返回 202）、`GET /api/audit-exports`、`GET /api/audit-exports/:id/download`、`DELETE /api/audit-exports/:id`、`POST /api/audit-exports/:id/retry`（仅 failed 可重试）、`GET /api/audit-export-cleanups`（最近清理记录）、`POST /api/audit-exports/cleanup`（默认 dry-run，确认传 `confirm=CLEANUP`，管理员/总监）；CLI `npm run audit:exports:cleanup -- --dry-run` / `--yes`；任务写入 `audit_export_jobs`，文件存对象存储（`audit-exports/<id>.csv`），进程重启后自动续跑，单次最多 `AUDIT_EXPORT_MAX_ROWS`（默认 100000）行；任务与文件默认保留 7 天（组织设置 `settings.audit_export_retention_days` 优先，未配置时用 `AUDIT_EXPORT_RETENTION_DAYS`），常驻清理间隔 `AUDIT_EXPORT_CLEANUP_INTERVAL_SECONDS`（默认 3600 秒，0 关闭）；清理为每个组织写 `CLEANUP audit-exports` 审计事件（保留天数、该组织删除数）。
- 审计筛选视图：`GET/POST /api/audit-filter-views`、`PATCH/DELETE /api/audit-filter-views/:id`（保存关键词/操作/对象/状态/日期/热表或归档，同名覆盖，仅创建者可改/删；`shared=true` 共享给全员，`shared_role=admin|director|pm|consultant|tech_lead` 按角色共享，`shared_user_ids[]` 指定同事（非本组织返回 `422 INVALID_SHARED_USERS`）；新增共享对象写 `copilot_audit_view_shared` 通知，链接 `?audit_view=<viewId>#/audit` 自动套用；`export_columns[]` 一并保存导出列模板，套用视图时恢复；`GET /api/audit-filter-views/export.json` 导出本人视图（不含共享关系），`POST /api/audit-filter-views/import/preview` 预览新增/冲突数量，`POST /api/audit-filter-views/import` 导入最多 100 个视图，`mode=overwrite|skip` 选择覆盖或跳过同名项，返回 `results[]` 逐条说明导入/跳过与原因）。
- 归档只移动、不删除；管理员/总监可操作，其他角色 403。
- CLI：`npm run audit:archive -- --days=180 --dry-run`，去掉 `--dry-run` 执行；支持 `--batch=1000`。
- 建议 cron 每日执行，保留 180 天热数据（`AUDIT_RETENTION_DAYS` 可覆盖）。

**分页**：项目、客户、痛点、盘点、机会点、交付物、知识库、审计日志统一支持 `limit` / `offset`，默认 200、上限 500，返回 `{ items, total, limit, offset }`；超过上限返回 400。

**搜索**：上述列表均支持 `q`（服务端 ILIKE），项目/客户按名称与行业，痛点/机会点/盘点按编号、标题、描述、来源，交付物按标题/类型，审计按 action/对象/IP/操作人；与分页组合使用，`total` 为过滤后的总数。

数据库连接默认 `postgres://127.0.0.1:5432/ai_delivery`，可用 `DATABASE_URL` 覆盖；复制 `.env.example` 为 `.env` 即自动加载。RLS 默认使用 `DB_APP_ROLE=ai_delivery_app`（迁移创建并授权）；若数据库用户无权创建/授予角色，需由 DBA 预先执行等效授权。

**ai-copilot 评测回写（B4）**

客户侧 ai-copilot 跑完评测后，把指标推过来，直接在 POC 的「运行记录」里生成一条 `poc_run`。

```env
COPILOT_HOOK_TOKEN=与客户侧 DELIVERY_HOOK_TOKEN 一致
```

```
POST /api/hooks/copilot/eval
Header: x-copilot-token: <COPILOT_HOOK_TOKEN>
Body:   { idempotency_key, experiment_id, dataset_name?, config?,
          metrics, issues?, started_at?, finished_at? }
```

- 幂等：`idempotency_key` 已存在 → `200 { duplicate: true }`，不会重复建 run。
- 并发：事务内 `FOR UPDATE` 锁实验，`run_no` 不会撞。
- 鉴权：不需要用户登录（机器到机器），但必须带共享 token；未配置 token 时返回 503。
- 查询：`GET /api/engagements/:id/copilot-syncs` 看该项目收到的回写。
- 原始 payload 存在 `copilot_eval_syncs.payload`，指标口径有争议时可回看。

**ai-copilot 对账复核回写（试点一）**

```env
COPILOT_HOOK_TOKEN=与 ai-copilot 的 DELIVERY_HOOK_TOKEN 一致
```

```
POST /api/hooks/copilot/reconcile
Header: x-copilot-token: <COPILOT_HOOK_TOKEN>
Body:   { idempotency_key, engagement_id | experiment_id, kind,
          document_id?, status?, summary, document, differences, decisions, source? }
```

- `engagement_id` 或 `experiment_id` 至少一个；后者自动推导组织与项目。
- 幂等：`idempotency_key` 已存在 → `200 { duplicate: true }`。
- 存储：`copilot_reconcile_reviews`（RLS 按组织隔离）。
- 查询：`GET /api/engagements/:id/copilot-reconcile-diff-stats` 返回项目内差异分布（类型、来源、置信度分桶、决策），`.../export.csv` 导出维度长表并写 `EXPORT copilot-reconcile-diff-stats` 审计；`GET /api/engagements/:id/copilot-reconcile-reviews?decision_state=all|pending|ignored|decided&q=`（`q` 匹配单据号/运单号）（存在未决 / 含已忽略 / 已全部决策）；详情：`GET /api/copilot-reconcile-reviews/:id`。详情会联表返回风险/待办当前状态（`actions[].item_status`、`risk_status`、`issue_status`），风险关闭或待办解决后立即反映，不需要额外回写。
- 批量决策：`POST /api/copilot-reconcile-reviews/:id/decisions/batch`，body `{ difference_ids[], decision, note? }`（最多 500 条）。任一差异不存在则整批不生效并返回 `422 DIFFERENCE_NOT_FOUND`；成功后写一条 `DECIDE copilot-reconcile-difference` 审计（`mode=batch`）。
- 平台决策：`PUT /api/copilot-reconcile-reviews/:id/decisions`，body `{ difference_id, decision: 采纳|忽略|待确认, note? }`。同一差异重复提交会覆盖原记录；未传 `note` 时保留原备注。决策写入 `decisions[]`（含 `source=platform`、`decided_by`、`decided_at`），并写 `DECIDE copilot-reconcile-difference` 审计；差异不存在返回 `422 DIFFERENCE_NOT_FOUND`。
- 生成风险/待办：`POST /api/copilot-reconcile-reviews/:id/actions`（`type=risk|issue`）。支持整张复核或单条 `difference_id`；每条差异/每类动作最多生成一次。支持 `owner` / `due_date` / `severity`，未传时默认当前用户，并按当前组织可见节假日计算 P0/P1/P2/P3 = 1/3/7/14 个工作日（跳过周末 + 已配置节假日）。风险同样支持 `owner` / `due_date`，风险登记册支持行内修改。
- 批量生成：`POST /api/copilot-reconcile-reviews/:id/actions/batch`，body `{ type, difference_ids[], owner?, due_date?, severity? }`。每条差异使用独立保存点，单条失败不影响其他条；返回 `created/skipped/failed` 汇总与 `items[]` 明细（`status=created|duplicate|failed`，失败带 `code/error`）。已存在动作返回 `duplicate`，请求内重复或差异不存在返回 `failed`。
- 流式批量：`POST /api/copilot-reconcile-reviews/:id/actions/batch/stream`，同样的 body，返回 `application/x-ndjson`。每处理完一条立即输出一行结果，最后输出 `{ done: true, batch_id, created, skipped, failed }`；每条差异使用独立事务，前端可显示逐条进度。
- 批量历史：`GET /api/copilot-reconcile-reviews/:id/action-batches?limit=20&offset=0` 按**根批次**分页，一次返回整棵树（含 `depth`、`total` 根组数、`batch_total`、`roots_returned`、`failed_difference_ids`、`has_child`、`parent_batch_id`、`remaining_difference_ids`）；`remaining_difference_ids` 在内存里按树一次性汇总，避免逐行递归查询；`GET /api/copilot-reconcile-batches/:id` 返回批次与逐条结果。批次与结果落在 `copilot_reconcile_batches` / `copilot_reconcile_batch_items`，刷新后仍可查。读取历史时会顺带回收超时批次：`running` 超过 `BATCH_RUNNING_TIMEOUT_MINUTES`（默认 10 分钟）自动标记为失败并按请求数补 `failed_count`；API 进程内还会按 `BATCH_REAP_INTERVAL_SECONDS`（默认 300 秒，0 关闭）常驻回收，也可运行 `npm run batches:reap` 手动执行。
- 失败重试：`POST /api/copilot-reconcile-batches/:id/retry/stream` 只重试该批次的失败差异，创建带 `parent_batch_id` 的子批次并流式输出进度；成功的子批次会让父批次不再显示重试入口。
- 取消：`POST /api/copilot-reconcile-batches/:id/cancel`，body `{ reason? }`，仅允许取消 `running` 批次；记录 `cancelled_by` / `cancel_reason` / `cancelled_at`，已生成动作保留，剩余未处理数量计入 `failed_count`。流式任务在下一条差异前检查取消状态，停止后保留 `cancelled` 状态，不再被完成回调覆盖。
- 命名筛选视图：`GET/POST /api/copilot-reconcile-reviews/:id/batch-filter-views`、`DELETE /api/copilot-batch-filter-views/:id`。按用户 + 复核隔离，同名保存会更新；支持名称、状态、类型、起止日期与 `shared`。共享支持全员（`shared`）、按角色（`shared_role`）和指定用户（`shared_user_ids`）；列表返回 `is_owner`、`owner_name`、`shared_role` 与 `shared_user_ids`。只有创建者能删除。保存/删除会额外写 `SAVE/DELETE copilot-batch-filter-view` 审计事件；`GET /api/copilot-reconcile-reviews/:id/batch-filter-view-audits?limit=20&offset=0` 分页返回当前复核的视图审计（含 `total/limit/offset`）；`GET .../export.csv` 导出最多 5000 条审计 CSV（含共享设置与筛选条件）。新增共享对象会写入 `user_notifications`，并站内通知被共享人；通知 `link` 为 `#/engagements/<engagementId>?review=<reviewId>&view=<viewId>`，点击直达对应复核并自动套用被共享视图的筛选条件。
- 导出预估：`GET /api/copilot-reconcile-reviews/:id/action-batches/export-estimate` 接收与导出相同的筛选参数，返回 `batches`、`items`、`estimated_bytes`（summary/items/zip）与 `large` 标记。
- 导出汇总：`GET /api/copilot-reconcile-reviews/:id/action-batches/export.csv` 导出该复核的全部批次（CSV，UTF-8 BOM），包含父子 ID、类型、状态、请求/成功/跳过/失败数、级别、截止日期、取消原因/取消人、创建人、创建/完成时间。
- 导出差异：`GET /api/copilot-reconcile-reviews/:id/differences/export.csv` 导出该复核的全部差异（差异 ID、类型、运单/趟次、金额、差额、`source` / `confidence` / `evidence`、可能原因、建议动作、决策与备注），并写 `EXPORT copilot-reconcile-differences` 审计事件。
- 生成复核报告交付物：`POST /api/copilot-reconcile-reviews/:id/documents` 把报告写入 `deliverables`（`type=data_report`、`status=draft`、按项目版本化），内容未变化时重复生成会复用现有版本（返回 `reused=true`，不新增版本、不写生成审计）；审批/外发前会对比报告哈希与当前复核，过期返回 `409 DELIVERABLE_STALE`，需重新生成；审批后可复用现有交付物分享流程生成客户只读链接；写 `GENERATE copilot-reconcile-document` 审计事件。`GET /api/copilot-reconcile-reviews/:id/documents` 返回该复核生成的交付物列表（版本、状态、`is_stale`），按报告内容哈希与当前复核比对判断是否过期；项目交付物列表也会对复核报告返回 `is_stale` 与 `review_id`，可用于一键重新生成。决策变更导致报告过期时，会向本组织管理员/总监/项目经理发送 `copilot_reconcile_report_stale` 通知（同一复核未读提醒不重复），链接为 `#/engagements/<id>?tab=reports`。
- 导出复核报告：`GET /api/copilot-reconcile-reviews/:id/document.docx` 生成 Word（`.../document.pdf` 生成 PDF，按报告内容哈希缓存并返回 `x-pdf-cache`，无 Chromium 时返回 `503 PDF_ENGINE_UNAVAILABLE`；同源 Markdown：`GET .../document`），含单据信息、差异分布（类型 / 来源 / 置信度 / 决策）、差异汇总、逐条差异依据（来源 / 置信度 / 证据 / 原因 / 建议 / 决策）与已生成风险/待办，并写 `EXPORT copilot-reconcile-document` 审计事件。
- 导出明细：`GET /api/copilot-reconcile-reviews/:id/action-batches/export-items.csv` 按批次逐条导出差异（批次/父批次、批次状态、差异 ID、来源/置信度/证据、明细状态、目标/动作 ID、待办编号、失败码/原因、时间、取消信息、创建人）。两套 CSV 都对 `= + - @` 开头的内容加 `'` 前缀，防止 Excel 公式注入；批量导出成功会写独立审计事件 `EXPORT copilot-batch-summary` / `EXPORT copilot-batch-items` / `EXPORT copilot-batch-zip`，包含行数、格式与筛选条件。
- 筛选导出：列表、预估、CSV 与 ZIP 共用 `?status=running|completed|failed|cancelled&action_type=risk|issue&from=YYYY-MM-DD&to=YYYY-MM-DD`，日期按批次创建时间过滤。筛选按**批次组**：组内任一批次命中即整组显示/导出。`from > to` 返回 `400 INVALID_DATE_RANGE`，列表、预估、CSV、ZIP 一致校验。
- 打包导出：`GET /api/copilot-reconcile-reviews/:id/action-batches/export.zip` 返回 ZIP，内含 `batch-summary.csv` 与 `batch-items.csv`，两个文件使用同一组筛选条件。
- 继续：`POST /api/copilot-reconcile-batches/:id/resume/stream` 仅对 `cancelled` 批次生效，body 可覆盖 `{ owner?, severity?, due_date? }`。剩余差异按**递归后代汇总**：`difference_ids` 减去该批次及所有子批次已出现的明细；创建带 `parent_batch_id` 的子批次并流式执行，没有剩余返回 `422 NO_REMAINING_ITEMS`。历史列表与详情返回的 `remaining_difference_ids` 使用同一递归口径。


**服务端 PDF**：`GET /api/deliverables/:id/export.pdf` 用无头 Chromium 把打印版 HTML 渲染成 PDF。按顺序查找：`PDF_CHROME_PATH` → 系统 Chrome / Edge / Brave / Chromium → Playwright 浏览器缓存；每次渲染使用独立用户数据目录，兼容写出 PDF 后不主动退出的浏览器。找不到浏览器时返回 503 `PDF_ENGINE_UNAVAILABLE`，不影响 Word/HTML 导出。Docker 镜像已安装 Debian `chromium` 与 `fonts-noto-cjk`。

PDF 缓存：按交付物 id / 版本 / 标题 / 客户 / 内容生成 SHA-256 key，命中时返回 `x-pdf-cache: HIT`，`?refresh=1` 强制重渲染并覆盖。底层对象存储支持 `local` / `s3`：`STORAGE_DRIVER=local`（默认，写 `PDF_CACHE_DIR`，30 天 TTL）或 `s3`（MinIO/S3，配置 `S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/PREFIX`，生命周期规则负责过期）。`GET /api/system/storage`（平台管理员）可查看当前驱动。本地可用 `npm run drill:s3` 启动 `s3rver` 做真实 PUT/GET/DELETE 与 API/worker 跨进程缓存验证。

PDF 异步任务：`pdf_jobs` 表作为 PostgreSQL 队列，worker 通过 `FOR UPDATE SKIP LOCKED` + 租约认领任务，支持多实例；任务记录 `locked_by/locked_at/attempts`。API 默认内联跑 worker（`PDF_WORKER_INLINE`），生产建议设 `false` 并独立启动 `npm run worker:pdf`。`PDF_JOB_LEASE_MINUTES` 控制失联任务回收。前端创建任务后轮询，完成后下载；同步导出接口仍保留。Compose 提供 `migrate` 一次性迁移服务、`pdf-worker`、Redis 与 nginx 多副本网关；K8s 清单见 `ops/k8s/`。

多副本演练：

- `npm run smoke:replicas`：2 API + nginx 故障切换 + 双 worker。
- `npm run soak:replicas`：持续压测、压测中故障、Redis 宕机回退、PDF 积压、连接池与指标校验。需本机有 `nginx` 与 `redis-server`。
- `npm run drill:rollout`：3 副本滚动发布/回滚、readiness 拦截坏版本、`x-app-version` 流量切换校验。需本机有 `nginx`。
- `npm run drill:alerts`：校验 `ops/alerts.yml` 的标签与 `ops/alertmanager.yml` 的路由/抑制（本地模拟）。

PDF 任务清理：`POST /api/pdf-jobs/cleanup`（`{ before, dry_run, confirm }`，执行需 `confirm=CLEANUP`，仅管理员/总监）或 CLI `npm run pdf:cleanup -- --days=30 --dry-run`；只删除任务行，不删除 PDF 文件缓存。`PDF_JOB_RETENTION_DAYS` 默认 30 天。

AI 助手默认走本地规则草稿（`rule-based-v1`），不发起外部请求。配置 `AI_BASE_URL` + `AI_API_KEY`（OpenAI 兼容 `/chat/completions`）后会在规则草稿基础上润色，模型名由 `AI_MODEL` 指定；调用失败自动回退 `fallback-rule-based-v1`，不会阻塞草稿生成。`GET /api/ai/config` 只返回是否配置与模型名，不返回密钥。
`db:reset` 会 `DROP SCHEMA public CASCADE`，**只用于本地开发库**。

## 已实现的规则（不是文档，是代码）

| 规则 | 落点 | 行为 |
|---|---|---|
| **R1** 无来源痛点不能关联机会点 | 触发器 `trg_opp_pain_source` | 抛异常；已归并痛点、跨项目关联同样拦截 |
| **R2** 无基线则 ROI 置信度锁 `low` | 触发器 `trg_roi_baseline_lock` | 静默降级，不报错 |
| **R3** 有技术阻断禁止进入 `designed` | 触发器 `trg_opportunity_rules` | 未指定 `blocker_owner` 时抛异常 |
| **R4** 终止必须写原因 | CHECK `kill_requires_reason` | `stage='killed'` 且原因为空直接拒绝 |
| **P1** 收益形态全有或全无 | CHECK `realization_all_or_nothing` | 形态、系数、署名、≥10 字理由必须同时存在 |
| **P2** 分位边界 | `benchmark_position()` / `positionOf()` | 落后那条边界归落后，其余归优（含 p50） |
| **P3** 门禁缺口分级 | `ratio_level()` / `ratioLevel()` | ≥1.0 pass，0.5–1.0 warn，<0.5 block |
| **P4** 传导链 | `chain_product()` / `chainProduct()` | 逐段连乘；派生变量（stage≥90）不参与 |
| **P5** 局限分流 | `limitations.impact_class` + 模板 | amount 紧跟 ROI、scope 紧跟痛点、method 附录、internal 丢弃 |

数据库层和 TypeScript 层各实现了一遍分位与连乘：**SQL 供查询，TS 供渲染，C12 校验两者相等**。

## 14 项一致性校验（R5）

`src/rules/consistency.ts` → `runChecks(bundle)`。

| 编号 | 检查 | 级别 | 样例结果 |
|---|---|---|---|
| C1 | 进入方案设计的机会点有基线 | block | ✅ 4/4 |
| C2 | 汇总数 = 明细之和（容差 0） | block | ✅ 72.4 = 72.4 |
| C3 | 门禁状态与 checklist 一致 | block | ✅ |
| C4 | 痛点数达到门禁要求 | 动态 | ⚠️ 8/10 = 0.80 |
| C5 | killed/parked 不进推荐路线 | block | ✅ |
| C6 | low 置信度基线进入局限 | block | ✅ 1 条 |
| C7 | benchmark 存在且未过期 | warn | ⚠️ 未校准 |
| C8 | requires 依赖无环 | block | ✅ |
| C9 | template_id 存在 | block | ✅ v2.2.0 |
| C10 | 收益形态已选定并署名 | block | ✅ 4/4 |
| C11 | 门禁量化项缺口分级 | 动态 | ⚠️ 2 项 warn |
| C12 | 链条乘积 = realization_factor | block | ✅ 0.5985 = 0.5985 |
| C13 | internal 局限不进客户文档 | block | ✅ 3 条剔除 |
| C14 | amount 局限紧跟对应 ROI | block | ✅ 2 条 |

样例期望：**11 pass / 3 warn / 0 block** → 允许生成。
把 G1 状态改成 `passed` 而 checklist 仍有失败项，C3 会立刻变 block，生成接口返回 **422**，不写 `deliverables`。

## 报告结构（章节号动态生成）

模板不再写死章节号，而是按「本次实际出现的章节」连续编号，避免数据缺失时出现 `0 → 1 → 5` 这类断号。

| 章节 | 数据来源 | 说明 |
|---|---|---|
| 0 结论摘要 | 组合测算 | 核心组合、全部实施、回本口径 |
| 1 诊断范围与方法 | 访谈 / 盘点 / 基线 / 流程 / 基准 | 场次、抽样数、方法边界 |
| 2 行业定位 | `benchmarks` + 客户值 | 分位边界与「怎么读」 |
| 3 业务现状 | `process_nodes` / `process_edges` | 业务链条（树状）、关键环节量化、隐性环节 |
| 4 四维诊断 | `inventory_items` | 业务 / 数据 / 系统 / 组织，逐项完整度与核实状态 |
| 5 痛点清单 | `pain_points` | 范围类局限紧跟其后 |
| 6 机会地图 | `opportunities` | V × F × U、阻断、路线 |
| 7 ROI 测算 | `roi_models` / `roi_sensitivity` | 汇总、组合、每张卡独立编号（7.3、7.4…），金额类局限各自编号 |
| 8 依赖与路线 | `opportunity_dependencies` | Mermaid 依赖图 + 依赖明细 + 推荐路线 |
| 9 风险与阻断 | `risks` + 机会点字段 | 显式风险带概率/影响；技术阻断、数据不可得、低置信度基线自动识别 |
| 10 方法与口径 | `limitations(impact_class=method)` | 附录性质 |

`one_pager` 是独立的一页纸模板（结论、建议先做、待拍板、不确定性、下一步），不会再把完整诊断报告原样返回。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 连通性 + 表数量 |
| GET | `/api/engagements` | 项目列表（含机会点/痛点/交付物计数） |
| GET | `/api/engagements/:id` | 项目详情：机会点 + ROI 摘要 + 门禁 + 局限分类 |
| GET | `/api/engagements/:id/consistency-checks` | 跑 14 项校验，返回 pass/warn/block |
| GET | `/api/engagements/:id/preview` | 渲染报告；`?format=markdown`（默认，`text/markdown`）或 `json` |
| POST | `/api/deliverables/generate` | 生成交付物；支持 `diagnosis_report` / `one_pager`，其余类型 → **400**；有 block → **422**，成功 → **201** |
| GET | `/api/deliverables/:id` | 交付物内容 + 生成快照 + 外发记录 |
| GET | `/api/deliverables/:id/markdown` | 直接取 Markdown 正文 |
| GET | `/api/deliverables/:id/checks` | 该次生成留下的 14 条审计记录 |
| GET | `/api/opportunities/:id/roi` | ROI 卡 + 传导链 + 单段恶化 + 阈值警告 |
| GET | `/api/benchmarks/position?metric=&value=` | 单指标分位定位（含边界规则） |
| GET | `/api/benchmarks` | 物流行业 20 项基准 |
| GET | `/api/openapi.json` | OpenAPI 规范（当前按路径/标签生成，请求体 Schema 逐步补） |
| GET | `/docs` | Swagger UI |
| POST | `/api/auth/login` | 邮箱 + 密码登录，返回 8 小时 token |
| GET | `/api/me` | 当前用户 / 组织 / 角色 |

### curl 示例

```bash
EID=$(psql -h 127.0.0.1 -d ai_delivery -tAc "select id from engagements limit 1")

curl -s http://127.0.0.1:8788/api/engagements/$EID/consistency-checks | jq '.summary'
# { "pass": 11, "warn": 3, "block": 0 }

curl -s http://127.0.0.1:8788/api/engagements/$EID/preview | head

curl -s -X POST http://127.0.0.1:8788/api/deliverables/generate \
  -H 'content-type: application/json' \
  -d "{\"engagementId\":\"$EID\",\"type\":\"diagnosis_report\"}"
```

## S1 写接口（录入闭环）

所有写接口使用 JSON，字段名与数据库列保持一致（snake_case）。错误语义已统一：

| HTTP | error | 场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod 校验失败，`issues[]` 给出字段路径 |
| 400 | `INVALID_INPUT` / `MISSING_FIELD` | UUID/日期格式错误、必填列缺失 |
| 409 | `CONFLICT` | 编号、依赖、财务快照等唯一键冲突 |
| 422 | `RULE_VIOLATION` | R1/R3、P1、门禁 passed 但 checklist 未全通过等规则违反 |
| 422 | `REFERENCE_NOT_FOUND` | 外键指向不存在的记录 |

| 实体 | 接口 |
|---|---|
| 客户 | `GET/POST /api/clients`、`PATCH /api/clients/:id`、`GET/POST /api/clients/:id/financials` |
| 项目 | `POST /api/engagements`、`PATCH /api/engagements/:id`；新建时自动初始化 G0–G5 与 G1 标准清单 |
| 门禁 | `GET /api/engagements/:id/gates`、`PUT .../gates/:code`、`POST .../gates/refresh` |
| 干系人 | `GET/POST /api/engagements/:id/stakeholders`、`PATCH /api/stakeholders/:id` |
| 访谈 | `GET/POST /api/engagements/:id/interviews`、`PATCH /api/interviews/:id` |
| 痛点 | `GET/POST /api/engagements/:id/pain-points`、`PATCH /api/pain-points/:id`；编号自动 `P-001` |
| 盘点 | `GET/POST /api/engagements/:id/inventory`、`POST .../inventory/bulk`、`PATCH /api/inventory/:id` |
| 流程 | `GET/PUT /api/engagements/:id/process-model`；节点按 `key` 或下标连线 |
| 机会点 | `GET/POST /api/engagements/:id/opportunities`、`GET/PATCH /api/opportunities/:id`、`PUT .../pain-points`；编号自动 `OP-01` |
| 基线 | `POST /api/opportunities/:id/baselines`、`PATCH/DELETE /api/baselines/:id` |
| ROI | `PUT /api/opportunities/:id/roi`、`PUT .../chain`、`POST .../roi/confirm` |
| 局限 | `GET/POST /api/engagements/:id/limitations`、`PATCH/DELETE /api/limitations/:id` |
| 依赖 | `GET/POST /api/engagements/:id/dependencies`、`DELETE /api/dependencies/:id` |
| 风险 | `GET/POST /api/engagements/:id/risks`、`PATCH/DELETE /api/risks/:id` |
| 交付物 | `GET /api/engagements/:id/deliverables`、`PATCH /api/deliverables/:id/status`、`GET /api/engagements/:id/shares` |
| 导出 | `GET /api/deliverables/:id/export.docx`、`GET /api/deliverables/:id/export.pdf`、`GET /api/deliverables/:id/export.html?print=1` |
| PDF 任务 | `POST /api/deliverables/:id/pdf-jobs`、`GET /api/deliverables/:id/pdf-jobs`、`GET /api/pdf-jobs/:id`、`GET /api/pdf-jobs/:id/file` |
| 导入 | `POST /api/engagements/:id/import?kind=pains`（也支持 `inventory`、`opportunities`，multipart `file`）、`GET /api/import/schema/:kind`、`GET /api/import/templates/:kind.csv` |
| 外发 | `POST /api/deliverables/:id/shares`、`DELETE /api/shares/:id`、`POST /api/shares/:id/rotate`、`POST /api/shares/:id/revoke`；外发前必须 `approved`，成功后状态变 `shared` |
| 只读分享 | `GET /api/public/shares/:token`、`GET .../export.docx`、`GET .../export.pdf`；token 访问、有效期、访问计数、撤销/轮换 |
| 分享访问 | `GET /api/shares/:id/views`；记录浏览/Word/PDF、IP、User-Agent、Referer；`POST /api/share-views/archive` 按组织+保留期归档 |
| 分享归档 | `GET /api/share-views/archive`（分页/过滤）、`GET /api/share-views/archive/export.csv`；仅管理员/总监 |
| 客户确认 | `GET/POST /api/engagements/:id/confirmations`、`DELETE /api/confirmations/:id`；对象/确认人必须属于该项目 |
| S2 方案 | `GET/POST /api/opportunities/:id/solutions`、`GET/PATCH/DELETE /api/solutions/:id`；方案负责人；组件/集成/工作量/验收/评审；前端支持两个方案版本对比（概要/组件/集成/验收/工作量）并导出 Markdown/CSV/Word；Word 汇总报价并支持 `audience=customer` 客户版脱敏 |
| S2 报价 | `GET/POST /api/engagements/:id/quotes`、`GET/PATCH/DELETE /api/quotes/:id`、报价行 CRUD |
| S2 文档 | `POST /api/solutions/:id/documents`、`GET /api/solutions/:id/document(.docx)`、`GET /api/solutions/:id/compare/:otherId/document(.docx)`、`POST /api/quotes/:id/documents`、`GET /api/quotes/:id/document.docx` |
| G2 门禁 | `GET /api/engagements/:id/g2-checks`（12 项：覆盖 / 范围 / 组件 / 验收 / 工作量 / 报价 / 关联 / 阻断 / 评审 / 报价覆盖成本 / 方案负责人 / 组件与人天一致性） |
| S3 POC | `GET/POST /api/opportunities/:id/poc-experiments`、实验详情/样本/运行/复核/结论 CRUD |
| S3 报告 | `POST /api/poc-experiments/:id/documents`、`GET .../document`、`GET .../document.docx` |
| G3 门禁 | `GET /api/engagements/:id/g3-checks`（8 项：覆盖 / 设计 / 样本 / 运行 / 复核 / 结论 / 决策 / 后续条件） |
| S4 交付 | `GET /api/engagements/:id/delivery-overview`、实施计划/任务、UAT、上线检查、培训、问题/变更 CRUD |
| G4 门禁 | `GET /api/engagements/:id/g4-checks`（11 项：计划 / 任务 / 里程碑 / UAT 覆盖 / UAT 通过 / 上线检查 / 培训 / P0P1 / 变更 / 逾期 / 客户签收） |
| S4 文档 | `POST /api/engagements/:id/delivery-documents`、`GET .../delivery-document(.docx)?type=plan\|uat\|go_live\|training` |
| S5 运营 | `GET /api/engagements/:id/value-overview`、指标目标/快照、价值记录、使用数据、续约风险 CRUD |
| G5 门禁 | `GET /api/engagements/:id/g5-checks`（9 项：目标 / 完整性 / 快照 / 来源 / 价值覆盖 / 证据 / 差异 / 使用 / 续约） |
| 指标字典 | `GET/POST /api/metric-definitions`、`PATCH/DELETE /api/metric-definitions/:id` |
| 分享页 | 客户无需登录，通过 token 只读查看/下载已批准交付物；默认 30 天有效，可撤销/轮换 |
| S5 文档 | `POST /api/engagements/:id/value-documents`、`GET .../value-document(.docx)?type=value\|renewal` |
| R6 知识库 | `GET/POST /api/knowledge`（q/industry/category/tag/status/expiring/expired）、`GET/PATCH/DELETE /api/knowledge/:id`、`POST /api/knowledge/:id/review`、`GET /api/engagements/:id/similar-knowledge` |
| R6 AI 草稿 | `GET/POST /api/engagements/:id/ai-drafts`、`PATCH/DELETE /api/ai-drafts/:id`、`POST .../confirm`、`POST .../reject`、`GET /api/ai/config`；默认 `rule-based-v1`，配置后可选大模型，必须人工确认 |
| 标杆维护 | `GET /api/benchmarks?all=1`、`POST /api/benchmarks`、`PATCH/DELETE /api/benchmarks/:id`；p25 ≤ p50 ≤ p75 |
| 回收站 | `GET /api/trash`、`POST /api/trash/:batch/restore`；客户/项目/交付物按批次恢复 |
| 审计 | `GET /api/audit-logs?limit=200&action=&object_type=&status=2xx|3xx|4xx|5xx&from=&to=`，返回 `stats`（total / deletes / failures）与选项 `facets`；所有写操作自动留痕 |
| 字典 | `GET /api/users`（返回 `role`） |

几个关键行为：

- **收益形态确认不接受手填系数**：`POST /roi/confirm` 会先算 `chain_product()`，再连同形态、理由、署名一起写入；链条段号不连续直接 422。
- **门禁量化项自动刷新**：录入痛点、盘点、访谈、基线、流程、一页纸后，G1 的 `actual` 由数据重算，不靠顾问手抄。
- **删除客户可级联清理**：修正了 `process_models.confirmed_by`、`deliverable_shares.shared_to` 等外键的 `ON DELETE` 行为，删客户不会再被历史确认记录挡住。

一条最小的录入顺序：

```bash
# 1 客户 → 2 项目（自动建门禁）
curl -s -X POST localhost:8788/api/clients -H 'content-type: application/json' \
  -d '{"name":"示例客户","annual_revenue":1000}'
curl -s -X POST localhost:8788/api/engagements -H 'content-type: application/json' \
  -d '{"client_id":"<CLIENT_ID>","name":"示例诊断"}'

# 3 痛点 / 盘点 / 流程 / 机会点 / 基线 / ROI / 传导链 / 确认
#    最后生成报告
curl -s -X POST localhost:8788/api/deliverables/generate -H 'content-type: application/json' \
  -d '{"engagementId":"<ENGAGEMENT_ID>","type":"diagnosis_report"}'
```

`npm run verify:write` 会把上面这条链路完整走一遍（含 R1/R3、门禁 422、并发生成），跑完删除测试客户。

## 数据模型

- `db/migrations/0001_s1_schema.sql`：30 张表。v1 的 21 张（含补齐的 `industry_templates`、`opportunity_pain_points`）+ v2.2 的 9 张（`benchmarks`、`client_financials`、`opportunity_dependencies`、`roi_sensitivity`、`process_models`、`process_nodes`、`process_edges`、`limitations`、`consistency_checks`）。
- `db/migrations/0002_s1_functions.sql`：分位、连乘、R1–R4 触发器、视图。
- `db/migrations/0003_r1_auth.sql`：登录字段与索引。
- `db/migrations/0004_r1_trash_audit.sql`：软删除字段、回收站批次、`audit_logs`。
- `db/migrations/0005_s2_solutions.sql`：S2 方案、组件、集成、工作量、验收、评审、报价 8 张表。
- `db/migrations/0006_s2_deliverable_types.sql`：交付物类型新增 `quote` / `acceptance`。
- `db/migrations/0007_s3_poc.sql`：POC 实验、样本、运行、复核、结论 5 张表。
- `db/migrations/0008_s4_delivery.sql`：实施计划、任务、UAT、上线检查、培训、问题/变更 6 张表。
- `db/migrations/0009_s4_deliverable_types.sql`：交付物类型新增 `delivery_plan` / `go_live_checklist` / `training_materials`。
- `db/migrations/0010_s5_value.sql`：指标字典、目标、快照、价值记录、使用数据、续约风险 6 张表。
- `db/migrations/0011_s5_deliverable_types.sql`：交付物类型新增 `renewal_recommendation`。
- `db/migrations/0012_r6_knowledge_ai.sql`：知识条目、AI 草稿 2 张表。
- `db/migrations/0013_r6_knowledge_review.sql`：知识有效期、审批人/时间/意见。
- `db/migrations/0014_request_id.sql`：审计日志新增 `request_id` 与索引。
- `db/migrations/0015_perf_indexes.sql`：项目列表、痛点、机会点、交付物、访谈、知识库常用查询索引。
- `db/migrations/0016_engagement_members.sql`：项目成员与角色（manager/member/viewer）。
- `db/migrations/0017_audit_archive.sql`：审计归档表 `audit_logs_archive` 与索引。
- `db/migrations/0018_pdf_jobs.sql`：PDF 异步任务表 `pdf_jobs`。
- `db/migrations/0019_share_tokens.sql`：外发记录新增分享 token、有效期、撤销与访问计数。
- `db/migrations/0020_share_views.sql`：分享访问明细 `share_views`。
- `db/migrations/0021_share_views_archive.sql`：分享访问归档表 `share_views_archive`。
- `db/migrations/0022_share_views_archive_org.sql`：归档表补充 `org_id` 并回填。
- `db/migrations/0023_user_sessions.sql`：可撤销登录会话 `user_sessions`。
- `db/migrations/0024_password_history.sql`：最近 5 次密码历史 `password_history`。
- `db/migrations/0026_tenant_foundation.sql`：供应商租户 `slug/status/settings`。
- `db/migrations/0027_org_slug_default.sql`：组织 slug 默认值（兼容脚本/测试插入）。
- `db/migrations/0028_platform_admin.sql`：平台管理员标记 `users.is_platform_admin`。
- `db/migrations/0029_rls.sql`：RLS 角色、策略、租户上下文函数。
- `db/migrations/0030_pdf_job_lease.sql`：PDF 任务 worker 租约字段与队列索引。
- `db/migrations/0031_tenant_billing.sql`：租户试用到期、账单邮箱、套餐目录 `tenant_plans`。
- `db/migrations/0032_tenant_plan_trial.sql`：套餐枚举新增 `trial`。
- `db/migrations/0033_tenant_invoices.sql`：订阅周期、自动续费、账单 `tenant_invoices`。
- `db/migrations/0034_copilot_reconcile_reviews.sql`：ai-copilot 对账复核回写 `copilot_reconcile_reviews`。
- `db/migrations/0035_copilot_reconcile_action_links.sql`：复核记录关联风险/待办并防重复。
- `db/migrations/0036_copilot_reconcile_actions.sql`：按单条差异生成风险/待办的动作表。
- `db/migrations/0037_risk_owner_due.sql`：风险增加负责人与截止日期。
- `db/migrations/0038_holiday_calendar.sql`：组织级/平台级节假日日历，供工作日 SLA 使用。
- `db/migrations/0039_copilot_reconcile_batches.sql`：批量生成批次与逐条结果，支持历史查询和失败重试。
- `db/migrations/0040_batch_cancelled_status.sql`：批量任务增加 `cancelled` 状态。
- `db/migrations/0041_batch_cancel_resume.sql`：保存请求差异列表、取消原因/操作人/时间，支持取消后继续剩余差异。
- `db/migrations/0042_batch_filter_views.sql`：用户级命名筛选视图 `copilot_batch_filter_views`。
- `db/migrations/0043_batch_filter_view_sharing.sql`：筛选视图增加 `shared`，支持共享给同组织同事。
- `db/migrations/0044_batch_filter_view_targeted_sharing.sql`：筛选视图支持 `shared_role` 与指定用户共享表。
- `db/migrations/0045_user_notifications.sql`：站内通知 `user_notifications`。
- `db/migrations/0046_notification_trash.sql`：通知软删除字段 `deleted_at` 与回收站索引。
- `db/migrations/0047_collab_audit_snapshots.sql`：按组织的协作审计每日快照。
- `db/migrations/0048_collab_snapshot_decisions.sql`：快照增加差异决策计数 `decision_count`。
- 容器化与备份恢复见根目录 [DEPLOY.md](../DEPLOY.md)。
- `db/003_seed.sql`：宏远样例（仅在 `db:seed` / `db:reset` 时执行）。
- `db/legacy/`：迁移体系引入前的原始 SQL，仅作对照。
- `schema_migrations` 记录已执行迁移与 checksum；历史迁移不允许修改，变更走新文件。

**全新库演练（历史记录，2026-11-04）**：新建空库执行 54 个迁移得到 82 张表、78 张启用 RLS，`db:seed` 正常；`verify:write` 51/51、`verify:report` 11/11、`verify`（规则）17/17，验证从零建库到种子与回归全链路可用。
- 金额单位统一 **万元**；`realized_value` 保留 1 位小数（1 千元精度），与报告口径一致。
- 回本用生成列计算，两种口径并存：`payback_months`（不含运维）、`payback_months_with_ops`（含运维）。
- 生成列不能引用生成列，所以 `realized_value` 内联了 `neutral_value × realization_factor` 的表达式，而不是引用另一个生成列。

## 样例数据口径

| 组合 | 可实现收益 | 投入 | 年运维 | 回本 | 含运维 |
|---|---|---|---|---|---|
| 只做 OP-01 | 17.4 万 | 40 万 | 6 万 | 27.6 个月 | 42.1 个月 |
| 一期 OP-01+03 | 26.4 万 | 52 万 | 8 万 | 23.6 个月 | 33.9 个月 |
| **核心 OP-01+02+03** | **62.4 万** | **77 万** | **13 万** | **14.8 个月** | **18.7 个月** |
| 全部一期+二期 | 72.4 万 | 92 万 | 16 万 | 15.2 个月 | 19.6 个月 |

OP-01 传导链：`1.00 × 0.95 × 0.70 × 0.90 = 0.5985`，`29 × 0.5985 = 17.36 → 17.4 万`。
单段恶化：渠道 −7.0 万、采用率 −7.0 万、准确率 −1.9 万、价值转化 −5.8 万。
准确率是**阈值型变量**：跌到 90% 以下全量复核、收益归零——单段恶化表里的 1.9 万只是线性近似。

## 已知边界

- 只覆盖 S1 诊断阶段；S2 之后的状态机字段已建表，但没有对应接口。
- 交付物目前只实现 `diagnosis_report` 与 `one_pager` 两个渲染器；`roadmap`、`roi_sheet`、`prd` 等类型虽然数据库允许，接口会明确返回 400，避免返回类型对不上的文档。
- 行业对标的 20 项 p25/p50/p75 是示意值（`calibrated=false`），正式使用前需 ≥20 个真实项目校准。
- 登录与组织隔离已生效（`org_id` 单资源归属 + 列表过滤）；客户侧只读视图、更细的角色权限仍待补。默认 `AUTH_REQUIRED=false` 便于本地开发。
- 组织隔离目前在应用层实现，数据库层未启用 RLS；直接连库仍可跨组织读取。生产多租户建议补 RLS 或独立 schema。
- `zod` 已升级到 4.6；`npm audit` 仍有 11 个 moderate（exceljs → uuid、swagger-ui → glob），当前无非破坏性修复，已评估为低风险。
- OpenAPI 目前提供路径、方法、标签导航，请求/响应体 JSON Schema 尚未覆盖全部路由。
- 客户/项目/交付物为软删除，可在回收站按批次恢复；痛点、盘点、机会点等子资源仍是物理删除，但所有写操作都会进 `audit_logs`。
- 访谈纪要为手打文本，不做录音转写（已确认的产品边界）。
- 报告 §3 的业务链条由 `process_nodes/process_edges` 自动排版；节点颗粒度仍是人工决定（与样例 §3 的判断边界一致）。
