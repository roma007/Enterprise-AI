# 运维手册

> 适用：单机 Docker Compose / 本地 Node 部署。
> 目标：出现问题时能快速定位；日常能按计划备份、归档、清理与扩容。

---

## 1. 服务与端点

| 端点 | 用途 |
|---|---|
| `GET /api/health` | 存活 + 数据库连通 + 表/迁移数量 |
| `GET /metrics` | Prometheus 指标（可选 `METRICS_TOKEN`） |
| `GET /docs` | Swagger 调试 |
| `GET /api/openapi.json` | OpenAPI 文档 |

```bash
curl -fsS http://127.0.0.1:8788/api/health
curl -fsS http://127.0.0.1:8788/metrics | head
```

服务日志为 JSON 行，关键字段：

- `requestId`：与响应头 `x-request-id`、错误体 `requestId`、`audit_logs.request_id` 同源。
- `event=request_completed`：请求方法、路由模板、状态码、耗时、org/user。
- `event=slow_request`：超过 `SLOW_REQUEST_MS`（默认 500ms）。
- 日志已脱敏 `authorization` / `cookie` / `set-cookie`。

定位一次请求：

```bash
# 1. 从响应头/错误体拿到 requestId
# 2. 搜后端日志
docker compose logs backend | grep '<requestId>'
# 3. 搜审计日志
psql "$DATABASE_URL" -c "select action,status_code,created_at from audit_logs where request_id='<requestId>'"
```

---

## 2. 指标

`GET /metrics` 暴露：

| 指标 | 含义 |
|---|---|
| `http_requests_total{method,route,status}` | 请求量（按路由模板 + 状态码） |
| `http_request_duration_ms_bucket` | 全局耗时直方图 |
| `slow_requests_total` | 慢请求累计 |
| `process_uptime_seconds` | 进程运行时长 |
| `db_up` | `SELECT 1` 探活 |
| `db_pool_total_connections` / `db_pool_idle_connections` | 连接池使用中 / 空闲 |
| `db_pool_waiting_requests` / `db_pool_max_connections` | 等待连接的请求 / 单进程池上限 |
| `redis_configured` / `redis_up` | 是否配置 Redis / PING 健康 |
| `pdf_jobs_pending` / `pdf_jobs_running` | PDF 队列待处理 / 渲染中 |
| `pdf_jobs_done_24h` / `pdf_jobs_failed_24h` | 24 小时内完成 / 失败任务 |
| `pdf_jobs_oldest_pending_seconds` | 最老待处理任务等待秒数 |
| `pdf_cache_hits_total` / `pdf_cache_misses_total` | PDF 缓存命中 / 未命中（进程内） |
| `audit_export_jobs_pending` / `audit_export_jobs_running` | 审计导出排队 / 生成中 |
| `audit_export_jobs_done_24h` / `audit_export_jobs_failed_24h` | 24 小时内完成 / 失败导出任务 |
| `audit_export_jobs_oldest_pending_seconds` | 最老待处理导出任务等待秒数 |
| `ai_delivery_backup_last_success_timestamp_seconds` | 最近一次备份成功时间（node_exporter textfile） |
| `ai_delivery_restore_drill_last_success_timestamp_seconds` | 最近一次恢复演练成功时间（textfile） |

常用 PromQL：

```promql
# 5xx 比例
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m]))

# p95 延迟
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_ms_bucket[5m])))

# 慢请求速率
rate(slow_requests_total[5m])

# 各路由请求量 Top
topk(10, sum by (route) (rate(http_requests_total[5m])))

# PDF 24h 失败率
sum(pdf_jobs_failed_24h)
/
clamp_min(sum(pdf_jobs_done_24h) + sum(pdf_jobs_failed_24h), 1)

# 数据库连接池使用率
sum(db_pool_total_connections)
/
clamp_min(sum(db_pool_max_connections), 1)
```

示例配置：

