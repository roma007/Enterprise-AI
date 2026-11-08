"""客户/线路盈利分析（B8 演示版）。

边界：合成 24 个月数据；规则/统计，不是生产级 BI。
目标：让老板看到“哪个客户/线路赚钱、风险在哪”，不是堆指标。
"""
from __future__ import annotations

from collections import defaultdict

from .demo_ops import history
from .forecast import customers as risk_customers


def _pct(a: float, b: float) -> float:
    return round(a / b, 4) if b else 0.0


def _trend(values: list[float]) -> float:
    if len(values) < 12:
        return 0.0
    prev, last = sum(values[-12:-6]), sum(values[-6:])
    return round((last - prev) / prev, 4) if prev else 0.0


def demo() -> dict:
    rows = history()
    risk = {x["customer"]: x for x in risk_customers()}
    by_customer: dict[str, dict] = {}
    by_route: dict[str, dict] = {}
    for r in rows:
        name = r["customer"]
        c = by_customer.setdefault(name, {"customer": name, "revenue": 0.0,
                                          "cost": 0.0, "months": [], "routes": set()})
        c["revenue"] += float(r["revenue"])
        c["cost"] += float(r["cost"])
        c["months"].append(float(r["revenue"]))
        c["routes"].add("-".join(r["route"]))
        route = "-".join(r["route"])
        rt = by_route.setdefault(route, {"route": route, "revenue": 0.0,
                                         "cost": 0.0, "months": []})
        rt["revenue"] += float(r["revenue"])
        rt["cost"] += float(r["cost"])
        rt["months"].append(float(r["revenue"]))

    total_rev = sum(c["revenue"] for c in by_customer.values())
    total_cost = sum(c["cost"] for c in by_customer.values())
    customers = []
    for name, c in by_customer.items():
        profit = c["revenue"] - c["cost"]
        customers.append({
            "customer": name,
            "revenue": round(c["revenue"], 0),
            "cost": round(c["cost"], 0),
            "profit": round(profit, 0),
            "margin": _pct(profit, c["revenue"]),
            "share": _pct(c["revenue"], total_rev),
            "trend": _trend(c["months"]),
            "routes": len(c["routes"]),
            "risk_level": risk.get(name, {}).get("risk_level", "—"),
            "risk_score": risk.get(name, {}).get("risk_score", 0),
        })
    customers.sort(key=lambda x: -x["profit"])
    for c in customers:
        if c["profit"] < 0:
            c["tag"] = "亏损客户"
        elif c["margin"] < 0.08:
            c["tag"] = "低毛利"
        elif c["share"] >= 0.15:
            c["tag"] = "高集中"
        elif c["trend"] < -0.1:
            c["tag"] = "收入下滑"
        else:
            c["tag"] = "正常"

    routes = []
    for route, r in by_route.items():
        profit = r["revenue"] - r["cost"]
        routes.append({
            "route": route,
            "revenue": round(r["revenue"], 0),
            "cost": round(r["cost"], 0),
            "profit": round(profit, 0),
            "margin": _pct(profit, r["revenue"]),
            "share": _pct(r["revenue"], total_rev),
            "trend": _trend(r["months"]),
        })
    routes.sort(key=lambda x: -x["profit"])

    top5 = sum(x["revenue"] for x in customers[:5])
    insights = []
    if customers and customers[0]["share"] >= 0.2:
        insights.append({"level": "warn", "title": "客户集中度偏高",
                         "detail": f"最大客户 {customers[0]['customer']} 占收入 {customers[0]['share']:.1%}。",
                         "action": "评估续约/账期风险，准备第二增长客户"})
    loss = [x for x in customers if x["profit"] < 0]
    if loss:
        insights.append({"level": "high", "title": f"{len(loss)} 个客户亏损",
                         "detail": f"合计亏损 {abs(sum(x['profit'] for x in loss)):,.0f} 元。",
                         "action": "逐客户核对报价、成本归集与账期"})
    low = [x for x in customers if 0 <= x["margin"] < 0.08]
    if low:
        insights.append({"level": "warn", "title": f"{len(low)} 个客户低毛利",
                         "detail": "毛利为正但低于 8%。",
                         "action": "优先复核报价与线路成本"})
    if routes:
        best = max(routes, key=lambda x: x["margin"])
        worst = min(routes, key=lambda x: x["margin"])
        insights.append({"level": "ok", "title": "线路差异明显",
                         "detail": f"毛利率最高 {best['route']}（{best['margin']:.1%}）；"
                                   f"最低 {worst['route']}（{worst['margin']:.1%}）。",
                         "action": "把资源向高毛利线路倾斜，低毛利线路重新报价"})
    decline = [x for x in routes if x["trend"] < -0.1]
    if decline:
        insights.append({"level": "warn", "title": f"{len(decline)} 条线路收入下滑",
                         "detail": "近 6 个月收入比前 6 个月下降超过 10%。",
                         "action": "核对客户流失/货量变化，不要只看毛利率"})
    if not insights:
        insights.append({"level": "ok", "title": "客户/线路结构正常",
                         "detail": "未发现明显亏损、低毛利或集中度风险。",
                         "action": "保持月度复盘"})

    profit = total_rev - total_cost
    return {
        "synthetic": True,
        "summary": {
            "customers": len(customers),
            "routes": len(routes),
            "revenue": round(total_rev, 0),
            "cost": round(total_cost, 0),
            "profit": round(profit, 0),
            "margin": _pct(profit, total_rev),
            "top5_share": _pct(top5, total_rev),
            "loss_customers": len(loss),
            "low_margin_customers": len(low),
        },
        "customers": customers,
        "routes": routes,
        "insights": insights,
        "warning": "演示数据；系统计算/统计，不代表客户真实经营结论。",
    }
