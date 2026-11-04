# SLO 与告警值班

> 目标：把“能监控”变成“可承诺、可值班、可复盘”。
> 指标由后端 `/metrics` 与可选 node_exporter textfile 提供；规则见 `ops/alerts.yml`。

## 1. 服务分级

| 级别 | 范围 | 故障影响 |
|---|---|---|
| P0 | 登录、项目/客户读写、交付物导出、数据库 | 客户无法使用 |
| P1 | PDF 异步任务、Redis、对象存储 | 部分功能降级 |
| P2 | 平台租户管理、审计归档、清理任务 | 运营效率下降 |

## 2. SLI / SLO

| SLI | PromQL / 指标 | SLO | 窗口 | 告警 |
|---|---|---|---|---|
| API 可用性 | `1 - slo:http_request_error_ratio:5m` | ≥ 99.9% | 30 天 | `High5xxRateFastBurn` / `SlowBurn` |
| API 延迟 | `slo:http_request_fast_ratio:5m`（<500ms 占比） | ≥ 99% | 30 天 | `HighP95Latency` / `VeryHighP95Latency` |
| PDF 成功率 | `1 - slo:pdf_job_failure_ratio:24h` | ≥ 99% | 24 小时滚动 | `PdfFailureRate` |
| PDF 排队时长 | `pdf_jobs_oldest_pending_seconds` | < 15 分钟 | 7 天 | `PdfJobStale` |
| PDF 缓存命中率 | `slo:pdf_cache_hit_ratio:30m` | ≥ 50% | 30 分钟滚动 | `PdfCacheHitRateLow` |
| 审计导出成功率 | `1 - failed/(done+failed)` | ≥ 80% | 24 小时滚动 | `AuditExportFailureRate` |
| 审计导出排队 | `audit_export_jobs_oldest_pending_seconds` | < 15 分钟 | 7 天 | `AuditExportJobStale` |
| DB 连接池 | `slo:db_pool_utilization:5m` | < 90% | 7 天 | `DbPoolSaturated` / `DbPoolWaiting` |
| 备份新鲜度 | `ai_delivery_backup_last_success_timestamp_seconds` | < 36 小时 | 每日 | `BackupStale` |
| 恢复演练 | `ai_delivery_restore_drill_last_success_timestamp_seconds` | < 90 天 | 季度 | `RestoreDrillStale` |

### 错误预算

- 99.9% / 30 天 ≈ **43 分钟**不可用预算。
- 99% 请求 <500ms / 30 天：允许约 1% 的请求超过 500ms。
- 预算消耗 >50%：暂停非必要发布，优先排障。
- 预算耗尽：功能冻结，直到连续 7 天回到 SLO 内。

> 延迟告警用 P95 作为先行指标；SLO 口径以“<500ms 请求占比”为准，避免平均值掩盖长尾。

## 3. 告警路由

| 级别 | 渠道 | 响应 |
|---|---|---|
| critical | 电话 / 值班群 @on-call | 5 分钟内确认，30 分钟内止损或回滚 |
| warning | 值班群 | 下一个工作日处理；影响扩大时升级 |
| info | 周报 | 每周复盘 |

实际路由配置见 `ops/alertmanager.yml`：

| 条件 | receiver | 响应 |
|---|---|---|
| `severity=critical` + `service=database` | `dba-oncall` | DBA 值班 |
| `severity=critical`（其他） | `pager` | 电话/Pager |
| `severity=warning` | `chat` | 值班群 |
| `severity=info` | `weekly` | 周报 |

抑制规则：

- 同 `service` 的 critical 抑制 warning，避免数据库宕机时连接池告警刷屏。
- `BackendDown` 抑制同 `service` 的 info（如 `NoTraffic`）。
- 跨服务不抑制。

本地路由演练：

```bash
cd backend && npm run drill:alerts
# 校验 17 条告警的 severity/service 标签、路由目标、9 个值班场景与抑制规则
```

> 这是路由树的确定性模拟，不替代 Alertmanager。生产接入后仍需做一次真实触发、认领、静默与升级演练。

维护窗口/临时静默：

```bash
amtool silence add alertname="HighP95Latency" --duration=2h --comment="发布窗口"
amtool silence query
amtool silence expire <silence-id>
```

静默必须带工单/原因，到期自动恢复；禁止长期静默 critical 告警。

`BackupStale`、`RestoreDrillStale` 依赖 node_exporter textfile：

```bash
# 备份与演练脚本会写入心跳
export PROM_TEXTFILE_DIR=/var/lib/node_exporter/textfile
make backup
make drill-restore
```

未接 textfile 时，`BackupMetricMissing` 会提示；可按环境禁用该组规则。

## 4. 值班 Runbook

### BackendDown