- [`ops/prometheus.scrape.example.yml`](../ops/prometheus.scrape.example.yml)
- [`ops/alerts.yml`](../ops/alerts.yml)
- [`ops/grafana-dashboard.json`](../ops/grafana-dashboard.json)（导入 Grafana，选择 Prometheus 数据源）
- [`ops/slo.md`](../ops/slo.md)（SLO、错误预算、告警路由与值班 Runbook）

设置 `METRICS_TOKEN` 后，Prometheus 需带 Bearer：

```yaml
scrape_configs:
  - job_name: ai-delivery-backend
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/ai-delivery-metrics-token
    static_configs:
      - targets: ['backend:8788']
```

> `/metrics` 抓取本身不计入指标，避免自增噪音。

---

## 3. 定时任务

建议全部由宿主机 cron 执行，日志追加到 `/var/log/ai-delivery/`。

```cron
# 每天 02:00 备份数据库
0 2 * * * cd /opt/ai-delivery && ./scripts/backup.sh >> /var/log/ai-delivery/backup.log 2>&1

# 每天 02:30 归档 180 天前的审计日志（先 dry-run 确认）
30 2 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run audit:archive -- --days=180 --dry-run >> /var/log/ai-delivery/audit-archive-dry.log 2>&1

# 每天 02:40 实际归档
40 2 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run audit:archive -- --days=180 >> /var/log/ai-delivery/audit-archive.log 2>&1

# 每天 03:00 清理 30 天前的 PDF 任务记录
0 3 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run pdf:cleanup -- --days=30 >> /var/log/ai-delivery/pdf-cleanup.log 2>&1

# 每天 03:10 归档 180 天前的客户分享访问明细
10 3 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run share:archive -- --days=180 >> /var/log/ai-delivery/share-archive.log 2>&1

# 每天 03:20 账单任务：逾期标记 + 自动续费账单（不会自动扣款）
20 3 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run billing:run >> /var/log/ai-delivery/billing.log 2>&1

# 每天 03:20 清理 30 天前的已过期/已撤销登录会话
20 3 * * * cd /opt/ai-delivery && docker compose exec -T backend npm run sessions:cleanup -- --days=30 >> /var/log/ai-delivery/sessions-cleanup.log 2>&1
```

本地 Node 部署把 `docker compose exec -T backend` 换成 `cd backend &&`。

### 数据保留

| 数据 | 默认策略 | 控制项 |
|---|---|---|
| 业务表 | 永久 | 软删除客户/项目/交付物进回收站 |
| 审计热表 `audit_logs` | 180 天 | `AUDIT_RETENTION_DAYS` + 归档 cron |
| 审计归档表 | 手工清理/导出 | 无自动删除 |
| PDF 文件缓存 | 30 天 | `PDF_CACHE_TTL_DAYS` |
| PDF 任务 `pdf_jobs` | 30 天 | `PDF_JOB_RETENTION_DAYS` + 清理 cron |
| 审计导出任务与文件 | 7 天 | `AUDIT_EXPORT_RETENTION_DAYS` + 常驻清理（`AUDIT_EXPORT_CLEANUP_INTERVAL_SECONDS`） |
| 分享访问 `share_views` | 180 天热数据 | `SHARE_VIEW_RETENTION_DAYS` + 归档 cron；归档表手工清理 |
| 登录会话 `user_sessions` | 30 天（仅过期/撤销） | `USER_SESSION_RETENTION_DAYS` + 清理 cron |
| 数据库备份 | 按 cron + 人工异地 | `scripts/backup.sh` |

---

## 4. 故障处置

### 4.1 后端不可用

1. `docker compose ps` / `docker compose logs backend`
2. `curl -fsS http://127.0.0.1:8788/api/health`
3. 健康检查失败先看数据库：`docker compose logs db`、`pg_isready`
4. 迁移失败：确认未修改历史迁移 checksum，新增迁移重试
5. 回滚：恢复上一个数据库备份 + 上一版镜像

### 4.2 `db_up 0`

