"""报价助手（AI-45）。

边界：
- 报价数字由历史价格 + 成本 + 目标毛利规则计算，不由模型生成。
- 模型只做两件事：从自由文本里补全线路/箱型；用规则算出的数字写一段解释。
- 历史价格是合成演示；真实报价必须接客户价格表。
- 不自动对外报价、不自动锁舱。
"""
from __future__ import annotations

import json
import re
import statistics
from datetime import date

from . import llm
from . import thresholds as th
from .config import settings

_TYPES = ("20GP", "40GP", "40HQ", "45HQ", "20RF", "40RF", "45RF",
          "20OT", "40OT", "20FR", "40FR")
_ROUTE_RE = re.compile(
    r"(?:从|由)?\s*([\u4e00-\u9fffA-Za-z]{2,10})\s*(?:到|至|—|-|→)\s*([\u4e00-\u9fffA-Za-z]{2,10})"
)
_QTY_RE = re.compile(r"(\d+|[一二两三四五六七八九十])\s*(?:个|条|柜|箱|台)")
_CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_CARGO = ("家电", "家具", "服装", "塑料", "钢材", "食品", "机械",
          "化工", "纸品", "汽车配件", "陶瓷", "建材")

# 合成演示价格：不是客户真实报价
_HISTORY = [
    {"date": "2026-08-03", "route": "北滘-盐田", "container_type": "40HQ", "cost": 1650, "quote": 2100},
    {"date": "2026-08-18", "route": "北滘-盐田", "container_type": "40HQ", "cost": 1700, "quote": 2150},
    {"date": "2026-09-02", "route": "北滘-盐田", "container_type": "40HQ", "cost": 1750, "quote": 2200},
    {"date": "2026-09-21", "route": "北滘-盐田", "container_type": "40HQ", "cost": 1800, "quote": 2300},
    {"date": "2026-10-08", "route": "北滘-盐田", "container_type": "40HQ", "cost": 1850, "quote": 2350},
    {"date": "2026-08-06", "route": "北滘-盐田", "container_type": "40GP", "cost": 1450, "quote": 1850},
    {"date": "2026-09-09", "route": "北滘-盐田", "container_type": "40GP", "cost": 1500, "quote": 1900},
    {"date": "2026-10-11", "route": "北滘-盐田", "container_type": "40GP", "cost": 1520, "quote": 1950},
    {"date": "2026-08-12", "route": "北滘-蛇口", "container_type": "40HQ", "cost": 1700, "quote": 2200},
    {"date": "2026-09-15", "route": "北滘-蛇口", "container_type": "40HQ", "cost": 1750, "quote": 2250},
    {"date": "2026-10-20", "route": "北滘-蛇口", "container_type": "40HQ", "cost": 1800, "quote": 2300},
    {"date": "2026-08-22", "route": "顺德-南沙", "container_type": "20GP", "cost": 900, "quote": 1250},
    {"date": "2026-09-26", "route": "顺德-南沙", "container_type": "20GP", "cost": 950, "quote": 1300},
    {"date": "2026-10-28", "route": "顺德-南沙", "container_type": "20GP", "cost": 980, "quote": 1350},
    {"date": "2026-09-01", "route": "北滘-香港", "container_type": "40HQ", "cost": 2400, "quote": 3100},
    {"date": "2026-10-02", "route": "北滘-香港", "container_type": "40HQ", "cost": 2500, "quote": 3200},
    {"date": "2026-09-18", "route": "佛山-盐田", "container_type": "40HQ", "cost": 1900, "quote": 2450},
    {"date": "2026-10-18", "route": "佛山-盐田", "container_type": "40HQ", "cost": 1950, "quote": 2500},
]


def history() -> list[dict]:
    return [dict(x) for x in _HISTORY]


def parse_inquiry(text: str, use_llm: bool = True) -> dict:
    text = (text or "").strip()
    route = ""
    m = _ROUTE_RE.search(text)
    if m:
        route = f"{m.group(1).strip()}-{m.group(2).strip()}"
    ctype = next((t for t in _TYPES if t.lower() in text.lower()), "")
    qty_m = _QTY_RE.search(text)
    qty = 1
    if qty_m:
        raw = qty_m.group(1)
        qty = int(raw) if raw.isdigit() else _CN_NUM.get(raw, 1)
    urgent = any(x in text for x in ("急", "今天", "明天", "周五", "尽快", "加急"))
    cargo = next((x for x in _CARGO if x in text), "")
    cargo_m = re.search(r"(?:货|品名)[:：]?\s*([\u4e00-\u9fffA-Za-z0-9]{2,20})", text)
    if cargo_m:
        cargo = cargo_m.group(1)

    if use_llm and settings.llm_enabled and (not route or not ctype):
        res = llm.chat_json(
            "从询价文本中抽线路和箱型。只输出 JSON："
            '{"route":"起点-终点","container_type":"40HQ","qty":1,"cargo":"","urgent":false}。'
            "不确定就留空，不得编造。",
            text[:1000],
        )
        if res.ok:
            data = llm.parse_json_loose(res.text)
            if isinstance(data, dict):
                llm_route = str(data.get("route") or "").strip()
                if not route and llm_route and all(
                        p.strip() and p.strip() in text for p in llm_route.split("-", 1)):
                    route = llm_route
                llm_type = str(data.get("container_type") or "").strip().upper()
                if not ctype and llm_type in _TYPES:
                    ctype = llm_type
                try:
                    qty = int(data.get("qty") or qty) if not qty_m else qty
                except (TypeError, ValueError):
                    pass
                cargo = cargo or str(data.get("cargo") or "").strip()[:30]
                urgent = urgent or bool(data.get("urgent"))
    return {"raw": text, "route": route, "container_type": ctype,
            "qty": max(1, qty), "cargo": cargo, "urgent": urgent}


