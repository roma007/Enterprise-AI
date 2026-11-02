"""纸质原文 ↔ TMS 历史记录 配对（D4）。

为什么需要：
- 纸质托书是"输入原文"，TMS 里是"当年人工录入的结果"
- 两者一旦配上，就是一对现成的 (输入, 期望输出)，不需要人工标 300 份
- 配不上的部分，恰恰说明"当年录入不规范"——这本身是给客户的第一个发现

匹配优先级（分越高越可信）：
1.00  委托单号完全一致
0.90  箱号有交集
0.75  客户一致 + 日期相差 ≤3 天
0.60  仅客户一致
0.00  配不上
"""
from __future__ import annotations

import re
from datetime import datetime

from . import thresholds as th

# 阈值运行时可调（A3）


def _norm(s: str | None) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5]", "", (s or "")).upper()


def _containers(v: str | None) -> set[str]:
    if not v:
        return set()
    parts = re.split(r"[,，、;；\s]+", v)
    return {_norm(p) for p in parts if _norm(p)}


def _customer(v: str | None) -> str:
    s = _norm(v)
    for suffix in ("有限公司", "有限责任公司", "物流", "货代", "货运", "国际", "供应链"):
        s = s.replace(suffix, "")
    return s


def _any_date(fields: dict) -> datetime | None:
    for key in ("closing_time", "loading_window"):
        raw = (fields.get(key) or "").strip()
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
        if m:
            try:
                return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                continue
    return None


def score_pair(paper: dict, tms: dict) -> tuple[float, str]:
    pb, tb = _norm(paper.get("booking_no")), _norm(tms.get("booking_no"))
    if pb and tb and pb == tb:
        return 1.0, "委托单号一致"

    pc, tc = _containers(paper.get("container_no")), _containers(tms.get("container_no"))
    if pc and tc and pc & tc:
        return 0.90, "箱号一致"

    pcust, tcust = _customer(paper.get("client")), _customer(tms.get("client"))
    same_cust = bool(pcust) and bool(tcust) and (pcust in tcust or tcust in pcust)

    if same_cust:
        pd, td = _any_date(paper), _any_date(tms)
        if pd and td and abs((pd - td).days) <= 3:
            return 0.75, "客户一致+日期相近"
        return 0.60, "仅客户一致"

    return 0.0, "无共同特征"


def pair(papers: list[dict], tms: list[dict]) -> dict:
    """贪心最佳匹配：先配分最高的，配过的就不再参与。"""
    candidates: list[tuple[float, int, int, str]] = []
    for i, p in enumerate(papers):
        for j, t in enumerate(tms):
            s, why = score_pair(p, t)
            if s > 0:
                candidates.append((s, i, j, why))

    auto_accept = th.get("pairing.auto_accept")
    review_min = th.get("pairing.review_min")
    candidates.sort(key=lambda x: (-x[0], x[1], x[2]))

    used_p: set[int] = set()
    used_t: set[int] = set()
    matched = []
    for s, i, j, why in candidates:
        if i in used_p or j in used_t or s < review_min:
            continue
        used_p.add(i)
        used_t.add(j)
        matched.append({
            "paper_id": papers[i].get("id", i),
            "tms_id": tms[j].get("id", j),
            "score": round(s, 2),
            "reason": why,
            "action": "accept" if s >= auto_accept else "review",
        })

    by_reason: dict[str, int] = {}
    for m in matched:
        by_reason[m["reason"]] = by_reason.get(m["reason"], 0) + 1

    auto = sum(1 for m in matched if m["action"] == "accept")
    review = len(matched) - auto
    total = len(papers)
    return {
        "papers": total,
        "tms_records": len(tms),
        "matched": len(matched),
        "auto_accept": auto,
        "need_review": review,
        "unmatched_papers": [papers[i].get("id", i) for i in range(total) if i not in used_p],
        "unmatched_tms": [tms[j].get("id", j) for j in range(len(tms)) if j not in used_t],
        "pairing_rate": round(len(matched) / total, 4) if total else 0.0,
        "auto_rate": round(auto / total, 4) if total else 0.0,
        "by_reason": by_reason,
        "pairs": matched,
    }