- 检查 PostgreSQL 容器/连接串、最大连接数。
- `SELECT count(*) FROM pg_stat_activity;` 是否打满。
- 恢复后确认 `/api/health` 的 `tables/migrations` 正常。

### 4.3 PDF 队列与 worker

- API 默认内联 worker；生产建议 `PDF_WORKER_INLINE=false`，单独运行一个或多个 `npm run worker:pdf` / `pdf-worker` 容器。
- 任务通过 `pdf_jobs` + `FOR UPDATE SKIP LOCKED` 认领，多实例不会重复处理。
- 失败/失联任务：`PDF_JOB_LEASE_MINUTES`（默认 15）后可被重新认领；`attempts` 记录次数。
- 查看队列：`select status,count(*) from pdf_jobs group by status;`
- 共享 PDF 缓存：本地需同一 `PDF_CACHE_DIR`；容器使用 `pdfcache` 卷。多主机部署应换 S3/MinIO。

### 4.4 对象存储 / S3

- `GET /api/system/storage`（平台管理员）查看当前驱动与目标。
- 本地默认写 `PDF_CACHE_DIR`；多主机/容器必须切 S3/MinIO，否则 API 与 worker 读不到同一份缓存。
- MinIO 示例：
  ```bash
  docker compose --profile s3 up -d minio
  # .env
  STORAGE_DRIVER=s3
  S3_ENDPOINT=http://minio:9000
  S3_BUCKET=ai-delivery
  S3_ACCESS_KEY_ID=minioadmin
  S3_SECRET_ACCESS_KEY=minioadmin
  ```
  首次需创建 bucket（MinIO Console 或 `mc mb`）。
- 生产建议为 bucket 配置 30 天生命周期，替代应用侧 TTL。
- 本地联调：`make drill-s3`（`s3rver` 本地 S3 兼容服务），验证 PUT/GET/DELETE、404、Content-Type、prefix、跨进程读取，以及 API + 2 个 worker 的 PDF 缓存读写。
- 2026-11-03 实测：2/2 PDF 任务完成，S3 缓存约 1.4MB，API 从 S3 读回内容一致。
- S3 兼容实现若对新版灵活校验和支持不完整，客户端已设置 `requestChecksumCalculation=WHEN_REQUIRED` / `responseChecksumValidation=WHEN_REQUIRED`。
- S3 不可用时 PDF 任务会失败；Word/HTML 导出不受影响。

### 4.5 PDF 导出失败

- 错误 `PDF_ENGINE_UNAVAILABLE`：当前环境没有 Chromium，设置 `PDF_CHROME_PATH` 或使用 Docker 镜像（已内置 chromium + fonts-noto-cjk）。
- 任务 `failed`：`GET /api/pdf-jobs/:id` 查看 `error`；常见为浏览器崩溃、超时、字体缺失。
- 同步接口 `500 PDF_RENDER_FAILED`：看后端日志 `pdf render failed` 与 requestId。
- 缓存 `410`：PDF 文件已按 TTL 清理，重新生成即可。

### 4.6 403 项目访问

- `PROJECT_FORBIDDEN`：项目已配置成员，当前用户不在成员名单。
- `PROJECT_READONLY`：只读成员执行了写操作。
- `FORBIDDEN`：组织角色不足（如顾问改标杆、看审计归档）。
- 处理：项目负责人在「成员」页添加/调整角色，或由管理员/总监操作。

### 4.7 磁盘增长

排查顺序：

```bash
docker system df
du -sh /var/lib/docker/volumes/* | sort -h
du -sh backend/.pdf-cache backups
```

- PDF 缓存：调小 `PDF_CACHE_TTL_DAYS` 或手工清理 `.pdf-cache`。
- 备份：保留最近 N 份，异地同步后删除旧备份。
- 审计归档：导出归档表后按合规要求清理。
- 容器日志：配置 Docker `log-opts` 轮转。

### 4.8 登录 429

