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
```

示例配置：

- [`ops/prometheus.scrape.example.yml`](../ops/prometheus.scrape.example.yml)
- [`ops/alerts.yml`](../ops/alerts.yml)
- [`ops/grafana-dashboard.json`](../ops/grafana-dashboard.json)（导入 Grafana，选择 Prometheus 数据源）

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

### 4.3 PDF 导出失败

- 错误 `PDF_ENGINE_UNAVAILABLE`：当前环境没有 Chromium，设置 `PDF_CHROME_PATH` 或使用 Docker 镜像（已内置 chromium + fonts-noto-cjk）。
- 任务 `failed`：`GET /api/pdf-jobs/:id` 查看 `error`；常见为浏览器崩溃、超时、字体缺失。
- 同步接口 `500 PDF_RENDER_FAILED`：看后端日志 `pdf render failed` 与 requestId。
- 缓存 `410`：PDF 文件已按 TTL 清理，重新生成即可。

### 4.4 403 项目访问

- `PROJECT_FORBIDDEN`：项目已配置成员，当前用户不在成员名单。
- `PROJECT_READONLY`：只读成员执行了写操作。
- `FORBIDDEN`：组织角色不足（如顾问改标杆、看审计归档）。
- 处理：项目负责人在「成员」页添加/调整角色，或由管理员/总监操作。

### 4.5 磁盘增长

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

### 4.6 登录 429

- 默认 5 次失败 / 15 分钟（`LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MS`），按 IP + 邮箱计数。
- 超限返回 429 `LOGIN_RATE_LIMITED`；限流期间正确密码也会被拦截，等待窗口结束即可。
- 反向代理后需设置 `TRUST_PROXY=true`，否则所有用户可能共享网关 IP 的计数。
- 进程重启会清空计数；多实例部署需网关/Redis 级别的统一下限流。

### 4.7 分享 429

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

### 4.9 用户与账号

- 管理员/总监在「用户管理」页创建账号、调整角色、禁用、重置密码。
- 禁用或重置密码会立即撤销该用户全部会话。
- 组织至少保留一名启用的管理员；不能禁用当前登录账号。
- 审计日志记录创建/修改/重置动作，可用 `action` 或对象类型检索。

### 4.10 指标 401

- 设置了 `METRICS_TOKEN`，Prometheus 未带 Bearer 或 `?token=`。
- 不要把 `/metrics` 裸暴露公网；只允许监控网段访问。

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

- [ ] 从备份恢复到一个空库，/api/health 正常
- [ ] 停掉数据库，确认 `/metrics` 的 `db_up=0` 与告警触发
- [ ] 制造一次 5xx，确认错误体带 requestId，日志/审计可检索
- [ ] 移除项目成员，确认 403 与列表过滤
- [ ] 关闭 Chromium，确认 PDF 任务 failed 且 Word 仍可用
- [ ] 执行 `audit:archive --dry-run` 与 `pdf:cleanup --dry-run`
