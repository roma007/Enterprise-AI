# 部署与备份恢复

> 日常运维、监控、cron、故障处置见 [OPERATIONS.md](./OPERATIONS.md)。

> 适用：单机 Docker Compose 部署（内部工作台）。
> 生产上线前请先读第 3 节「生产检查清单」。

---

## 1. 本地演示启动

```bash
cp .env.example .env
# 演示环境建议：AUTH_REQUIRED=false，SEED_DEMO=true
docker compose up -d --build
```

| 服务 | 地址 |
|---|---|
| 前端 | http://localhost:8080 |
| PDF Worker | 无端口，消费 `pdf_jobs` |
| Redis | 容器内 `redis:6379`，不对外暴露 |
| MinIO（可选） | http://localhost:9001（profile `s3`） |
| 后端 API | 经前端网关：http://localhost:8080/api/ |
| Swagger | http://localhost:8080/docs |
| 迁移 Job | 一次性 `migrate` 服务 |
| Redis | 容器内 `redis:6379`，不对外暴露 |
| PostgreSQL | 容器内 `db:5432`，不对外暴露 |

首次启动时：

1. `migrate` 一次性服务等待数据库健康
2. 执行 `npm run db:migrate`
3. 如果 `SEED_DEMO=true` 且库里没有客户，灌入宏远样例
4. backend 多副本（默认 2）启动，nginx 网关负载均衡
5. PDF worker 独立消费 `pdf_jobs`

> 升级前先执行迁移：`docker compose run --rm migrate`，再滚动重建 backend。
> Compose 只能提供有限滚动；真正零停机请使用 `ops/k8s/` 的 Kubernetes 清单。

> `SEED_DEMO=true` 也不会覆盖已有数据：只有 `clients` 为空时才 seed。

演示登录：

- `zhang@hengzhi.ai` / `demo1234`
- `wang@hengzhi.ai` / `demo1234`
- `liu@hengzhi.ai` / `demo1234`

---

## 2. 服务结构

```
frontend (nginx)  :8080 -> 80
   └── /api/* 反向代理 -> backend:8788
   └── /docs  反向代理 -> backend:8788
backend (node)    :8788
   └── PostgreSQL db:5432（仅容器网络）
db (postgres:16)  volume pgdata
```

- 前端静态资源由 nginx 提供，SPA 路由 fallback 到 `index.html`。
- 后端镜像包含 `psql`，用于首次 seed 和运维排查。
- `pgdata` 是数据库卷，`pdfcache` 是 API 与 worker 共享的 PDF 缓存卷，`miniodata` 是可选 MinIO 数据卷；删卷等于删库/缓存/对象。生产多主机请使用 S3/MinIO，不要依赖 `pdfcache` 卷。
- 对象存储本地联调：`make drill-s3`（`s3rver`）；生产按 `.env.example` 配置 `S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/PREFIX`。

---

## 3. 生产检查清单

上线前逐项确认：

