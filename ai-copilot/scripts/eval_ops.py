#!/usr/bin/env python3
"""运行运营能力合成回归，打印摘要；未通过时返回非 0。

用法：
    cd ai-copilot && PYTHONPATH=. .venv/bin/python scripts/eval_ops.py
    cd ai-copilot && make ops-eval
"""
from __future__ import annotations

import sys

from app.ops_eval import evaluate


def main() -> int:
    r = evaluate()
    t, d, e, c = r["tracking"], r["dispatch"], r["events"], r["customs"]
    print("运营能力合成回归（不代表真实客户效果）")
    print(f"  在途查询：{t['shipments']} 票；箱号 {t['container_hit']:.1%}，"
          f"单号 {t['booking_hit']:.1%}，客户 {t['customer_hit']:.1%}，"
          f"无匹配不乱答 {t['no_match_ok']:.1%}")
    print(f"  调度装箱：{d['orders']} 单 / {d['vehicles']} 车；未派 {d['unassigned']}；"
          f"准时率 {d['on_time_baseline']:.1%} → {d['on_time_optimized']:.1%}；"
          f"空驶 {d['empty_km_baseline']:,.0f} → {d['empty_km_optimized']:,.0f} km")
    print(f"  在途事件：{e['lines']} 条；P {e['precision']:.3f} / R {e['recall']:.3f} / "
          f"F1 {e['f1']:.3f}；漏 {e['fn']}，误 {e['fp']}")
    print(f"  HS 候选：{c['cases']} 条；Top-1 {c['top1']:.1%}，Top-3 {c['top3']:.1%}，"
          f"无匹配不乱给 {c['no_match_ok']:.1%}")
    failed = [k for k, v in r["checks"].items() if not v]
    if failed:
        print(f"  未通过：{', '.join(failed)}")
        return 1
    print("  全部通过；结果已写入 data/ops_eval.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
