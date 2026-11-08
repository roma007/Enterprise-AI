"""经营洞察：把毛利、应收、逾期汇总成可执行的结论（规则，不是大模型）。

输入：应收、费用、应收台账。
输出：
- 总览：应收 / 成本 / 毛利 / 未收 / 逾期 / 待分摊
- 结论：亏损单、低毛利、待分摊、逾期客户、最差车辆
- 动作：先核对什么、先催谁、先补什么

边界：
- 全部规则生成，可复现、可审计；不调用大模型。
- 合成演示数据只用于验证汇总逻辑，不代表客户真实经营结论。
"""
from __future__ import annotations

import csv
import io

from . import aging as aging_mod
from . import margin as margin_mod


def _receivables_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["客户", "单号", "应收", "已收", "到期日"])
    for r in rows:
        writer.writerow([r.get("client", ""), r.get("invoice_no", ""),
                         r.get("amount", ""), r.get("paid_amount", ""),
                         r.get("due_date", "")])
    return buf.getvalue()


def build(margin_result: dict, aging_result: dict) -> dict:
    ms = margin_result["summary"]
    asum = aging_result["summary"]
    counts = asum.get("counts") or {}
    insights = []

    if ms["loss"]:
        loss_total = sum(x["profit"] for x in margin_result.get("items", [])
                         if x["flag"] == "亏损")
        insights.append({
            "level": "high",
            "title": f"{ms['loss']} 单亏损",
            "detail": f"亏损合计约 {abs(loss_total):,.0f} 元；先核对成本归集与报价。",
            "action": "打开 /margin，按毛利从低到高逐单核对",
        })
    elif ms["margin"] < margin_result.get("warn_margin", 0.1):
        insights.append({
            "level": "high",
            "title": "整体毛利率低于预警线",
            "detail": f"当前毛利率 {ms['margin']:.1%}，预警线 {margin_result.get('warn_margin', 0.1):.0%}。",
            "action": "先看低毛利订单，再核对费用是否漏录",
        })

    low_only = max(0, ms["low_margin"] - ms["loss"])
    if low_only:
        insights.append({
            "level": "warn",
            "title": f"{low_only} 单低毛利",
            "detail": "毛利为正但低于预警线；可能是报价偏低或成本偏高。",
            "action": "按车辆/线路聚合，确认是否系统性偏低",
        })

    if ms["unallocated"] > 0:
        insights.append({
            "level": "warn",
            "title": f"{ms['unallocated']:,.0f} 元成本未归集",
            "detail": "这部分费用没有落到订单上，当前毛利会被高估。",
            "action": "补录单号或车辆+日期，再重跑毛利",
        })

    if asum.get("total_overdue", 0) > 0:
        top = (aging_result.get("clients") or [{}])[0]
        insights.append({
            "level": "high",
            "title": f"逾期未收 {asum['total_overdue']:,.0f} 元",
            "detail": f"重点催收 {counts.get('重点催收', 0)} 家、催收 {counts.get('催收', 0)} 家；"
                      f"最长逾期 {top.get('max_overdue_days', 0)} 天。",
            "action": f"先催 {top.get('client', '逾期最多的客户')}；话术在 /aging 复制",
        })

    trucks = margin_result.get("trucks") or []
    worst = trucks[0] if trucks else None
    if worst and worst.get("profit", 0) < 0:
        insights.append({
            "level": "warn",
            "title": f"车辆 {worst['truck']} 毛利为负",
            "detail": f"{worst['orders']} 单，毛利 {worst['profit']:,.0f} 元。",
            "action": "核对这台车的维修/油卡是否集中入账",
        })

    if not insights:
        insights.append({
            "level": "ok",
            "title": "当前没有明显异常",
            "detail": "毛利、逾期和成本归集都在阈值内。",
            "action": "继续保持抽样核对",
        })

    loss_orders = sorted([x for x in margin_result.get("items", []) if x["flag"] == "亏损"],
                         key=lambda x: x["profit"])[:5]
    low_orders = sorted([x for x in margin_result.get("items", [])
                         if x["flag"] in ("低毛利", "亏损")],
                        key=lambda x: x["margin"])[:5]
    return {
        "synthetic": bool(margin_result.get("synthetic") or aging_result.get("synthetic")),
        "summary": {
            "revenue": ms["revenue"],
            "cost": ms["cost"],
            "profit": ms["profit"],
            "margin": ms["margin"],
            "orders": ms["orders"],
            "trucks": ms["trucks"],
            "unallocated": ms["unallocated"],
            "receivable": asum.get("total_receivable", 0),
            "outstanding": asum.get("total_outstanding", 0),
            "overdue": asum.get("total_overdue", 0),
            "overdue_ratio": asum.get("overdue_ratio", 0),
            "overdue_clients": counts.get("催收", 0) + counts.get("重点催收", 0),
        },
        "insights": insights,
        "loss_orders": loss_orders,
        "low_margin_orders": low_orders,
        "overdue_clients": (aging_result.get("clients") or [])[:5],
        "warning": "规则汇总，不是大模型结论；" + margin_result.get("warning", "")
                   + " " + aging_result.get("warning", ""),
    }


def analyze(revenue_text: str, cost_text: str, receivables_text: str) -> dict:
    revenue_rows = margin_mod.parse_revenue(revenue_text)
    cost_rows = margin_mod.parse_costs(cost_text)
    receivable_rows = aging_mod.parse_receivables(receivables_text)
    if not revenue_rows:
        raise ValueError("未解析出应收记录")
    if not cost_rows:
        raise ValueError("未解析出费用记录")
    if not receivable_rows:
        raise ValueError("未解析出应收台账")
    m = margin_mod.analyze(revenue_rows, cost_rows)
    a = aging_mod.aging(receivable_rows)
    return build(m, a)


def demo() -> dict:
    d = margin_mod.demo()
    receivables_text = _receivables_csv(aging_mod.demo_rows())
    result = analyze(d["revenue_text"], d["cost_text"], receivables_text)
    result["synthetic"] = True
    result["warning"] = "合成演示数据，不代表真实客户经营结论。" + result["warning"]
    return {
        "revenue_text": d["revenue_text"],
        "cost_text": d["cost_text"],
        "receivables_text": receivables_text,
        "result": result,
    }