- [ ] `AUTH_SECRET` 换成足够长的随机串（不要用默认值）
- [ ] `AUTH_REQUIRED=true`
- [ ] `POSTGRES_PASSWORD` 换成强密码
- [ ] `SEED_DEMO=false`
- [ ] 8788 端口不直接暴露公网；只暴露 nginx / 网关
- [ ] 前面加 TLS（Caddy / Nginx / 云负载均衡），不要裸 HTTP 对公网
- [ ] 配置每日备份 + 异地保存
- [ ] 至少做一次恢复演练
- [ ] 配置日志采集和磁盘告警（含 `slow_request`、`requestId` 字段）
- [ ] 配置 `/metrics` 抓取；生产建议设置 `METRICS_TOKEN`，不要裸暴露公网
- [ ] 导入 `ops/alerts.yml` 与 `ops/alertmanager.yml`，完成一次告警触发/认领演练
- [ ] 配置审计归档 cron：`npm run audit:archive -- --days=180`（建议先 `--dry-run`）
- [ ] PDF 导出依赖 Chromium 与中文字体；Docker 镜像已内置，非容器部署可用 `PDF_CHROME_PATH` 指定
- [ ] PDF 缓存默认在容器内 `.pdf-cache`；需要跨重启保留时挂载目录并设置 `PDF_CACHE_DIR`
- [ ] 配置 PDF 任务清理 cron：`npm run pdf:cleanup -- --days=30`（建议先 `--dry-run`）
- [ ] 确认 `pgdata` 卷有快照/备份策略
- [ ] 数据库迁移只通过 `db:migrate`，禁止 `db:reset`
- [ ] 确认试用默认天数（14 天）与各套餐配额符合商务政策
- [ ] 设置 `PAYMENT_PROVIDER`（`manual` / `mock` / `callback`）与 `BILLING_WEBHOOK_SECRET`
- [ ] 计费/发票为线下或网关回调流程；如需在线支付，另接支付厂商 SDK 与对账
- [ ] 客户数据脱敏/出境策略与 LLM 方案已确认（默认不调用外部 LLM；配置 `AI_BASE_URL` + `AI_API_KEY` 后才会调用）
- [ ] 如需启用 AI 润色：确认供应商数据条款、超时与回退策略（调用失败自动回退规则草稿）

> `AUTH_REQUIRED=true` 后，除 `/api/health`、`/api/auth/login`、`/api/auth/config`、`/api/openapi.json`、`/docs` 外都需要 Bearer token。

---

## 3.1 滚动发布与回滚演练

`APP_VERSION` 会写入 `/api/health` 与所有响应的 `x-app-version`，建议由 CI 注入镜像 tag 或 git sha。

K8s 发布：

```bash
kubectl -n ai-delivery set image deployment/ai-delivery-backend \
  backend=ghcr.io/your-org/ai-delivery-backend:<tag>
kubectl -n ai-delivery set env deployment/ai-delivery-backend APP_VERSION=<tag>
kubectl -n ai-delivery rollout status deployment/ai-delivery-backend
curl -fsS https://ai-delivery.example.com/api/health
curl -fsSI https://ai-delivery.example.com/api/health | grep -i x-app-version
```

本地演练（3 副本 + nginx，不依赖 K8s）：

```bash
cd backend
npm run drill:rollout
```

流程：新副本先通过 readiness → 切换 nginx upstream → 停旧副本；再验证坏版本被 readiness 拦截，最后完整回滚。2026-11-03 实测：发布 15,946 请求 0 失败，回滚 17,070 请求 0 失败。

> 压测使用短连接，避免客户端 keepalive 在 nginx reload 时被旧 worker 关闭而误判为服务端故障。

---

## 4. 备份

```bash
./scripts/backup.sh
# 或
make backup
```

- 自动检测 Docker Compose 的 `db` 容器；没有 Docker 时回退到本地 `DATABASE_URL`。
- 输出到 `backups/ai_delivery-YYYYMMDD-HHMMSS.dump`（`pg_dump -Fc`）。
- 默认包含全库；`--no-owner --no-acl` 便于跨环境恢复。
- 注意：`--no-acl` 不会包含 GRANT。恢复到新库后必须执行 `scripts/sql/restore_grants.sql` 重建 `ai_delivery_app` 权限，否则 RLS 下会 `permission denied`。`restore.sh` 与 `restore-drill.sh` 已自动处理。
- 若执行恢复的数据库用户与应用连接用户不同，还需把角色授予应用用户：`GRANT ai_delivery_app TO <应用用户>;`。
- 建议：每日 cron + 备份文件异地/对象存储保存 + 保留 30 天。

示例 cron：

```cron
15 2 * * * cd /opt/enterprise-ai && ./scripts/backup.sh >> /var/log/ai-delivery-backup.log 2>&1
```

---

## 5. 恢复

```bash
./scripts/restore.sh backups/ai_delivery-20261031-021500.dump
# 或
make restore FILE=backups/ai_delivery-20261031-021500.dump
```

- 会要求输入 `yes` 确认。
- Docker 模式会先停止 `backend` / `frontend`，恢复后自动重启。
- 使用 `pg_restore --clean --if-exists --no-owner --no-acl`。
- 恢复会覆盖当前库；**不要在生产高峰执行**。