- 默认 5 次失败 / 15 分钟（`LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MS`），按 IP + 邮箱计数。
- 超限返回 429 `LOGIN_RATE_LIMITED`；限流期间正确密码也会被拦截，等待窗口结束即可。
- 反向代理后需设置 `TRUST_PROXY=true`，否则所有用户可能共享网关 IP 的计数。
- 进程重启会清空计数；多实例部署需网关/Redis 级别的统一下限流。

### 4.9 分享 429

- 默认每 IP + token 60 次/分钟；调 `PUBLIC_SHARE_RATE_LIMIT` / `PUBLIC_SHARE_RATE_WINDOW_MS`。
- 反向代理后所有请求可能来自网关 IP：设置 `TRUST_PROXY=true`，并确保只信任自己的网关。
- 访问明细：`GET /api/shares/:id/views`，或报告页「记录 → 明细」查看浏览/Word/PDF、IP、UA、Referer。
- 访问明细按 `SHARE_VIEW_RETENTION_DAYS`（默认 180 天）由 cron 归档到 `share_views_archive`，可用 `--dry-run` 先预演。
- 查询/导出归档（管理员/总监）：
  ```bash
  curl -H "Authorization: Bearer <token>" "http://127.0.0.1:8788/api/share-views/archive?token=<token>&limit=100"
  curl -H "Authorization: Bearer <token>" -o share-archive.csv "http://127.0.0.1:8788/api/share-views/archive/export.csv?from=2026-01-01&to=2026-12-31"
  ```

### 4.8 会话与强制下线

- 用户可在「登录会话」页撤销其他设备或全部退出。
- 管理员/总监：
  ```bash
  curl -H "Authorization: Bearer <admin-token>" \
    http://127.0.0.1:8788/api/users/<user-id>/sessions
  curl -X POST -H "Authorization: Bearer <admin-token>" \
    http://127.0.0.1:8788/api/users/<user-id>/revoke-sessions
  ```
- 用户可在「登录会话 → 修改密码」自助改密；改密后保留当前设备，撤销其他会话。
- 撤销后 token 立即失效；前端下一次请求会收到 401 并跳回登录。
- 会话默认 8 小时过期；过期/撤销记录默认保留 30 天后由 cron 清理（活跃会话永不删除）。

### 4.10 Redis / 缓存

- 生产/多实例必须配置 `REDIS_URL`；未配置时登录限流与会话缓存回退进程内存，多副本之间不共享。
- `GET /api/system/cache` 查看驱动与 `PING` 健康状态。
- 会话缓存 TTL 30 秒；撤销、强制下线、暂停租户会删除对应缓存。
- Redis 不可用时限流回退内存、会话校验回退数据库；不会阻断业务，但多实例一致性下降。
- Redis 不持久化会话本身，会话真值仍在 PostgreSQL `user_sessions`。

### 4.11 租户隔离与 RLS

- 正常 API 请求使用受限角色 `ai_delivery_app`，数据库按 `app.org_id` 行级隔离；每个请求复用一条连接，结束后清理角色与上下文。
- 连接池上限 `PG_POOL_MAX` 默认 20；高并发需监控 `pg_stat_activity` 并调大。
- 验证当前请求上下文：`GET /api/system/db-context`。
- 直接使用数据库 owner 连接会绕过 RLS；只允许运维/迁移使用。
- 若报 `permission denied to set role "ai_delivery_app"`：由 DBA 创建角色并授权给应用连接用户，或临时设置 `DB_APP_ROLE=off`（仅限排障）。
- 登录、公开分享、健康检查使用服务角色，不参与 RLS 上下文。

### 4.12 用户与账号

- 管理员/总监在「用户管理」页创建账号、调整角色、禁用、重置密码。
- 禁用或重置密码会立即撤销该用户全部会话。
- 组织至少保留一名启用的管理员；不能禁用当前登录账号。
- 审计日志记录创建/修改/重置动作，可用 `action` 或对象类型检索。

### 4.13 多副本与发布

