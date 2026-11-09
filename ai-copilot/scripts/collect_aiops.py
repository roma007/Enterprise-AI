#!/usr/bin/env python3
"""采集本机指标并评估一次（给 cron / 定时任务用）。

建议每 5 分钟跑一次，输出可直接进日志：

    */5 * * * * cd /srv/ai-copilot && PYTHONPATH=. .venv/bin/python \\
        scripts/collect_aiops.py >> data/aiops_cron.log 2>&1

它写入的是和页面“采集本机”同一份状态；Prometheus 再抓 /metrics 就能告警。
"""
from __future__ import annotations

import sys

from app import aiops


def main() -> int:
    result = aiops.collect()
    s = result["summary"]
    print(f"{result['generated_at']} 灰犀牛 {s['risks']}（可自动 {s['auto_ready']}）"
          f" 事件 {s['incidents']}（P0 {s['p0']} / P1 {s['p1']}）")
    for x in result["risks"][:10]:
        print(f"  风险 [{x['severity']}] {x['title']} → {x['runbook']}（{x['eta']}）")
    for x in result["incidents"]:
        print(f"  事件 [{x['severity']}] {x['title']} → 升级：{x['escalate_to']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
