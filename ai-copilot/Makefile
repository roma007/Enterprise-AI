# 有 .venv 就用它，否则退回系统 python
PY ?= $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)
PORT ?= 8790

.PHONY: setup dev eval smoke prewarm pairing goldset enhance amend simday reset clean

# 需要 Python 3.11 / 3.12（onnxruntime 尚无 3.14 的 wheel）
setup:
	uv venv .venv --python 3.11
	uv pip install --python .venv/bin/python -r requirements.txt

dev:
	PYTHONPATH=. $(PY) -m uvicorn app.main:app --reload --port $(PORT)

eval:
	PYTHONPATH=. $(PY) -m app.evalrun

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
	rm -f data/copilot.db
	@echo "telemetry db removed"

clean:
	rm -rf .venv data/copilot.db __pycache__ app/__pycache__

# 模拟一整天：入口 → 解析 → 分级 → 确认 → 指标 → 风险 → 拆分 → 改单
simday:
	PYTHONPATH=. $(PY) scripts/sim_day.py
