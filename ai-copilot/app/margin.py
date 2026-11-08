"""成本归集与单车毛利（C1 的通用计算部分）。

问题：油卡、路桥、维修各一套账；月底想知道“哪台车、哪一单真的赚钱”，
但费用和运单对不上，只能拍脑袋。

做法（规则，不用模型）：
1. 费用优先按单号归集；
2. 没单号时，按“车辆 + 日期 ± N 天”找唯一订单；
3. 还是找不到 → 进入「待分摊」，并在结果里明确提示毛利会被高估。

边界：
- 这是通用计算，不代表任何客户真实口径；科目映射、车辆/单号规则要客户确认。
- 合成演示数据必须标明“合成”，不能对外当真实毛利。
"""
from __future__ import annotations

import csv
import io
import random
import re
from datetime import date, datetime
from decimal import Decimal

from . import thresholds as th
from .settlement import _dec, _parse

_REVENUE_HINTS = {
    "date": ("日期", "业务日期", "开票日期", "date"),
    "order_no": ("单号", "运单号", "委托单号", "订单号", "order"),
    "truck": ("车辆", "车牌", "车号", "truck"),
    "client": ("客户", "货主", "client"),
    "revenue": ("应收", "收入", "运费", "revenue"),
}
_COST_HINTS = {
    "date": ("日期", "费用日期", "date"),
    "truck": ("车辆", "车牌", "车号", "truck"),
    "order_no": ("单号", "运单号", "委托单号", "订单号", "order"),
    "category": ("科目", "费用类型", "类别", "category"),
    "amount": ("金额", "费用", "支出", "amount"),
}


def parse_revenue(text: str) -> list[dict]:
    return _parse(text, _REVENUE_HINTS)


def parse_costs(text: str) -> list[dict]:
    return _parse(text, _COST_HINTS)


def _day(value: str) -> date | None:
    text = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%m-%d", "%m/%d"):
        try:
            dt = datetime.strptime(text, fmt)
            if fmt in ("%m-%d", "%m/%d"):
                dt = dt.replace(year=datetime.now().year)
            return dt.date()
        except ValueError:
            continue
    return None


