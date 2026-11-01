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
| 后端 API | http://localhost:8788 |
| Swagger | http://localhost:8788/docs |
| PostgreSQL | 容器内 `db:5432`，不对外暴露 |

首次启动时后端会：

1. 等待 `db` 健康
2. 执行 `npm run db:migrate`（4 个迁移）
3. 如果 `SEED_DEMO=true` 且库里没有客户，灌入宏远样例
4. 启动 Fastify，监听 `0.0.0.0:8788`

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
- `pgdata` 是唯一持久化卷；删卷等于删库。

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
- [ ] 配置审计归档 cron：`npm run audit:archive -- --days=180`（建议先 `--dry-run`）
- [ ] PDF 导出依赖 Chromium 与中文字体；Docker 镜像已内置，非容器部署可用 `PDF_CHROME_PATH` 指定
- [ ] PDF 缓存默认在容器内 `.pdf-cache`；需要跨重启保留时挂载目录并设置 `PDF_CACHE_DIR`
- [ ] 配置 PDF 任务清理 cron：`npm run pdf:cleanup -- --days=30`（建议先 `--dry-run`）
- [ ] 确认 `pgdata` 卷有快照/备份策略
- [ ] 数据库迁移只通过 `db:migrate`，禁止 `db:reset`
- [ ] 客户数据脱敏/出境策略与 LLM 方案已确认（默认不调用外部 LLM；配置 `AI_BASE_URL` + `AI_API_KEY` 后才会调用）
- [ ] 如需启用 AI 润色：确认供应商数据条款、超时与回退策略（调用失败自动回退规则草稿）

> `AUTH_REQUIRED=true` 后，除 `/api/health`、`/api/auth/login`、`/api/auth/config`、`/api/openapi.json`、`/docs` 外都需要 Bearer token。

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

---

## 6. 迁移

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

## 7. 不用 Docker 的本地运行

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

## 8. 常见问题

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

## 9. 当前边界

- 单机 Compose，不是高可用集群；生产多副本需要外部 PostgreSQL + 负载均衡。
- 没有自动备份清理/异地同步，cron 与对象存储需自行接。
- 没有 TLS 终止和 WAF，建议放在现有网关后面。
- 组织隔离仍是应用层实现，数据库未启用 RLS。
