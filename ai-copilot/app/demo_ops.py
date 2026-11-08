"""合成运营数据：在途、调度、预测演示用。

边界：全部为合成数据，必须标注「合成演示」，不得对外当真实客户数据。
"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta

from .rules import iso6346_check_digit

AS_OF = date(2026, 11, 8)
CUSTOMERS = [
    "宁波宏运集卡运输有限公司", "海通国际物流", "中远海运物流", "东方国际货运",
    "泰隆国际", "顺捷国际", "宁波港东南物流", "浙江中外运", "上海亚东货代",
    "苏州工业园区物流", "佛山家电出口", "顺德家电制造", "广州华南供应链",
    "深圳盐田货代", "东莞长安电子", "中山灯具出口", "珠海化工物流",
    "江门造纸集团", "肇庆建材城", "惠州电子科技",
]
ROUTES = [
    ("北滘", "盐田"), ("北滘", "蛇口"), ("顺德", "南沙"), ("北滘", "香港"),
    ("佛山", "盐田"), ("东莞", "蛇口"), ("广州", "南沙"), ("中山", "盐田"),
]
VESSELS = [
    "COSCO ARIES / 042E", "EVER GIVEN / 118W", "MAERSK EDINBURGH / 152E",
    "ONE APUS / 023E", "MSC ISABELLA / 210W", "OOCL HONG KONG / 088E",
    "CMA CGM RIVIERA / 305W", "HAPAG BERLIN / 077E",
]
STATUSES = ["已提箱", "已装柜", "已进港", "报关中", "已放行", "已装船", "已到港"]
def _truck_id(i: int) -> str:
    return f"粤B{10000 + i * 137 % 89999:05d}"


TRUCKS = [_truck_id(i) for i in range(30)]
COORDS = {
    "北滘": (23.00, 113.20), "顺德": (22.84, 113.29), "佛山": (23.02, 113.12),
    "盐田": (22.58, 114.24), "蛇口": (22.48, 113.92), "南沙": (22.75, 113.60),
    "香港": (22.30, 114.17), "东莞": (23.02, 113.75), "广州": (23.13, 113.26),
    "中山": (22.52, 113.39),
}


def _container(rnd: random.Random) -> str:
    prefix = "".join(rnd.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3)) + "U"
    serial = f"{rnd.randint(100000, 999999):06d}"
    return prefix + serial + str(iso6346_check_digit(prefix + serial + "0"))


def _dist(a: str, b: str) -> float:
    x1, y1 = COORDS.get(a, (23.0, 113.2))
    x2, y2 = COORDS.get(b, (23.0, 113.2))
    return round(math.hypot(x1 - x2, y1 - y2) * 111 * 1.15, 1)


def shipments(count: int = 120) -> list[dict]:
    rnd = random.Random(20261108)
    out = []
    for i in range(count):
        customer = CUSTOMERS[i % len(CUSTOMERS)]
        frm, to = ROUTES[i % len(ROUTES)]
        booking = f"SYN2026{i + 1:04d}"
        box = _container(rnd)
        status = STATUSES[min(len(STATUSES) - 1, (i * 7) % len(STATUSES) + rnd.randint(0, 1))]
        etd = AS_OF - timedelta(days=rnd.randint(-3, 10))
        eta = etd + timedelta(days=rnd.choice([1, 1, 2, 3]))
        delayed = rnd.random() < 0.18
        if status != "已到港" and eta <= AS_OF:
            eta = AS_OF + timedelta(days=rnd.randint(1, 3))
        timeline = [
            {"ts": f"{AS_OF - timedelta(days=2)} 08:30", "event": "提箱", "place": f"{frm}堆场"},
            {"ts": f"{AS_OF - timedelta(days=2)} 11:10", "event": "装柜", "place": "工厂"},
            {"ts": f"{AS_OF - timedelta(days=1)} 15:40", "event": "进港", "place": f"{to}港区"},
            {"ts": f"{AS_OF} 09:20", "event": "报关", "place": "口岸"},
        ]
        if status in ("已放行", "已装船", "已到港"):
            timeline.append({"ts": f"{AS_OF} 11:05", "event": "放行", "place": "海关"})
        if status in ("已装船", "已到港"):
            timeline.append({"ts": f"{etd} 18:00", "event": "装船", "place": f"{to}港"})
        if status == "已到港":
            timeline.append({"ts": f"{eta} 07:30", "event": "到港", "place": "目的港"})
        out.append({
            "booking_no": booking, "container_no": box, "customer": customer,
            "route": f"{frm}-{to}", "from": frm, "to": to,
            "vessel": VESSELS[i % len(VESSELS)], "status": status,
            "etd": etd.isoformat(), "eta": eta.isoformat(),
            "customs_status": "已放行" if status in ("已放行", "已装船", "已到港") else "报关中",
            "delay_hours": rnd.choice([0, 0, 0, 4, 8, 12, 24]) if delayed else 0,
            "delay_reason": "截港提前/驳船衔接" if delayed else "",
            "truck": TRUCKS[i % len(TRUCKS)],
            "timeline": timeline,
            "last_event": timeline[-1],
        })
    return out


def vehicles(count: int = 30) -> list[dict]:
    rnd = random.Random(11)
    out = []
    for i in range(count):
        truck = _truck_id(i)
        out.append({
            "truck": truck, "capacity_teu": rnd.choice([1, 1, 1, 2]),
            "cost_per_km": rnd.choice([4.2, 4.5, 4.8, 5.0]),
            "start": rnd.choice(["北滘", "顺德", "佛山", "东莞", "广州"]),
            "available": True,
        })
    return out


def orders(count: int = 160) -> list[dict]:
    rnd = random.Random(22)
    out = []
    for i in range(count):
        frm, to = ROUTES[i % len(ROUTES)]
        ready = datetime(2026, 11, 8, 8) + timedelta(hours=rnd.randint(0, 36))
        due = ready + timedelta(hours=rnd.choice([6, 8, 10, 12]))
        out.append({
            "order_no": f"ORD{i + 1:04d}",
            "customer": CUSTOMERS[i % len(CUSTOMERS)],
            "from": frm, "to": to,
            "container_type": rnd.choice(["20GP", "40GP", "40HQ"]),
            "qty": rnd.choice([1, 1, 1, 2]),
            "ready": ready.isoformat(timespec="minutes"),
            "due": due.isoformat(timespec="minutes"),
            "revenue": rnd.choice([1800, 2200, 2600, 3000, 3400]),
            "volume_cbm": round(rnd.uniform(8, 55), 1),
            "weight_t": round(rnd.uniform(2, 24), 1),
        })
    return out


def history() -> list[dict]:
    rnd = random.Random(33)
    out = []
    for cidx, customer in enumerate(CUSTOMERS):
        base_days = rnd.randint(25, 110)
        base_rev = rnd.randint(60000, 280000)
        base_cost = base_rev * rnd.uniform(0.75, 0.9)
        overdue_rate = rnd.uniform(0.02, 0.25)
        for m in range(24):
            month = (AS_OF.replace(day=1) - timedelta(days=30 * (23 - m))).strftime("%Y-%m")
            revenue = base_rev * rnd.uniform(0.75, 1.25)
            cost = base_cost * rnd.uniform(0.9, 1.1)
            paid_days = max(5, int(rnd.gauss(base_days, 8)))
            out.append({
                "month": month, "customer": customer,
                "revenue": round(revenue, 2), "cost": round(cost, 2),
                "paid_days": paid_days,
                "overdue": rnd.random() < overdue_rate,
                "quote_win": rnd.random() < rnd.uniform(0.55, 0.9),
                "route": ROUTES[cidx % len(ROUTES)],
            })
    return out


def summary() -> dict:
    ships = shipments()
    return {
        "as_of": AS_OF.isoformat(),
        "shipments": len(ships),
        "customers": len(CUSTOMERS),
        "trucks": len(TRUCKS),
        "orders": len(orders()),
        "history_months": 24,
        "warning": "演示数据，不代表真实客户。",
    }