- Compose：`migrate` 一次性迁移 → backend 多副本 → nginx 网关；生产零停机建议使用 `ops/k8s/`。
- K8s 发布顺序：expand 迁移 → backend（maxUnavailable 0）→ worker → frontend → 观察指标 → 下一轮 contract 迁移。
- 多副本前提：Redis、S3/MinIO、外部/托管 PostgreSQL、`PDF_WORKER_INLINE=false`。
- 迁移 Job 先于 Deployment；禁止应用启动时并发迁移。
- 回滚：`kubectl rollout undo deployment/ai-delivery-backend`；数据库迁移保持 expand-contract。

**本地多副本演练**：

```bash
npm run smoke:replicas   # 快速冒烟：故障切换 + 双 worker
npm run soak:replicas    # 持续压测：QPS/P95 + 压测中故障 + Redis 宕机 + PDF 积压
cd backend && npm run drill:rollout   # 滚动发布/回滚：readiness → 切流 → 停旧副本
```

`soak:replicas` 会启动 2 个 API、nginx、独立 Redis（6391）和 2 个 PDF worker，验证：

- 持续并发下 P95 与失败率；连接池峰值不超过 `副本数 × PG_POOL_MAX`
- 压测中杀掉一个副本，nginx 自动切换且失败率 ≤ 2%
- 副本重启后恢复服务
- Redis 宕机后登录限流回退内存、会话校验回退数据库
- PDF 队列积压由双 worker 分担完成
- `/metrics` 的 `db_up`、请求量与耗时直方图

可调参数：`SOAK_CONCURRENCY`、`SOAK_DURATION_MS`、`SOAK_P95_LIMIT_MS`、`SOAK_PDF_JOBS`、`PG_POOL_MAX`。

`drill:rollout` 启动 3 个 API + nginx，先起新版本并通过 `/api/health` 版本校验，再切 nginx upstream，最后停旧副本；随后用数据库不可用的坏版本验证 readiness 拦截，再完整回滚。发布/回滚全过程持续压测，并校验 `x-app-version` 流量分布。

> 演练脚本会直接操作本地数据库并清理生成的测试交付物；生产环境请用独立环境或 K8s 预发集群。

### 4.14 备份、恢复与 PITR

- 每日备份：`make backup`；异地保存至少一份。
- 恢复：`make restore FILE=backups/xxx.dump`；恢复脚本会重建 RLS 应用角色权限。
- 逻辑恢复演练：`make drill-restore`（备份 → 临时库恢复 → 结构与 RLS 校验 → 清理）。
- PITR 演练：`make drill-pitr`（临时集群 + WAL 归档 → 时间点恢复 → 前后对照）。
- 生产 PITR：托管 PostgreSQL 开启自动备份 + PITR；自建需 `wal_level=replica`、`archive_mode=on`，WAL 与基础备份异地保存。
- 恢复演练不能只看“命令成功”，必须校验业务表行数、迁移版本、RLS 隔离与关键租户。
- 备份/演练心跳：设置 `PROM_TEXTFILE_DIR` 指向 node_exporter textfile 目录，`backup.sh` / `restore-drill.sh` 会写入 `.prom`，供 `BackupStale` / `RestoreDrillStale` 告警使用。
- SLO、错误预算与值班 Runbook：`ops/slo.md`。

### 4.15 告警值班演练

- 规则：`ops/alerts.yml`（17 条告警，均带 `severity` / `service` 标签）。
- 路由与抑制：`ops/alertmanager.yml`。
- 本地演练：`make drill-alerts` 或 `cd backend && npm run drill:alerts`。
- 校验内容：critical → `pager`、数据库 critical → `dba-oncall`、warning → `chat`、info → `weekly`；同服务 critical 抑制 warning；跨服务不误抑制。
- 生产还需：接入真实 Alertmanager webhook/电话，执行一次 **触发 → 认领 → 静默 → 升级 → 恢复** 演练，并记录响应时间。

### 4.16 指标 401

- 设置了 `METRICS_TOKEN`，Prometheus 未带 Bearer 或 `?token=`。
- 不要把 `/metrics` 裸暴露公网；只允许监控网段访问。

### 4.17 租户试用、配额与计费