def _median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def _rule_explanation(pricing: dict, stats: dict, target: float) -> str:
    if not stats["count"]:
        return "没有找到同线路同箱型的历史报价；建议先按成本表手工核价，再报价。"
    return (
        f"按同线路同箱型 {stats['count']} 条历史报价："
        f"市场中位价 {stats['quote_median']:,.0f} 元，成本中位 {stats['cost_median']:,.0f} 元，"
        f"历史毛利率 {stats['margin_median']:.1%}。"
        f"目标毛利 {target:.0%}，成本底线 {pricing['floor']:,.0f} 元；"
        f"建议报价 {pricing['recommended']:,.0f} 元，"
        f"对应毛利率 {pricing['margin_at_recommended']:.1%}。"
    )


def _llm_explanation(pricing: dict, stats: dict, target: float) -> tuple[str, str]:
    rule = _rule_explanation(pricing, stats, target)
    if not settings.llm_enabled:
        return rule, "rule"
    facts = {
        "count": stats["count"], "quote_median": stats["quote_median"],
        "cost_median": stats["cost_median"], "margin_median": stats["margin_median"],
        "floor": pricing["floor"], "recommended": pricing["recommended"],
        "target_margin": target,
    }
    res = llm.chat_json(
        "你是货代报价助手。只能根据给定事实写一段简短报价说明，不得新增数字、不得承诺舱位。"
        '只输出 JSON：{"explanation":"..."}',
        json.dumps(facts, ensure_ascii=False),
    )
    if not res.ok:
        return rule, "rule"
    data = llm.parse_json_loose(res.text)
    text = str((data or {}).get("explanation") or "").strip()
    if not text:
        return rule, "rule"
    def _num(v) -> str:
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return f"{v:g}" if isinstance(v, (int, float)) else str(v)

    allowed = {re.sub(r"[,%]", "", _num(v)) for v in facts.values()}
    for v in facts.values():
        if isinstance(v, (int, float)) and 0 < v < 1:
            for fmt in ("g", ".2f", ".1f", ".0f"):
                allowed.add(re.sub(r"[,%]", "", format(v * 100, fmt)))
    used = {re.sub(r"[,%]", "", x) for x in re.findall(r"\d[\d,]*(?:\.\d+)?%?", text)}
    if used - allowed:
        return rule, "rule"
    return text[:300], "llm"


def quote(text: str, use_llm: bool = True) -> dict:
    inquiry = parse_inquiry(text, use_llm=use_llm)
    if not inquiry["route"] or not inquiry["container_type"]:
        raise ValueError("没能识别线路或箱型；请写成「北滘到盐田，40HQ」这样")
    target = float(th.get("quote.target_margin"))
    min_samples = int(th.get("quote.min_samples"))

    rows = [x for x in _HISTORY
            if x["route"] == inquiry["route"] and x["container_type"] == inquiry["container_type"]]
    scope = "同线路+同箱型"
    if len(rows) < min_samples:
        more = [x for x in _HISTORY if x["route"] == inquiry["route"]]
        if len(more) > len(rows):
            rows, scope = more, "同线路（箱型样本不足）"

    quotes = [float(x["quote"]) for x in rows]
    costs = [float(x["cost"]) for x in rows]
    stats = {
        "count": len(rows), "scope": scope,
        "quote_min": min(quotes) if quotes else 0.0,
        "quote_max": max(quotes) if quotes else 0.0,
        "quote_median": _median(quotes),
        "cost_median": _median(costs),
        "margin_median": (_median(quotes) - _median(costs)) / _median(quotes)
        if _median(quotes) else 0.0,
    }
    cost = stats["cost_median"]
    floor = cost * (1 + target)
    market = stats["quote_median"]
    recommended = max(floor, min(market, floor * 1.15)) if market else floor
    margin_at = (recommended - cost) / recommended if recommended else 0.0

    risks = []
    if not rows:
        risks.append("没有历史价格，建议先人工核价")
    elif stats["count"] < min_samples:
        risks.append(f"历史样本只有 {stats['count']} 条，参考性有限")
    if market and market < floor:
        risks.append("市场价低于成本底线，按目标毛利报价可能丢单")
    if inquiry["urgent"]:
        risks.append("客户急单，注意舱位/车辆可用性，不要承诺时效")
    if scope != "同线路+同箱型":
        risks.append("箱型样本不足，已放宽到同线路")

    pricing = {"cost": round(cost, 2), "floor": round(floor, 2),
               "recommended": round(recommended, 2),
               "margin_at_recommended": round(margin_at, 4),
               "target_margin": target}
    explanation, engine = _llm_explanation(pricing, stats, target)
    return {
        "synthetic": True,
        "inquiry": inquiry,
        "stats": {k: (round(v, 4) if isinstance(v, float) else v)
                  for k, v in stats.items()},
        "pricing": pricing,
        "risks": risks,
        "explanation": explanation,
        "engine": engine,
        "samples": rows[-6:],
        "warning": "演示价格，不代表真实客户报价；报价前必须用客户价格表重算。",
    }


def demo() -> dict:
    text = "北滘到盐田，40HQ，2 个柜，家电，周五要装"
    return {"text": text, "history": history(), "result": quote(text, use_llm=False)}
