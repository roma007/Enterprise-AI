"""弱金标评测演示（D6）：用 TMS 记录当答案，再用抽检校正。

演示逻辑：
1. 28 份纸质样本 → 系统抽取
2. 伪造 31 条 TMS 记录，其中故意把 12% 的记录改错（模拟当年人工录错）
3. 用 TMS 当弱金标评测 → 得到一个偏低的原始准确率
4. 抽检不一致的单 → 校正 → 准确率回升

这就是"没有人工标注也能给出可信数字"的办法。

用法：PYTHONPATH=. .venv/bin/python scripts/demo_goldset.py
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.evalrun import HOLDOUT_PATH, SAMPLE_PATH, load_samples  # noqa: E402
from app.extract import extract  # noqa: E402
from app.goldset import calibrate, evaluate, sample_for_audit  # noqa: E402
from app.pairing import pair  # noqa: E402
from app.schema import FIELD_KEYS  # noqa: E402

random.seed(11)


def build():
    samples = load_samples(SAMPLE_PATH) + load_samples(HOLDOUT_PATH)
    papers, tms, truth = [], [], {}

    for i, s in enumerate(samples):
        d = extract(s["raw"], allow_llm=False)
        papers.append({"id": f"P{i:03d}", **{k: (v.value or "") for k, v in d.fields.items()}})

        gold = s.get("gold", {})
        rec = {"id": f"T{i:03d}", **{k: gold.get(k, "") for k in FIELD_KEYS}}
        if random.random() < 0.12 and rec.get("container_no"):
            rec["container_no"] = rec["container_no"][:-1] + str(random.randint(0, 9))
            truth[rec["id"]] = "tms_wrong"
        tms.append(rec)

    random.shuffle(tms)
    return papers, tms, truth


def main() -> None:
    papers, tms, truth = build()
    pr = pair(papers, tms)
    res = evaluate(papers, {t["id"]: t for t in tms}, pr["pairs"])

    print(f"配对 {pr['matched']} 对 / 纸质 {len(papers)} 份")
    print(f"原始（弱金标）字段级准确率：{res['field_accuracy']:.1%}")
    print(f"整单完全一致：{res['record_exact_rate']:.1%}")
    print(f"不一致的单：{res['disagreement_records']} 张")

    sample = sample_for_audit(res, 0.1)
    audits = {tid: truth.get(tid, "system_wrong") for tid in sample}
    cal = calibrate(res, audits)

    print(f"\n抽检 {cal['audited']} 张（其中 TMS 自身错 {cal['audit_breakdown']['tms_wrong']} 张）")
    print(f"估计 TMS 错误率：{cal['estimated_tms_error_rate']:.0%}")
    print(f"校正后准确率：{cal['adjusted_accuracy']:.1%}"
          f"  （原始 {cal['raw_accuracy']:.1%}，+{cal['delta']*100:.1f} 个点）")
    print(f"95% 置信区间：{cal['ci95'][0]:.1%} – {cal['ci95'][1]:.1%}")

    print("\n最弱的 5 个字段：")
    for f in res["by_field"][:5]:
        print(f"  {f['label']:<12} {f['accuracy']:.0%}  (n={f['n']})")


if __name__ == "__main__":
    main()
