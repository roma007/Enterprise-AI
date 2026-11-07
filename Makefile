.PHONY: up down logs ps backup restore metrics archive pdf-cleanup share-cleanup sessions-cleanup worker-logs migrate-prod drill-restore drill-pitr drill-rollout drill-alerts drill-s3 billing-run impl-map preflight install-hooks

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

backup:
	./scripts/backup.sh

# 用法：make restore FILE=backups/ai_delivery-YYYYMMDD-HHMMSS.dump
restore:
	./scripts/restore.sh $(FILE)

metrics:
	curl -fsS http://127.0.0.1:8788/metrics | head -40

archive:
	docker compose exec -T backend npm run audit:archive -- --days=180

pdf-cleanup:
	docker compose exec -T backend npm run pdf:cleanup -- --days=30

share-cleanup:
	docker compose exec -T backend npm run share:archive -- --days=180

sessions-cleanup:
	docker compose exec -T backend npm run sessions:cleanup -- --days=30

worker-logs:
	docker compose logs -f pdf-worker

migrate-prod:
	docker compose run --rm migrate

drill-restore:
	./scripts/restore-drill.sh

drill-pitr:
	./scripts/pitr-drill.sh

drill-rollout:
	cd backend && npm run drill:rollout

drill-alerts:
	cd backend && npm run drill:alerts

drill-s3:
	cd backend && npm run drill:s3

billing-run:
	cd backend && npm run billing:run

# 从《实施全景图.md》重新生成 HTML（单一事实源是 Markdown）
impl-map:
	python3 scripts/build_impl_map.py

# 提交前预检：HTML 同步 + 节点留痕（本地 hook 与 CI 共用同一脚本）
preflight:
	python3 scripts/preflight.py --staged

install-hooks:
	./scripts/install-git-hooks.sh
