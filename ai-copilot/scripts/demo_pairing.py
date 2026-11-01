"""配对演示：用现有样本伪造一份"TMS 历史记录"，验证配对率。

场景还原：
- 纸质原文 = 我们抽取出来的字段（模拟扫描 200 份后的结果）
- TMS 记录 = 理想录入结果，但故意制造 15% 的"当年录错"
- 看配对能不能把这些配对上，以及配不上的怎么暴露问题

用法：PYTHONPATH=. .venv/bin/python scripts/demo_pairing.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.extract import extract  # noqa: E402
from app.pairing import pair  # noqa: E402
from app.evalrun import HOLDOUT_PATH, SAMPLE_PATH, load_samples  # noqa: E402
from app.schema import FIELD_KEYS  # noqa: E402

random.seed(7)


def build() -> tuple[list[dict], list[dict]]:
    samples = load_samples(SAMPLE_PATH) + load_samples(HOLDOUT_PATH)
    papers, tms = [], []

    for i, s in enumerate(samples):
        draft = extract(s["raw"], allow_llm=False)
        p = {"id": f"P{i:03d}", **{k: (v.value or "") for k, v in draft.fields.items()}}
        papers.append(p)

        # TMS 记录：金标 + 分层制造"当年录入不规范"
        rec = {"id": f"T{i:03d}", **{k: s.get("gold", {}).get(k, "") for k in FIELD_KEYS}}
        r = random.random()
        if r < 0.15 and rec.get("booking_no"):
            # 单号写错一位 → 靠箱号兜底（应自动接受）
            rec["booking_no"] = rec["booking_no"][:-1] + str(random.randint(0, 9))
        elif r < 0.23:
            # 单号和箱号都写错 → 只能靠"客户+日期"（应转为人工确认）
            if rec.get("booking_no"):
                rec["booking_no"] = rec["booking_no"][:-1] + str(random.randint(0, 9))
            if rec.get("container_no"):
                rec["container_no"] = rec["container_no"][:-1] + str(random.randint(0, 9))
        elif r < 0.27:
            # 客户也没写全 → 配不上（这正是要暴露的问题）
            rec["booking_no"] = ""
            rec["container_no"] = ""
            rec["client"] = "某客户（未填全称）"
        tms.append(rec)

    # 再塞 3 条"TMS 里有、纸上没有"的历史单，检验反向未匹配
    for k in range(3):
        tms.append({"id": f"T9{k:02d}", "booking_no": f"OLD-{k}", "client": "历史客户"})

    random.shuffle(tms)
    return papers, tms


def main() -> None:
    papers, tms = build()
    res = pair(papers, tms)

    print(f"纸质样本 {res['papers']} 份，TMS 记录 {res['tms_records']} 条")
    print(f"配对成功 {res['matched']} 对（{res['pairing_rate']:.1%}）")
    print(f"  自动接受 {res['auto_accept']}（{res['auto_rate']:.1%}）")
    print(f"  需人工确认 {res['need_review']}")
    print(f"  纸上未配上 {len(res['unmatched_papers'])} 份")
    print(f"  TMS 中未配上 {len(res['unmatched_tms'])} 条")
    print("匹配依据分布:", json.dumps(res["by_reason"], ensure_ascii=False))

    if res["unmatched_papers"]:
        print("\n纸上未配上的样本（这些要么当年没录进 TMS，要么录入不规范）:")
        for pid in res["unmatched_papers"][:5]:
            print("  -", pid)

    print("\n前 5 对:", json.dumps(res["pairs"][:5], ensure_ascii=False, indent=1))

    # 三档判定自检：保证演示时能看到 accept / review / 配不上
    from app.pairing import score_pair
    p = {"booking_no": "HY-1105", "container_no": "CSQU3054383",
         "client": "宁波海通货代", "closing_time": "2026-11-07 18:00"}
    print("\n三档判定示例（同一张纸，对上三种 TMS 记录）:")
    for name, t in (
        ("单号一致", {"booking_no": "HY-1105"}),
        ("单号+箱号都错", {"booking_no": "HY-1106", "container_no": "CSQU3054389",
                     "client": "宁波海通货代", "closing_time": "2026-11-08 10:00"}),
        ("毫无共同特征", {"booking_no": "X1", "container_no": "Y2", "client": "其他客户"}),
    ):
        s, why = score_pair(p, t)
        action = "自动接受" if s >= 0.9 else ("人工确认" if s >= 0.6 else "配不上")
        print(f"  {name:<14} score={s:.2f} → {action}（{why}）")


if __name__ == "__main__":
    main()
