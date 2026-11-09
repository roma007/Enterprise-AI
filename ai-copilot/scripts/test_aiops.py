#!/usr/bin/env python3
"""运维智能自检：灰犀牛/黑天鹅规则、研判、Runbook、状态存储。

用法：
    cd ai-copilot && PYTHONPATH=. .venv/bin/python scripts/test_aiops.py
    cd ai-copilot && make aiops-test
"""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from app import aiops, llm_usage


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
    old_ledger, old_budget = llm_usage.LEDGER_PATH, llm_usage.BUDGET_PATH
    llm_usage.LEDGER_PATH = tmp.parent / "llm_usage.json"
    llm_usage.BUDGET_PATH = tmp.parent / "llm_budget.json"
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

        # 灰犀牛：模型资源（余额 / 额度 / 到期 / 消耗放大）
        checks.append(("灰犀牛-模型余额", "余额" in titles))
        checks.append(("灰犀牛-token额度", "token 额度" in titles))
        checks.append(("灰犀牛-Key到期", "Key/账号" in titles))
        checks.append(("灰犀牛-模型到期", "天后到期" in titles and "deepseek" in titles))
        checks.append(("灰犀牛-消耗放大", "今日模型消耗" in titles))

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
        topup = aiops.plan_runbook("llm_topup", "llm")
        checks.append(("Runbook-充值需审批", topup["risk"] == "medium" and topup["requires_approval"]))

        # ---- 模型用量账本与预算 ----
        days = {(date.today() - timedelta(days=i)).isoformat():
                {"tokens": 100000, "calls": 10} for i in range(1, 8)}
        llm_usage.LEDGER_PATH.write_text(json.dumps(
            {"version": 1, "total_tokens": 700000, "days": days}), encoding="utf-8")
        llm_usage.record(2000, ok=True)
        st = llm_usage.stats(7)
        checks.append(("账本-今日用量", st["today_tokens"] == 2000))
        checks.append(("账本-日均", abs(st["avg_tokens_per_day"] - 100000) < 1))
        llm_usage.record(0, ok=False)
        checks.append(("账本-失败计数", llm_usage.stats(7)["today_errors"] == 1))

        llm_usage.set_budget(
            balance_cny=300, quota_tokens=900000, price_per_1k=1.0,
            key_expires_at=(date.today() + timedelta(days=5)).isoformat(),
            model_retires_at=(date.today() + timedelta(days=200)).isoformat())
        snap = llm_usage.snapshot()
        checks.append(("预算-余额", snap["balance_cny"] == 300.0))
        checks.append(("预算-token剩余", snap["remaining_tokens"] == 198000))
        checks.append(("预算-余额可撑天数", abs((snap["days_left_balance"] or 0) - 3.0) < 0.1))
        checks.append(("预算-额度可撑天数", abs((snap["days_left_tokens"] or 0) - 1.98) < 0.05))

        lr = aiops.evaluate({"llm": snap, "probes": {}}, persist=False)
        ltitles = " ".join(x["title"] for x in lr["risks"])
        checks.append(("规则-模型余额风险", "余额" in ltitles))
        checks.append(("规则-模型额度风险", "token 额度" in ltitles))
        checks.append(("规则-额度先降级", any(x["runbook"] == "llm_throttle" for x in lr["risks"])))
        checks.append(("规则-Key到期风险", "Key/账号" in ltitles))

        zero = dict(snap, balance_cny=0, remaining_tokens=0)
        zr = aiops.evaluate({"llm": zero, "probes": {}}, persist=False)
        zrules = {x["rule"] for x in zr["incidents"]}
        checks.append(("规则-余额耗尽P1", "llm_balance_exhausted" in zrules))
        checks.append(("规则-额度耗尽P1", "llm_quota_exhausted" in zrules))
        checks.append(("规则-耗尽升级", all(x["severity"] == "P1" for x in zr["incidents"])))

        cs = aiops.collect_snapshot()
        checks.append(("采集-本机磁盘", "disk_used_pct" in (cs.get("host") or {})))
        checks.append(("采集-模型用量", "llm" in cs))

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
        llm_usage.LEDGER_PATH = old_ledger
        llm_usage.BUDGET_PATH = old_budget

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
