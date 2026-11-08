#!/usr/bin/env python3
"""运维智能自检：灰犀牛/黑天鹅规则、研判、Runbook、状态存储。

用法：
    cd ai-copilot && PYTHONPATH=. .venv/bin/python scripts/test_aiops.py
    cd ai-copilot && make aiops-test
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from app import aiops


def healthy() -> dict:
    return {
        "host": {"up": True, "heartbeat_age_sec": 5, "disk_used_pct": 42,
                 "disk_growth_pct_per_day": 0.1, "mem_used_pct": 45,
                 "cpu_used_pct": 20, "uptime_hours": 100},
        "db": {"up": True, "size_bytes": 1.2e9, "growth_gb_per_day": 0.01,
               "pool_util": 0.3, "pool_waiting": 0, "slow_queries_1h": 0,
               "backup_age_hours": 4},
        "app": {"up": True, "http_5xx_ratio": 0.0, "p95_ms": 200,
                "batch_failed": 0, "outbox_pending": 0, "queue_pending": 0,
                "ocr_fail_ratio": 0.0, "llm_timeout_per_5m": 0},
        "security": {"cert_days_left": 120},
        "probes": {"external_ok": True, "db_ok": True, "llm_ok": True},
        "recent_change": {"version": "v1.0", "deployed_minutes_ago": 600},
    }


def main() -> int:
    checks = []
    old = aiops.STATE_PATH
    tmp = Path(tempfile.mkdtemp(prefix="aiops-")) / "state.json"
    aiops.STATE_PATH = tmp
    try:
        # 健康快照：不应产生风险/事件
        h = aiops.evaluate(healthy(), persist=False)
        checks.append(("健康快照无告警", not h["risks"] and not h["incidents"]))

        # 灰犀牛：磁盘/DB/证书/备份/队列
        g = aiops.evaluate(aiops.demo_snapshot("gray"), persist=False)
        titles = " ".join(x["title"] for x in g["risks"])
        checks.append(("灰犀牛-磁盘", "磁盘" in titles))
        checks.append(("灰犀牛-DB", "数据库" in titles))
        checks.append(("灰犀牛-证书", "证书" in titles))
        checks.append(("灰犀牛-备份", "备份" in titles))
        checks.append(("灰犀牛-队列", "积压" in titles))
        checks.append(("灰犀牛无黑天鹅", not g["incidents"]))

        # 黑天鹅：主机/网络不可达，且不重复报 app/db
        b = aiops.demo_snapshot("black")
        k = aiops.evaluate(b, persist=False)
        p0 = [x for x in k["incidents"] if x["severity"] == "P0"]
        checks.append(("黑天鹅-P0", len(p0) == 1 and p0[0]["rule"] == "host_down"))
        checks.append(("黑天鹅不重复", len(k["incidents"]) == 1))

        # AI 研判（规则回退）：有结论、证据、动作、升级对象
        diag = aiops.diagnose(p0[0], use_llm=False)
        checks.append(("研判-有结论", bool(diag["summary"])))
        checks.append(("研判-有证据", bool(diag["evidence"])))
        checks.append(("研判-有动作", bool(diag["immediate_actions"])))
        checks.append(("研判-有升级", bool(diag["escalate_to"])))

        # Runbook：低风险自动，中/高风险需审批
        low = aiops.plan_runbook("disk_cleanup", "host-1")
        high = aiops.plan_runbook("db_pool_tune", "db-1")
        checks.append(("Runbook-低风险", low["risk"] == "low" and not low["requires_approval"]))
        checks.append(("Runbook-高风险审批", high["risk"] == "medium" and high["requires_approval"]))

        # 持久化：mixed 演示应写入状态，summary 可读
        aiops.reset()
        aiops.demo("mixed")
        s = aiops.summary()
        checks.append(("状态-风险", s["risks"] >= 5))
        checks.append(("状态-事件", s["incidents"] >= 1))
        checks.append(("状态-最近评估", bool(s["last_eval"])))

        # 事故认领/解决
        inc = aiops.state()["incidents"][0]
        aiops.ack_incident(inc["id"], "tester")
        checks.append(("事故-认领", aiops.state()["incidents"][0]["status"] == "acknowledged"))
        aiops.resolve_incident(inc["id"], "tester", "自检")
        checks.append(("事故-解决", aiops.state()["incidents"][0]["status"] == "resolved"))
    finally:
        aiops.STATE_PATH = old

    bad = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"  {'✓' if ok else '✗'} {name}")
    if bad:
        print("失败：" + "、".join(bad))
        return 1
    print(f"全部通过（{len(checks)} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