def _money(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01")))


def analyze(revenue_rows: list[dict], cost_rows: list[dict],
            match_days: int | None = None,
            warn_margin: float | None = None) -> dict:
    match_days = int(th.get("margin.match_days") if match_days is None else match_days)
    warn_margin = float(th.get("margin.warn_margin") if warn_margin is None else warn_margin)

    orders: dict[str, dict] = {}
    for row in revenue_rows:
        order_no = (row.get("order_no") or "").strip()
        if not order_no:
            continue
        revenue = _dec(row.get("revenue")) or Decimal("0")
        item = orders.setdefault(order_no, {
            "order_no": order_no,
            "date": _day(row.get("date") or ""),
            "truck": (row.get("truck") or "").strip(),
            "client": (row.get("client") or "").strip(),
            "revenue": Decimal("0"),
            "cost": Decimal("0"),
        })
        item["revenue"] += revenue
        item["truck"] = item["truck"] or (row.get("truck") or "").strip()
        item["client"] = item["client"] or (row.get("client") or "").strip()
        item["date"] = item["date"] or _day(row.get("date") or "")

    allocated: dict[str, Decimal] = {k: Decimal("0") for k in orders}
    unallocated: list[dict] = []
    for row in cost_rows:
        amount = _dec(row.get("amount"))
        if amount is None:
            continue
        order_no = (row.get("order_no") or "").strip()
        truck = (row.get("truck") or "").strip()
        day = _day(row.get("date") or "")
        target = order_no if order_no in orders else ""

        if not target and truck and day:
            candidates = [
                o for o in orders.values()
                if o["truck"] and o["truck"].upper() == truck.upper()
                and o["date"] and abs((o["date"] - day).days) <= match_days
            ]
            if candidates:
                candidates.sort(key=lambda o: abs((o["date"] - day).days))
                nearest = abs((candidates[0]["date"] - day).days)
                unique = [o for o in candidates if abs((o["date"] - day).days) == nearest]
                if len(unique) == 1:
                    target = unique[0]["order_no"]

        if target:
            allocated[target] += amount
        else:
            unallocated.append({
                "date": day.isoformat() if day else "",
                "truck": truck,
                "category": (row.get("category") or "").strip(),
                "amount": _money(amount),
                "reason": "无单号且无法按车辆+日期匹配",
            })

    items = []
    for order_no, o in orders.items():
        cost = allocated.get(order_no, Decimal("0"))
        profit = o["revenue"] - cost
        margin = (profit / o["revenue"]) if o["revenue"] > 0 else Decimal("0")
        if cost == 0:
            flag = "无成本记录"
        elif profit < 0:
            flag = "亏损"
        elif float(margin) < warn_margin:
            flag = "低毛利"
        else:
            flag = "正常"
        items.append({
            "order_no": order_no,
            "date": o["date"].isoformat() if o["date"] else "",
            "truck": o["truck"],
            "client": o["client"],
            "revenue": _money(o["revenue"]),
            "cost": _money(cost),
            "profit": _money(profit),
            "margin": round(float(margin), 4),
            "flag": flag,
        })
    items.sort(key=lambda x: (x["date"], x["order_no"]))

    trucks: dict[str, dict] = {}
    for item in items:
        truck = item["truck"] or "未填车辆"
        t = trucks.setdefault(truck, {"truck": truck, "orders": 0,
                                      "revenue": 0.0, "cost": 0.0, "profit": 0.0})
        t["orders"] += 1
        t["revenue"] += item["revenue"]
        t["cost"] += item["cost"]
        t["profit"] += item["profit"]
    for t in trucks.values():
        t["margin"] = round(t["profit"] / t["revenue"], 4) if t["revenue"] else 0.0
    truck_rows = sorted(trucks.values(), key=lambda x: x["profit"])

    total_revenue = sum((Decimal(str(i["revenue"])) for i in items), Decimal("0"))
    total_cost = sum((Decimal(str(i["cost"])) for i in items), Decimal("0"))
    unallocated_amount = sum((Decimal(str(x["amount"])) for x in unallocated), Decimal("0"))
    profit = total_revenue - total_cost
    warning = (
        "成本归集顺序：单号 → 车辆+日期±{} 天；未匹配进入待分摊。"
        "本页是通用计算，科目与车辆规则仍需客户确认。".format(match_days)
    )
    if unallocated_amount > 0:
        warning += f" 当前有 {_money(unallocated_amount):,.0f} 元成本未归集，毛利会被高估。"

    return {
        "synthetic": False,
        "match_days": match_days,
        "warn_margin": warn_margin,
        "summary": {
            "orders": len(items),
            "trucks": len(truck_rows),
            "revenue": _money(total_revenue),
            "cost": _money(total_cost),
            "profit": _money(profit),
            "margin": round(float(profit / total_revenue), 4) if total_revenue > 0 else 0.0,
            "unallocated": _money(unallocated_amount),
            "low_margin": sum(1 for i in items if i["flag"] in ("低毛利", "亏损")),
            "loss": sum(1 for i in items if i["flag"] == "亏损"),
        },
        "items": items,
        "trucks": truck_rows,
        "unallocated_items": unallocated,
        "warning": warning,
    }


def _csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def demo() -> dict:
    rnd = random.Random(20261108)
    trucks = ["浙B12345", "浙B23456", "浙B34567", "浙B45678", "浙B56789", "浙B67890"]
    clients = ["宁波宏运", "海通国际", "中远海运", "东方国际"]
    revenue_rows = []
    cost_rows = []
    orders = []
    for i in range(24):
        day = 1 + i // 2
        order_no = f"DEMO-{i + 1:03d}"
        truck = rnd.choice(trucks)
        client = rnd.choice(clients)
        revenue = rnd.choice([1800, 2200, 2600, 3000, 3400, 3800, 4200, 4800])
        orders.append((f"2026-11-{day:02d}", order_no, truck, client, revenue))
        revenue_rows.append([f"2026-11-{day:02d}", order_no, truck, client, revenue])
        fuel = rnd.randint(280, 720)
        toll = rnd.randint(80, 260)
        cost_rows.append([f"2026-11-{day:02d}", truck, order_no, "燃油", fuel])
        cost_rows.append([f"2026-11-{day:02d}", truck, order_no, "路桥", toll])
        if i % 5 == 0:
            cost_rows.append([f"2026-11-{day:02d}", truck, "", "维修", rnd.randint(600, 1500)])

    # 制造两个明显案例：一个亏损、一个低毛利
    revenue_rows[0][4] = 1200
    cost_rows.append(["2026-11-01", revenue_rows[0][2], revenue_rows[0][1], "临时加急", 900])
    revenue_rows[1][4] = 2000

    # 一条完全无法归集的费用
    cost_rows.append(["2026-11-20", "", "", "停车费", 150])

    revenue_text = _csv(["日期", "单号", "车辆", "客户", "应收"], revenue_rows)
    cost_text = _csv(["日期", "车辆", "单号", "科目", "金额"], cost_rows)
    result = analyze(parse_revenue(revenue_text), parse_costs(cost_text))
    result["synthetic"] = True
    result["warning"] = "演示数据，不代表真实客户毛利。" + result["warning"]
    return {"revenue_text": revenue_text, "cost_text": cost_text, "result": result}


def export_csv(result: dict) -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(["订单毛利"])
    writer.writerow(["日期", "单号", "车辆", "客户", "应收", "成本", "毛利", "毛利率", "标记"])
    for x in result["items"]:
        writer.writerow([x["date"], x["order_no"], x["truck"], x["client"],
                         x["revenue"], x["cost"], x["profit"],
                         f'{x["margin"]*100:.1f}%', x["flag"]])
    writer.writerow([])
    writer.writerow(["车辆汇总"])
    writer.writerow(["车辆", "单数", "应收", "成本", "毛利", "毛利率"])
    for t in result["trucks"]:
        writer.writerow([t["truck"], t["orders"], t["revenue"], t["cost"],
                         t["profit"], f'{t["margin"]*100:.1f}%'])
    writer.writerow([])
    writer.writerow(["待分摊成本"])
    writer.writerow(["日期", "车辆", "科目", "金额", "原因"])
    for x in result["unallocated_items"]:
        writer.writerow([x["date"], x["truck"], x["category"], x["amount"], x["reason"]])
    return buf.getvalue()
