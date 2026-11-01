"""弱金标与抽检校准（D6）。

问题：客户没有人工标注过的"标准答案"，只有 TMS 里当年的录入结果。
      TMS 记录本身就有错（我们的实测发现漏录/错录约 3–5%）。

做法：
1. 用 TMS 记录当**弱金标**，先算一个"系统 vs TMS"的原始准确率
2. 从"不一致的单"里抽 10% 人工判：到底是系统错了，还是当年 TMS 录错了
3. 用抽检结果估计全部不一致单里"其实是 TMS 错"的比例
4. 校正出接近真实的准确率，并给出置信区间

这样不需要标 300 份，只需要判 30 份。
"""
from __future__ import annotations

import math
import random

from .schema import FIELD_KEYS, LABELS, normalize_for_compare


def _cmp(key: str, a: str | None, b: str | None) -> bool:
    return normalize_for_compare(key, a) == normalize_for_compare(key, b)


def evaluate(papers: list[dict], tms_by_id: dict[str, dict], pairs: list[dict]) -> dict:
    """按配对结果，逐字段比较"系统抽取" vs "TMS 记录"。"""
    per_field = {k: {"ok": 0, "n": 0} for k in FIELD_KEYS}
    record_ok = 0
    disagreements: list[dict] = []
    compared = 0
    paper_by_id = {x.get("id"): x for x in papers}

    for p in pairs:
        paper = paper_by_id.get(p["paper_id"])
        tms = tms_by_id.get(p["tms_id"])
        if not paper or not tms:
            continue
        compared += 1
        bad_fields = []
        for k in FIELD_KEYS:
            tv = tms.get(k, "")
            if not tv:
                continue  # TMS 没录的字段不参与比较（否则等于用漏录惩罚系统）
            pv = paper.get(k, "")
            per_field[k]["n"] += 1
            if _cmp(k, pv, tv):
                per_field[k]["ok"] += 1
            else:
                bad_fields.append({"field": k, "paper": pv, "tms": tv})
        if bad_fields:
            disagreements.append({
                "paper_id": p["paper_id"], "tms_id": p["tms_id"],
                "score": p.get("score"), "fields": bad_fields,
            })
        else:
            record_ok += 1

    total_ok = sum(v["ok"] for v in per_field.values())
    total_n = sum(v["n"] for v in per_field.values())

    by_field = [
        {"field": k, "label": LABELS[k],
         "accuracy": round(v["ok"] / v["n"], 4) if v["n"] else None, "n": v["n"]}
        for k, v in per_field.items() if v["n"]
    ]
    by_field.sort(key=lambda x: (x["accuracy"] if x["accuracy"] is not None else 1))

    return {
        "compared": compared,
        "field_accuracy": round(total_ok / total_n, 4) if total_n else 0.0,
        "record_exact_rate": round(record_ok / compared, 4) if compared else 0.0,
        "disagreements": disagreements,
        "disagreement_records": len(disagreements),
        "by_field": by_field,
        "note": "弱金标：TMS 记录本身可能有错，需抽检校准。",
    }


def sample_for_audit(result: dict, rate: float = 0.1, seed: int = 7) -> list[str]:
    """抽检样本优先来自"不一致的单"——那是唯一能判断谁错的地方。"""
    rnd = random.Random(seed)
    dis = [d["tms_id"] for d in result.get("disagreements", [])]
    n = max(10, int(math.ceil(result.get("compared", 0) * rate)))
    picked = dis[:n]
    rnd.shuffle(picked)
    return picked


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = min(1.0, max(0.0, k / n))
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    radicand = p * (1 - p) / n + z * z / (4 * n * n)
    m = z * math.sqrt(max(0.0, radicand))
    return max(0.0, (c - m) / d), min(1.0, (c + m) / d)


def calibrate(result: dict, audits: dict[str, str]) -> dict:
    """用抽检结果校正原始准确率。

    audits: {tms_id: "tms_wrong" | "system_wrong" | "both_wrong"}
    """
    compared = result.get("compared", 0)
    raw = result.get("field_accuracy", 0.0)
    if not audits or not compared:
        lo, hi = wilson(int(round(raw * compared)), compared)
        return {"raw_accuracy": raw, "adjusted_accuracy": raw,
                "ci95": [round(lo, 4), round(hi, 4)],
                "audited": 0, "note": "未提供抽检结果，无法校正"}

    tms_wrong = sum(1 for v in audits.values() if v == "tms_wrong")
    system_wrong = sum(1 for v in audits.values() if v == "system_wrong")
    both = sum(1 for v in audits.values() if v == "both_wrong")
    judged = len(audits)

    # 在"被判为错的单"里，TMS 自身错的比例（both_wrong 也算 TMS 错）
    p_tms_wrong = (tms_wrong + both) / judged if judged else 0.0

    dis = result.get("disagreement_records", 0)
    recovered = dis * p_tms_wrong
    adjusted = (raw * compared + recovered) / compared if compared else raw
    adjusted = min(1.0, adjusted)

    k = int(round(adjusted * compared))
    lo, hi = wilson(k, compared)

    return {
        "raw_accuracy": round(raw, 4),
        "adjusted_accuracy": round(adjusted, 4),
        "ci95": [round(lo, 4), round(hi, 4)],
        "audited": judged,
        "audit_breakdown": {"tms_wrong": tms_wrong, "system_wrong": system_wrong, "both_wrong": both},
        "estimated_tms_error_rate": round(p_tms_wrong, 4),
        "delta": round(adjusted - raw, 4),
        "note": "校正后的准确率更接近真实水平；抽检量越大，区间越窄。",
    }
