.PHONY: up down logs ps backup restore metrics archive pdf-cleanup share-cleanup sessions-cleanup

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