恢复后建议：

```bash
curl -fsS http://127.0.0.1:8788/api/health
curl -fsS http://127.0.0.1:8788/api/auth/config
```

### 5.1 恢复演练

```bash
make drill-restore
# 等价于 ./scripts/restore-drill.sh
```

演练会自动完成：备份当前库 → 创建临时库 → 恢复 → 校验表/迁移/关键表行数 → 校验 RLS 隔离 → 删除临时库。默认不保留 dump，`KEEP_DRILL_DUMP=true` 可保留。

---

## 6. PITR（时间点恢复）

逻辑备份只能恢复到备份时刻；生产还需要 WAL 归档做时间点恢复。

**托管 PostgreSQL**：启用自动备份 + PITR，保留 7–30 天；每季度至少恢复到新实例验证一次。

**自建 PostgreSQL** 关键参数：

```conf
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://your-bucket/wal/%f'  # 或 MinIO/rsync
```

- 每日 `pg_basebackup` 基础备份。
- WAL 归档与基础备份分开存储，至少一份异地。
- 恢复流程：基础备份 → `restore_command` 拉 WAL → `recovery_target_time` → promote → 校验后切流量。
- 不要把 PITR 直接覆盖生产主库；先恢复到新实例。

**本地演练**（临时集群，不碰现有数据）：

```bash
make drill-pitr
# 等价于 ./scripts/pitr-drill.sh
```

会验证：目标时间之前的数据恢复、目标时间之后的数据不出现，并做一次“恢复到更晚时间”的对照，确认 after 行出现、after2 行不出现。需要本机 PostgreSQL 服务端工具；端口可用 `PITR_PORT` / `PITR_RESTORE_PORT` 调整。

---

## 7. 迁移

- 迁移文件：`backend/db/migrations/NNNN_*.sql`
- 记录表：`schema_migrations`（版本 + checksum）
- 后端容器启动时自动执行 `npm run db:migrate`
- 历史迁移不允许修改；变更请新增文件
- 旧库兼容：有 S1 表但没有迁移记录时，自动把 0001/0002 标记为基线

手工执行：

```bash
docker compose exec backend npm run db:migrate
```

---

## 8. 不用 Docker 的本地运行

```bash
cd backend
npm install
npm run db:reset
npm run dev

cd ../frontend
npm install
npm run dev
```

本地备份/恢复使用 `DATABASE_URL`：

```bash
DATABASE_URL=postgres://127.0.0.1:5432/ai_delivery ./scripts/backup.sh
DATABASE_URL=postgres://127.0.0.1:5432/ai_delivery ./scripts/restore.sh backups/xxx.dump
```

---

## 9. 常见问题

| 现象 | 排查 |
|---|---|
| backend 一直 unhealthy | `docker compose logs backend`；确认 db 健康、`DATABASE_URL` 正确 |
| 需要定位某次请求 | 用响应头/错误体里的 `x-request-id` / `requestId` 搜后端日志与 `audit_logs.request_id` |
| 前端 502 | backend 没起来或 nginx 代理地址不对；查 `docker compose ps` |
| 登录 401 | `AUTH_REQUIRED=true` 且未登录；先 `/api/auth/login` |
| 迁移 checksum 不一致 | 说明历史迁移被改过；新增迁移，不要改旧文件 |
| 恢复后数据不对 | 确认备份文件时间；`pg_restore` 是否报错；必要时回滚到上一个备份 |
| 磁盘满 | 清理旧备份和容器日志；`docker system df` |

---

## 10. 当前边界

- 单机 Compose，不是高可用集群；生产多副本需要外部 PostgreSQL + 负载均衡。
- 没有自动备份清理/异地同步，cron 与对象存储需自行接。
- 没有 TLS 终止和 WAF，建议放在现有网关后面。
- 组织隔离由应用层 + PostgreSQL RLS 双重保障；恢复后需执行 `scripts/sql/restore_grants.sql` 修复角色权限。