1. `docker compose ps` / `kubectl get pods -n ai-delivery`
2. 查看 backend 日志与 `/api/health`
3. 最近是否发布？`kubectl rollout undo` 或切回上一版镜像
4. 数据库/Redis 是否同时异常？

### DatabaseDown

1. 查 PostgreSQL 进程、连接数、磁盘与主备状态
2. 不要直接在生产主库上做 PITR 覆盖
3. 需要恢复时：基础备份 + WAL → 新实例 → 校验 → 切流量
4. 参考 `DEPLOY.md` 第 6 节与 `make drill-pitr`

### High5xxRate

1. 看 `slo:http_request_error_ratio:5m` 与错误路由
2. 用 `x-request-id` / `audit_logs.request_id` 检索日志
3. 优先回滚最近发布；确认是否为 PDF/Chromium、对象存储或数据库错误

### RedisDown

1. 业务会回退内存/数据库，不应整体不可用
2. 检查 Redis 内存、连接数、网络与认证
3. 恢复后确认 `/api/system/cache` 的 `healthy=true`
4. 多副本期间接受短时限流/会话缓存不一致

### PdfQueueBacklog / PdfJobStale

1. `docker compose logs pdf-worker` 或 `kubectl logs deploy/ai-delivery-pdf-worker`
2. 确认 Chromium 可用、磁盘与对象存储正常
3. 扩容 worker；检查 `pdf_jobs.locked_at` 与租约回收
4. 失败任务保留 `error`，修复后可重新创建

### PdfCacheHitRateLow

> 命中率 = `hits / (hits + misses)`，按 30 分钟滚动；30 分钟内总请求 < 0.01/s 时不告警，避免无流量误报。

1. 看 `pdf_cache_hits_total` / `pdf_cache_misses_total` 的速率：命中掉了还是未命中涨了
2. 内容哈希频繁变化会导致未命中：确认最近是否改了报告模板、差异明细或时间戳/随机字段
3. 检查缓存目录（`PDF_CACHE_DIR`）权限、磁盘剩余空间与对象存储连通性
4. 确认 `PDF_CACHE_TTL_DAYS` 没被调得过短；默认 30 天
5. 缓存底层是对象存储：`local` 默认写到 `.pdf-cache`（可用 `PDF_CACHE_DIR` 改），多副本各写本地盘；`s3` 则跨副本共享
6. 指标是进程内计数器，多副本请按副本分别看，再合计命中/未命中速率

### AuditExportJobStale / AuditExportFailureRate

1. 查 `GET /api/audit-exports` 是否有 pending 堆积；单进程内联执行，重启会续跑
2. 检查对象存储（`.pdf-cache` 或 S3）是否可写、磁盘是否已满
3. 失败任务看 `error` 字段；修复后调用 `POST /api/audit-exports/:id/retry` 重试
4. 大批量导出会占用内存与数据库连接，必要时错峰或调低 `AUDIT_EXPORT_MAX_ROWS`
5. 若为持续高失败率，先降级到同步小批量导出，再排查存储与 SQL

### DbPoolSaturated / DbPoolWaiting

1. 估算连接：副本数 × `PG_POOL_MAX` + worker
2. 引入 PgBouncer 或降低单副本池大小
3. 查慢 SQL、长事务与缺失索引
4. 不要盲目调大池上限，先确认数据库承载能力

### BackupStale

1. 手动执行 `make backup` 看报错
2. 检查磁盘、`pg_dump`、S3/异地同步
3. 恢复 `PROM_TEXTFILE_DIR` 心跳
4. 备份恢复后执行一次 `make drill-restore`

## 5. 仪表盘与指标

```bash
# 快速查看新增指标
curl -fsS http://127.0.0.1:8788/metrics | grep -E \
  'db_pool_|redis_|pdf_jobs_|slo:'
```

Grafana 看板：`ops/grafana-dashboard.json`

关键指标：

- `http_requests_total{method,route,status}`
- `http_request_duration_ms_*`
- `slow_requests_total`
- `db_up` / `db_pool_*`
- `redis_configured` / `redis_up`
- `pdf_jobs_pending|running|done_24h|failed_24h|oldest_pending_seconds`
- `ai_delivery_backup_last_success_timestamp_seconds`
- `ai_delivery_restore_drill_last_success_timestamp_seconds`

## 6. 复盘模板

```markdown
## 事件：<标题>
- 时间线（发现 / 止损 / 恢复）
- 影响范围与时长
- 直接原因 / 根因
- 检测方式（哪条告警、是否及时）
- 做得好 / 需要改进
- 行动项（负责人 / 截止时间）
- 是否消耗错误预算，剩余多少
```

原则：**先止损，再定位；告警必须可执行；复盘对事不对人。**
