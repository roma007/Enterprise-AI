# 有 .venv 就用它，否则退回系统 python
PY ?= $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)
PORT ?= 8790

.PHONY: setup dev eval smoke ops-eval prewarm pairing goldset enhance amend simday intake sample invoice threeway reconcile aging settlement demo reset clean backup cleanup cleanup-apply verify-https pg-migrate pg-migrate-apply pg-test

# 需要 Python 3.11 / 3.12（onnxruntime 尚无 3.14 的 wheel）
setup:
	uv venv .venv --python 3.11
	uv pip install --python .venv/bin/python -r requirements.txt

dev:
	PYTHONPATH=. $(PY) -m uvicorn app.main:app --reload --port $(PORT)

eval:
	PYTHONPATH=. $(PY) -m app.evalrun

ops-eval:
	PYTHONPATH=. $(PY) scripts/eval_ops.py

smoke:
	./scripts/smoke.sh http://127.0.0.1:$(PORT)

pairing:
	PYTHONPATH=. $(PY) scripts/demo_pairing.py

goldset:
	PYTHONPATH=. $(PY) scripts/demo_goldset.py

enhance:
	PYTHONPATH=. $(PY) scripts/demo_enhance.py

amend:
	PYTHONPATH=. $(PY) scripts/demo_amend.py

# 演示前预热模型缓存：现场点解析不再等 5–8 秒
prewarm:
	PYTHONPATH=. $(PY) scripts/prewarm.py

reset:
	rm -f data/copilot.db data/copilot.db-wal data/copilot.db-shm
	@echo "telemetry db removed"

clean:
	rm -rf .venv data/copilot.db data/copilot.db-wal data/copilot.db-shm __pycache__ app/__pycache__

# 安全备份（WAL 下必须用 SQLite 在线备份，不能直接 cp）
backup:
	PYTHONPATH=. $(PY) scripts/backup_db.py --keep 14

# 数据保留：默认 dry-run，只统计会删多少
cleanup:
	PYTHONPATH=. $(PY) scripts/cleanup.py --days 180

cleanup-apply:
	PYTHONPATH=. $(PY) scripts/cleanup.py --days 180 --apply

# 用真实 nginx + 自签证书验证 HTTPS 反向代理（需要本机有 nginx/openssl）
verify-https:
	./scripts/test_https_proxy.sh

# SQLite → PostgreSQL（默认 dry-run；PG_URL 可覆盖）
PG_URL ?= postgres://127.0.0.1:5432/ai_copilot
pg-migrate:
	PYTHONPATH=. $(PY) scripts/migrate_to_pg.py --pg "$(PG_URL)"

pg-migrate-apply:
	PYTHONPATH=. $(PY) scripts/migrate_to_pg.py --pg "$(PG_URL)" --apply

# PostgreSQL / 多实例自检（需要 PG_TEST_URL 指向测试库）
pg-test:
	PG_TEST_URL="$(PG_TEST_URL)" PYTHONPATH=. $(PY) scripts/test_pg_db.py

# 模拟一整天：入口 → 解析 → 分级 → 确认 → 指标 → 风险 → 拆分 → 改单
simday:
	PYTHONPATH=. $(PY) scripts/sim_day.py

# 资料采集模拟：扫描质量 / TMS 导入 / 配对 / 工时
intake:
	PYTHONPATH=. $(PY) scripts/sim_intake.py

# 分层抽样：make sample N=400（演示台账）
sample:
	PYTHONPATH=. $(PY) scripts/sample_plan.py --demo $(if $(N),$(N),200) --out data/抽样清单.csv

# 发票识别演示：渲染 3 张发票 → OCR → 抽取 → 校验
invoice:
	PYTHONPATH=. $(PY) scripts/demo_invoice.py

# 三单匹配演示：一致 / 金额不符 / 箱号不符
threeway:
	@curl -sS http://127.0.0.1:8790/api/threeway/demo | $(PY) -m json.tool

# 自动对账演示：13 条对账单 / 11 条运单
reconcile:
	@curl -sS http://127.0.0.1:8790/api/reconcile/demo | $(PY) -m json.tool | head -40

# 账龄与催收演示
aging:
	@curl -sS http://127.0.0.1:8790/api/aging/demo | $(PY) -m json.tool | head -30

# 外协结算演示：合同价 vs 车队报账
settlement:
	@curl -sS http://127.0.0.1:8790/api/settlement/demo | $(PY) -m json.tool | head -30

# 一键演示页（会客时用）
demo:
	@echo "http://127.0.0.1:8790/demo"
	@open http://127.0.0.1:8790/demo 2>/dev/null || true