- 套餐目录：`tenant_plans`（trial / free / pro / enterprise），含用户、客户、项目、本月 PDF 任务上限与月费/年费。
- 新注册租户自动 14 天试用；`trial_ends_at` 到期后登录返回 403 `TRIAL_EXPIRED`，现有会话失效。
- 配额检查：创建用户 / 客户 / 项目 / PDF 任务前执行；超限返回 403 `QUOTA_EXCEEDED`，`details` 含 `resource/limit/used/plan`。
- 租户查看：`GET /api/org/billing`（前端 `#/org`「套餐与用量」）。
- 平台管理：`GET /api/platform/plans`；`PATCH /api/platform/tenants/:id` 支持 `plan`、`trial_ends_at`、`billing_email`；前端 `#/tenants` 可调整套餐、延长试用。
- 支付模式：`PAYMENT_PROVIDER=mock`（本地模拟支付）/ `manual`（平台确认收款）/ `callback`（网关回调）。
- 账单状态：`pending` → `paid` / `void`；逾期 3 天自动标记 `overdue`。
- 租户自助：`POST /api/org/billing/checkout` 生成账单；`mock` 模式可调用 `/api/org/billing/invoices/:id/pay` 模拟支付。
- 平台确认：`GET /api/platform/invoices`、`POST /api/platform/invoices/:id/mark-paid`、`.../void`；前端 `#/tenants` 底部「最近账单」。
- 网关回调：`POST /api/billing/callback`，`x-billing-signature = HMAC-SHA256(invoice_id:status:external_id, BILLING_WEBHOOK_SECRET)`。
- 自动续费：`npm run billing:run`（`make billing-run`）生成续费账单并标记逾期；**不会自动扣款**。
- 订阅到期：付费套餐 `plan_expires_at` 过期后登录返回 403 `SUBSCRIPTION_EXPIRED`，现有会话失效。
- 当前**未接具体支付厂商 SDK、发票与自动扣费**；`price_monthly/yearly` 仅用于账单金额。

---

## 5. 发布与回滚

1. 备份：`make backup`
2. 拉取新代码/镜像
3. `docker compose up -d --build`
4. 等待 `/api/health` 正常；看 `/metrics` 错误率与慢请求
5. 冒烟：`cd frontend && npm run e2e`（本地/CI）
6. 失败回滚：恢复备份 + 切回上一版镜像

迁移原则：**历史迁移不可改**，变更只新增 `db/migrations/NNNN_*.sql`。

---

## 6. 安全清单

- [ ] `AUTH_REQUIRED=true`
- [ ] `AUTH_SECRET` 为随机长串
- [ ] `METRICS_TOKEN` 已设置且仅监控网段可访问
- [ ] 8788 不直接暴露公网，前置 TLS 网关
- [ ] `SEED_DEMO=false`
- [ ] 数据库每日备份 + 异地保存 + 恢复演练
- [ ] 客户数据出境/LLM 供应商条款已确认（默认不调用外部 LLM）
- [ ] 登录限流参数已按团队规模调整（默认 5 次/15 分钟）
- [ ] 演示管理员账号 `admin@hengzhi.ai` 已改密或移除
- [ ] 密码策略（≥10 位、3 类字符、最近 5 次不可复用）已向用户说明
- [ ] 审计归档与 PDF 清理 cron 已配置

---

## 7. 演练清单

- [x] 从备份恢复到一个空库，校验表/迁移/行数/RLS（`make drill-restore`）
- [x] PITR 时间点恢复与前后对照（`make drill-pitr`）
- [ ] 停掉数据库，确认 `/metrics` 的 `db_up=0` 与告警触发
- [ ] 制造一次 5xx，确认错误体带 requestId，日志/审计可检索
- [ ] 移除项目成员，确认 403 与列表过滤
- [ ] 关闭 Chromium，确认 PDF 任务 failed 且 Word 仍可用
- [ ] 执行 `audit:archive --dry-run` 与 `pdf:cleanup --dry-run`
