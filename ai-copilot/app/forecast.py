"""预测与信用演示（B7）。

边界：
- 合成 24 个月历史；规则/简单统计，不是生产级 ML。
- 输出只用于演示“会是什么样”，不对外承诺准确率。
- 真实预测必须用客户 12–24 个月数据回测。
"""
from __future__ import annotations

from collections import defaultdict

from .demo_ops import history


def _avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _slope(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx, my = _avg(xs), _avg(values)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, values)) / den if den else 0.0


def customers() -> list[dict]:
    rows = history()
    by_customer: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_customer[r["customer"]].append(r)
    out = []
    for name, items in by_customer.items():
        items.sort(key=lambda x: x["month"])
        paid = [float(x["paid_days"]) for x in items]
        overdue = [1.0 if x["overdue"] else 0.0 for x in items]
        revenue = [float(x["revenue"]) for x in items]
        avg_days = _avg(paid)
        overdue_rate = _avg(overdue)
        last_rev = _avg(revenue[-3:])
        outstanding = round(last_rev * 0.35, 2)
        risk = min(100.0, avg_days / 90 * 50 + overdue_rate * 50)
        level = "低" if risk < 35 else ("中" if risk < 60 else "高")
        out.append({
            "customer": name,
            "avg_paid_days": round(avg_days, 1),
            "overdue_rate": round(overdue_rate, 4),
            "monthly_revenue": round(last_rev, 2),
            "outstanding": outstanding,
            "risk_score": round(risk, 1),
            "risk_level": level,
            "expected_days": round(avg_days + overdue_rate * 30, 1),
            "suggestion": ("先对账再催收" if level == "高" else
                           "保持账期，月末提醒" if level == "中" else "常规跟进"),
        })
    out.sort(key=lambda x: -x["risk_score"])
    return out


def routes() -> list[dict]:
    rows = history()
    by_route: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        route = "-".join(r["route"])
        by_route[route][r["month"]].append(float(r["revenue"]))
    out = []
    for route, months in by_route.items():
        keys = sorted(months)[-12:]
        values = [_avg(months[k]) for k in keys]
        slope = _slope(values)
        last = values[-1] if values else 0.0
        forecast = [round(max(0.0, last + slope * i), 0) for i in (1, 2, 3)]
        out.append({
            "route": route,
            "months": keys,
            "revenue": [round(v, 0) for v in values],
            "slope": round(slope, 0),
            "forecast": forecast,
            "trend": "上升" if slope > 500 else ("下降" if slope < -500 else "平稳"),
        })
    out.sort(key=lambda x: -sum(x["revenue"][-3:]))
    return out


def cash_forecast() -> list[dict]:
    cs = customers()
    total = sum(c["outstanding"] for c in cs)
    # 简单分布：按平均回款天数把未收分到未来 4 周
    weights = [0.35, 0.25, 0.2, 0.2]
    return [{"week": f"第 {i + 1} 周", "amount": round(total * w, 0)}
            for i, w in enumerate(weights)]


def demo() -> dict:
    cs = customers()
    rs = routes()
    return {
        "synthetic": True,
        "summary": {
            "customers": len(cs),
            "routes": len(rs),
            "months": 24,
            "high_risk": sum(1 for x in cs if x["risk_level"] == "高"),
            "total_outstanding": round(sum(x["outstanding"] for x in cs), 0),
        },
        "customers": cs,
        "routes": rs[:8],
        "cash": cash_forecast(),
        "warning": "演示数据 + 系统计算/统计；不是生产级预测，不能对外当准确率。",
    }
