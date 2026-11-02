"""生成抽样清单（B6）：档案室照着勾。

用法：
    # 演示：造 450 条台账，抽 40 份
    PYTHONPATH=. .venv/bin/python scripts/sample_plan.py --demo 40

    # 实际：读一份台账 JSONL（字段：id/month/client/format/filename）
    PYTHONPATH=. .venv/bin/python scripts/sample_plan.py --input 台账.jsonl --target 400 --out 抽样清单.csv
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.sampling import demo_inventory, manifest_csv, plan  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", type=int, default=0, help="造台账并抽这么多份")
    ap.add_argument("--input", type=str, default="", help="台账 JSONL 路径")
    ap.add_argument("--target", type=int, default=200)
    ap.add_argument("--out", type=str, default="", help="清单输出 CSV")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if args.demo:
        items = demo_inventory()
        target = args.demo
    elif args.input:
        items = [json.loads(l) for l in Path(args.input).read_text(encoding="utf-8").splitlines() if l.strip()]
        target = args.target
    else:
        ap.error("需要 --demo 或 --input")

    res = plan(items, target, seed=args.seed)
    st = res["stats"]
    print(f"台账 {st['candidates']} 条 → 抽样 {st['selected']} 份")
    print(f"分层 {st['strata_total']} 层，覆盖 {st['strata_covered']} 层（{st['coverage']:.0%}）")
    for name, n in list(st["by_stratum"].items())[:8]:
        print(f"  {name:<34} {n} 份")
    if len(st["by_stratum"]) > 8:
        print(f"  … 另有 {len(st['by_stratum'])-8} 层")
    for w in res["warnings"]:
        print("  ⚠", w)

    csv_text = manifest_csv(res["selected"])
    out = Path(args.out) if args.out else ROOT / "data" / "抽样清单.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(csv_text, encoding="utf-8")
    print(f"\n清单已生成：{out}")


if __name__ == "__main__":
    main()
