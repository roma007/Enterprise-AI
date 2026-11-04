# Kubernetes 部署

> 目标：多副本 API、独立 PDF worker、滚动升级、零停机发布。
> 生产数据库/Redis/MinIO 建议使用托管服务；本目录只提供应用侧清单。

## 1. 准备

```bash
kubectl apply -f ops/k8s/ai-delivery.yaml
# 修改 Secret 中的 DATABASE_URL / REDIS_URL / S3_* / AUTH_SECRET
```

镜像地址替换为实际仓库：

- `ghcr.io/your-org/ai-delivery-backend`
- `ghcr.io/your-org/ai-delivery-frontend`

## 2. 首次/升级迁移

```bash
kubectl -n ai-delivery delete job ai-delivery-migrate --ignore-not-found
kubectl apply -f ops/k8s/ai-delivery.yaml
kubectl -n ai-delivery wait --for=condition=complete job/ai-delivery-migrate --timeout=300s
```

迁移使用独立 Job，避免多副本 API 并发迁移。

## 3. 发布顺序

1. 执行 expand 迁移（新增列/表，保持向后兼容）
2. 滚动更新 backend（`maxUnavailable: 0`）
3. 滚动更新 worker
4. 滚动更新 frontend
5. 观察 `/metrics` 错误率与 P95
6. 执行 contract 迁移（删除旧列）放到下一轮

```bash
kubectl -n ai-delivery set image deployment/ai-delivery-backend backend=ghcr.io/your-org/ai-delivery-backend:<tag>
kubectl -n ai-delivery set env deployment/ai-delivery-backend APP_VERSION=<tag>
kubectl -n ai-delivery rollout status deployment/ai-delivery-backend

# 版本校验：/api/health 与所有响应头
curl -fsS https://ai-delivery.example.com/api/health
curl -fsSI https://ai-delivery.example.com/api/health | grep -i x-app-version
```

本地可先跑滚动发布/回滚演练（3 副本 + nginx）：

```bash
cd backend && npm run drill:rollout
```

## 4. 关键前提

- 后端无状态；会话/限流依赖 Redis，PDF 缓存依赖 S3/MinIO。
- 多副本必须配置 `REDIS_URL` 与 `STORAGE_DRIVER=s3`。
- `PDF_WORKER_INLINE=false`，worker 单独扩缩容。
- 数据库连接池按副本数 × `PG_POOL_MAX` 估算，建议 PgBouncer。
- 就绪探针 `/api/health`；滚动期间 PDB 保证至少 1 个副本。

## 5. 回滚

```bash
kubectl -n ai-delivery rollout undo deployment/ai-delivery-backend
```

迁移采用 expand-contract，回滚应用通常不需要回滚数据库。
