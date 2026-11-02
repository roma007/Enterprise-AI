"""PostgreSQL / 多实例自检（C4 + D7）。

需要先准备一个**测试库**（会被写入少量测试数据）：
    createdb ai_copilot_test
    PG_TEST_URL=postgres://127.0.0.1:5432/ai_copilot_test \
      PYTHONPATH=. .venv/bin/python scripts/test_pg_db.py

覆盖：
- init_db 幂等，多个实例同时启动不死锁
- 任务队列：并发抢占只有一个成功；租约过期可被接手
- 发件箱：并发抢占不重复
- 阈值：写 PG 后其他连接能读到

没有 PG_TEST_URL 时跳过（退出码 0），方便在只有 SQLite 的环境跑。
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

URL = os.getenv("PG_TEST_URL", "").strip()
if not URL:
    print("  - 未设置 PG_TEST_URL，跳过 PostgreSQL 自检")
    sys.exit(0)

os.environ["DATABASE_URL"] = URL

from app import db, thresholds  # noqa: E402
from app.store import (  # noqa: E402
    claim_job, enqueue_job, finish_job, init_db, outbox_add, outbox_claim,
    outbox_mark,
)

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


if db.BACKEND != "postgres":
    print("✗ DATABASE_URL 不是 PostgreSQL")
    sys.exit(1)
if "test" not in URL.lower() and os.getenv("PG_ALLOW_NONTEST") != "1":
    print("✗ 为防误写生产库，库名需包含 test；确认无误会设 PG_ALLOW_NONTEST=1")
    sys.exit(1)

print("1. 多实例同时 init_db")
errors: list[str] = []


def init_once():
    try:
        init_db()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{type(exc).__name__}: {exc}")


threads = [threading.Thread(target=init_once) for _ in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()
chk("5 个并发 init_db 无死锁/报错", not errors, str(errors[:2]))

print("2. 任务队列并发抢占")
job = enqueue_job("test", f"job-{time.time_ns()}", {"x": 1})
chk("入队成功", bool(job))
claims: list[dict] = []
barrier = threading.Barrier(6)


def claim(worker: str):
    barrier.wait()
    got = claim_job(worker, lease_seconds=30)
    if got:
        claims.append(got)


threads = [threading.Thread(target=claim, args=(f"w{i}",)) for i in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()
chk("6 个 worker 只有一个抢到", len(claims) == 1, f"抢到 {len(claims)} 个")
if claims:
    chk("参数随任务传递", claims[0].get("params_json") == '{"x": 1}')
    finish_job(claims[0]["id"], claims[0]["worker"], "done")
chk("完成后无法再抢", claim_job("w-after", 30) is None or claim_job("w-after-2", 30) is None)

print("3. 租约过期可接手")
job2 = enqueue_job("test", f"lease-{time.time_ns()}")
first = claim_job("w-a", lease_seconds=-1)  # 立即过期
chk("首次抢到", bool(first))
second = claim_job("w-b", lease_seconds=30)
chk("过期后被另一个 worker 接手", bool(second) and second["worker"] == "w-b",
    str(second and second.get("worker")))
if second:
    finish_job(second["id"], second["worker"], "done")

print("4. 发件箱并发抢占")
keys = [f"out-{time.time_ns()}-{i}" for i in range(3)]
for k in keys:
    outbox_add(k, {"idempotency_key": k}, "", "")
got: list[dict] = []
barrier = threading.Barrier(3)


def take(worker: str):
    barrier.wait()
    got.extend(outbox_claim(worker, limit=10))


threads = [threading.Thread(target=take, args=(f"d{i}",)) for i in range(3)]
for t in threads:
    t.start()
for t in threads:
    t.join()
ids = [g["id"] for g in got]
chk("3 条发件项被领走", len(ids) == 3, str(len(ids)))
chk("没有重复领取", len(set(ids)) == 3)
for g in got:
    outbox_mark(g["id"], "sent", "", {"ok": True})

print("5. 阈值共享")
thresholds.reset(actor="test")
thresholds.set_many({"booking.risk_auto_floor": 0.93}, actor="test")
thresholds._cache = None
thresholds._cache_at = 0
chk("写后读回 0.93", abs(thresholds.get("booking.risk_auto_floor") - 0.93) < 1e-9)
thresholds.reset(actor="test")
thresholds._cache = None
thresholds._cache_at = 0
chk("恢复默认 0.90", abs(thresholds.get("booking.risk_auto_floor") - 0.90) < 1e-9)

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
