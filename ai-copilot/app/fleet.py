"""车队能源与线路决策演示：公开资料 + 合成运营数据。

回答客户最关心的四个问题：
1. 同一条线路，油车/电车、大马力/小马力，单箱成本差多少？
2. 哪些线路适合电动车，哪些受续航/补能限制？
3. 哪些环节的重复工时最多，能先减哪一段？
4. 空驶、路桥、能源、人力，成本到底花在哪？

边界：
- 运营数据是合成的；成本参数是示例假设，不是客户真实报价。
- 只做规则/统计测算；AI 只写简报、排序和动作草稿，不改数。
- 公开资料来自 `xiefeng_public` 缓存，只用于会前研究，不对外发送。
"""
from __future__ import annotations

import random
from collections import defaultdict

from . import xiefeng_public

SEED = 20261112
MONTHS = ("2026-08", "2026-09", "2026-10")
TOLL_PER_KM = 2.0
DRIVER_PER_HOUR = 55.0
HANDLING_PER_TRIP = 160.0
SERVICE_HOURS = 1.2

ROUTES = [
    {"route": "北滘港 → 南沙港", "distance_km": 78, "rate_per_teu": 520,
     "charging": True, "note": "短途、可当天往返；补能条件相对好"},
    {"route": "北滘港 → 蛇口港", "distance_km": 145, "rate_per_teu": 680,
     "charging": True, "note": "中途线路；需确认港口/途中补能"},
    {"route": "北滘港 → 盐田港", "distance_km": 178, "rate_per_teu": 760,
     "charging": False, "note": "长途线路；电动重卡续航与补能是硬约束"},
]

VEHICLES = [
    {"vehicle": "柴油重卡 · 大马力", "energy": "柴油", "hp": 560, "fleet": 18,
     "consumption": 38.0, "unit": "L/100km", "price": 7.2, "maint_per_km": 0.35,
     "speed": 48, "range_km": 800},
    {"vehicle": "柴油重卡 · 小马力", "energy": "柴油", "hp": 420, "fleet": 12,
     "consumption": 31.0, "unit": "L/100km", "price": 7.2, "maint_per_km": 0.30,
     "speed": 42, "range_km": 800},
    {"vehicle": "LNG重卡 · 大马力", "energy": "LNG", "hp": 500, "fleet": 6,
     "consumption": 30.0, "unit": "kg/100km", "price": 5.4, "maint_per_km": 0.32,
     "speed": 46, "range_km": 700},
    {"vehicle": "电动重卡 · 490马力", "energy": "电", "hp": 490, "fleet": 4,
     "consumption": 150.0, "unit": "kWh/100km", "price": 0.65, "maint_per_km": 0.18,
     "speed": 45, "range_km": 220},
]

LABOR_TASKS = [
    {"task": "接单 / 托书录入", "hours": 320, "people": 4, "potential": 0.60,
     "mode": "可自动", "detail": "OCR + 规则抽取 + 人工确认；托书/订舱委托先结构化"},
    {"task": "单证 / 报关资料", "hours": 280, "people": 3, "potential": 0.40,
     "mode": "人机复核", "detail": "单证一致性与缺项提示；报关归类仍由报关员确认"},
    {"task": "调度 / 派车", "hours": 240, "people": 3, "potential": 0.30,
     "mode": "人机复核", "detail": "先做空驶/时间窗提示；派车决定仍由调度员拍板"},
    {"task": "装卸 / 现场", "hours": 420, "people": 6, "potential": 0.05,
     "mode": "需人工", "detail": "现场协调、异常处理、客户沟通为主，短期不适合自动化"},
    {"task": "在途跟踪", "hours": 180, "people": 2, "potential": 0.55,
     "mode": "可自动", "detail": "聊天事件抽取 + 状态查询；异常升级到人"},
    {"task": "对账 / 结算", "hours": 260, "people": 3, "potential": 0.45,
     "mode": "人机复核", "detail": "规则匹配 + 差异解释；差异处理与确认由财务做"},
    {"task": "应收 / 催收", "hours": 120, "people": 1.5, "potential": 0.50,
     "mode": "可自动", "detail": "账龄分档、催收优先级、话术草稿；发送前人工确认"},
]


def _pct(a: float, b: float) -> float:
    return round(a / b, 4) if b else 0.0


def _money(value: float) -> float:
    return round(float(value), 0)


def _trip_rows() -> list[dict]:
    rng = random.Random(SEED)
    rows: list[dict] = []
    trip_no = 0
    for route in ROUTES:
        for vehicle in VEHICLES:
            # 每台车每月在这条线跑 1 趟；3 个月 × 3 条线 = 每车 9 趟
            count = max(1, int(vehicle["fleet"] * len(MONTHS)))
            for i in range(count):
                trip_no += 1
                empty_km = round(rng.uniform(6, 26), 1)
                load_teu = 2 if rng.random() > 0.06 else 1
                total_km = route["distance_km"] + empty_km
                energy_cost = total_km / 100 * vehicle["consumption"] * vehicle["price"]
                toll = total_km * TOLL_PER_KM
                maintenance = total_km * vehicle["maint_per_km"]
                hours = total_km / vehicle["speed"] + SERVICE_HOURS
                driver = hours * DRIVER_PER_HOUR
                handling = HANDLING_PER_TRIP
                cost = energy_cost + toll + maintenance + driver + handling
                revenue = route["rate_per_teu"] * load_teu
                rows.append({
                    "trip_id": f"T{trip_no:04d}",
                    "month": MONTHS[i % len(MONTHS)],
                    "route": route["route"],
                    "distance_km": route["distance_km"],
                    "vehicle": vehicle["vehicle"],
                    "energy": vehicle["energy"],
                    "hp": vehicle["hp"],
                    "fleet": vehicle["fleet"],
                    "load_teu": load_teu,
                    "empty_km": empty_km,
                    "total_km": round(total_km, 1),
                    "energy_cost": round(energy_cost, 2),
                    "toll": round(toll, 2),
                    "maintenance": round(maintenance, 2),
                    "driver": round(driver, 2),
                    "handling": handling,
                    "cost": round(cost, 2),
                    "revenue": revenue,
                    "profit": round(revenue - cost, 2),
                    "margin": _pct(revenue - cost, revenue),
                })
    return rows


def _aggregate(rows: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    by_route: dict[str, dict] = {}
    by_vehicle: dict[str, dict] = {}
    by_pair: dict[tuple[str, str], dict] = {}

    for r in rows:
        for bucket, key in ((by_route, r["route"]), (by_vehicle, r["vehicle"]),
                            (by_pair, (r["route"], r["vehicle"]))):
            item = bucket.setdefault(key, {
                "trips": 0, "teu": 0, "revenue": 0.0, "cost": 0.0,
                "energy_cost": 0.0, "toll": 0.0, "maintenance": 0.0,
                "driver": 0.0, "handling": 0.0, "empty_km": 0.0, "total_km": 0.0,
                "profit": 0.0,
            })
            item["trips"] += 1
            item["teu"] += r["load_teu"]
            for field in ("revenue", "cost", "energy_cost", "toll", "maintenance",
                          "driver", "handling", "empty_km", "total_km", "profit"):
                item[field] += r[field]

    routes = []
    for route in ROUTES:
        a = by_route[route["route"]]
        routes.append({
            "route": route["route"],
            "distance_km": route["distance_km"],
            "trips": a["trips"],
            "teu": a["teu"],
            "revenue": _money(a["revenue"]),
            "cost": _money(a["cost"]),
            "profit": _money(a["profit"]),
            "margin": _pct(a["profit"], a["revenue"]),
            "energy_cost": _money(a["energy_cost"]),
            "cost_per_teu": _money(a["cost"] / a["teu"]) if a["teu"] else 0,
            "empty_ratio": _pct(a["empty_km"], a["total_km"]),
        })

    vehicles = []
    for vehicle in VEHICLES:
        a = by_vehicle[vehicle["vehicle"]]
        vehicles.append({
            "vehicle": vehicle["vehicle"],
            "energy": vehicle["energy"],
            "hp": vehicle["hp"],
            "fleet": vehicle["fleet"],
            "trips": a["trips"],
            "cost_per_trip": _money(a["cost"] / a["trips"]) if a["trips"] else 0,
            "cost_per_teu": _money(a["cost"] / a["teu"]) if a["teu"] else 0,
            "energy_cost_per_trip": _money(a["energy_cost"] / a["trips"]) if a["trips"] else 0,
            "energy_share": _pct(a["energy_cost"], a["cost"]),
            "margin": _pct(a["profit"], a["revenue"]),
            "empty_ratio": _pct(a["empty_km"], a["total_km"]),
        })

    pairs = []
    for route in ROUTES:
        base = by_pair[(route["route"], "柴油重卡 · 大马力")]
        base_per_teu = base["cost"] / base["teu"] if base["teu"] else 0
        for vehicle in VEHICLES:
            a = by_pair[(route["route"], vehicle["vehicle"])]
            per_teu = a["cost"] / a["teu"] if a["teu"] else 0
            total_km = route["distance_km"] + 16  # 示例空驶约 16km，用于续航判断
            range_ratio = total_km / vehicle["range_km"] if vehicle["range_km"] else 0
            if vehicle["energy"] == "电":
                feasible = "可跑" if range_ratio <= 0.80 and route["charging"] else "需补能"
                if range_ratio > 1.0:
                    feasible = "不适用"
            else:
                feasible = "可跑" if range_ratio <= 0.90 else "需补能"
            pairs.append({
                "route": route["route"],
                "vehicle": vehicle["vehicle"],
                "energy": vehicle["energy"],
                "hp": vehicle["hp"],
                "trips": a["trips"],
                "cost_per_trip": _money(a["cost"] / a["trips"]) if a["trips"] else 0,
                "cost_per_teu": _money(per_teu),
                "energy_cost_per_trip": _money(a["energy_cost"] / a["trips"]) if a["trips"] else 0,
                "delta_per_teu": _money(per_teu - base_per_teu),
                "delta_ratio": _pct(per_teu - base_per_teu, base_per_teu),
                "feasible": feasible,
                "range_ratio": round(range_ratio, 3),
            })
    return routes, vehicles, pairs


def _labor() -> list[dict]:
    out = []
    for task in LABOR_TASKS:
        out.append({
            **task,
            "hours": round(task["hours"], 1),
            "release_hours": round(task["hours"] * task["potential"], 1),
        })
    return out


def _insights(routes: list[dict], vehicles: list[dict], pairs: list[dict],
              summary: dict, labor: list[dict]) -> list[dict]:
    out: list[dict] = []
    by_route = {r["route"]: r for r in routes}
    by_vehicle = {v["vehicle"]: v for v in vehicles}

    # 1) 电动 vs 柴油大马力：短途看成本，长途看续航
    for route in ROUTES:
        rows = [p for p in pairs if p["route"] == route["route"]]
        ev = next((p for p in rows if p["energy"] == "电"), None)
        diesel = next((p for p in rows if p["vehicle"] == "柴油重卡 · 大马力"), None)
        if not ev or not diesel:
            continue
        if ev["feasible"] == "不适用":
            out.append({
                "level": "high",
                "title": f"{route['route']} 电动重卡不适用",
                "detail": f"示例续航 {route['distance_km']}km 单程已接近/超过电动重卡可用里程，"
                          f"当前补能条件为{'有' if route['charging'] else '无'}；先不要替换。",
                "action": "保留柴油/LNG；先补沿途补能调研，再谈电动化",
            })
        elif ev["feasible"] == "需补能" or not route["charging"]:
            out.append({
                "level": "high" if not route["charging"] else "warn",
                "title": f"{route['route']} 电动重卡需先解决补能",
                "detail": f"示例电动单箱成本比柴油大马力低 {abs(ev['delta_per_teu']):,.0f} 元，"
                          f"但单程 {route['distance_km']}km，续航余量仅 "
                          f"{(1 - ev['range_ratio']) * 100:.0f}%，当前补能条件为"
                          f"{'有' if route['charging'] else '无'}；不能只看成本。",
                "action": "先确认沿途充电站/排队时间；补能没解决前不替换",
            })
        elif ev["delta_per_teu"] < 0:
            out.append({
                "level": "warn",
                "title": f"{route['route']} 电动单箱成本低 {abs(ev['delta_per_teu']):,.0f} 元",
                "detail": f"示例假设下电动重卡单箱成本比柴油大马力低 "
                          f"{abs(ev['delta_ratio']):.1%}；但要确认充电排队、载重和冬季续航。",
                "action": "选 1 台电车在这条线试跑 1 个月，记录补能时间和实际电耗",
            })

    # 2) 大马力 vs 小马力
    high = by_vehicle.get("柴油重卡 · 大马力")
    low = by_vehicle.get("柴油重卡 · 小马力")
    if high and low:
        diff = low["cost_per_teu"] - high["cost_per_teu"]
        if diff < 0:
            out.append({
                "level": "warn",
                "title": "小马力单箱成本更低",
                "detail": f"示例汇总下小马力比大马力每箱低 {abs(diff):,.0f} 元；"
                          f"但长途/重载的时效和爬坡能力要单独看。",
                "action": "把短途线路固定给小马力，长途保留大马力，按月对比时效",
            })
        else:
            out.append({
                "level": "ok",
                "title": "大马力在示例线路更划算",
                "detail": f"大马力比小马力每箱低 {abs(diff):,.0f} 元；短途线路可再单独测算。",
                "action": "按线路长度拆分车型，不要全车队一刀切",
            })

    # 3) 空驶
    worst = max(routes, key=lambda x: x["empty_ratio"]) if routes else None
    if worst and worst["empty_ratio"] > 0.08:
        out.append({
            "level": "warn",
            "title": f"{worst['route']} 空驶率偏高",
            "detail": f"示例空驶里程占比 {worst['empty_ratio']:.1%}；"
                      f"单箱成本 {worst['cost_per_teu']:,.0f} 元。",
            "action": "先做回程货源匹配；没有回程货时，比较“等待”与“空返”的成本",
        })

    # 4) 能源成本占比
    if summary["energy_share"] >= 0.25:
        out.append({
            "level": "warn",
            "title": "能源成本占比高",
            "detail": f"示例能源成本占运输成本 {summary['energy_share']:.1%}；"
                      f"油价/电价每变动 5%，单箱成本约变动 "
                      f"{summary['cost_per_teu'] * summary['energy_share'] * 0.05:,.0f} 元。",
            "action": "先锁定油价/电价口径，再做油电对比；不要把单价波动当成车型差异",
        })

    # 5) 人力
    heavy = sorted(labor, key=lambda x: -x["release_hours"])[:2]
    if heavy:
        names = "、".join(x["task"] for x in heavy)
        release = sum(x["release_hours"] for x in labor)
        out.append({
            "level": "ok",
            "title": "重复工时集中在少数环节",
            "detail": f"示例 {summary['labor_hours']:,.0f} 小时/月中，"
                      f"可减少的重复工时约 {release:,.0f} 小时；优先项是{names}。",
            "action": "先做托书/对账/在途三个入口；装卸和现场仍保留人工",
        })

    if not out:
        out.append({
            "level": "ok",
            "title": "示例数据下没有明显异常",
            "detail": "线路、车型和人力结构在示例阈值内。",
            "action": "接真实数据后重跑，重点看油价/电价和空驶",
        })
    return out


def demo() -> dict:
    rows = _trip_rows()
    routes, vehicles, pairs = _aggregate(rows)
    labor = _labor()
    total_revenue = sum(r["revenue"] for r in rows)
    total_cost = sum(r["cost"] for r in rows)
    total_teu = sum(r["load_teu"] for r in rows)
    energy_cost = sum(r["energy_cost"] for r in rows)
    labor_cost = sum(r["driver"] + r["handling"] for r in rows)
    empty_km = sum(r["empty_km"] for r in rows)
    total_km = sum(r["total_km"] for r in rows)
    fleet_total = sum(v["fleet"] for v in VEHICLES)
    new_energy = sum(v["fleet"] for v in VEHICLES if v["energy"] in ("电", "LNG"))
    labor_hours = sum(x["hours"] for x in labor)
    release_hours = sum(x["release_hours"] for x in labor)
    summary = {
        "trips": len(rows),
        "teu": total_teu,
        "routes": len(ROUTES),
        "vehicle_types": len(VEHICLES),
        "fleet_total": fleet_total,
        "new_energy_count": new_energy,
        "new_energy_share": _pct(new_energy, fleet_total),
        "revenue": _money(total_revenue),
        "cost": _money(total_cost),
        "profit": _money(total_revenue - total_cost),
        "margin": _pct(total_revenue - total_cost, total_revenue),
        "cost_per_teu": _money(total_cost / total_teu) if total_teu else 0,
        "energy_cost": _money(energy_cost),
        "energy_share": _pct(energy_cost, total_cost),
        "labor_cost": _money(labor_cost),
        "labor_share": _pct(labor_cost, total_cost),
        "empty_ratio": _pct(empty_km, total_km),
        "labor_hours": round(labor_hours, 1),
        "release_hours": round(release_hours, 1),
    }
    return {
        "synthetic": True,
        "public": xiefeng_public.summary(),
        "summary": summary,
        "routes": routes,
        "vehicles": vehicles,
        "pairs": pairs,
        "labor": labor,
        "insights": _insights(routes, vehicles, pairs, summary, labor),
        "assumptions": [
            f"柴油 7.2 元/L；LNG 5.4 元/kg；电 0.65 元/kWh（示例价，需按客户实际合同价替换）",
            f"路桥 {TOLL_PER_KM:.1f} 元/km；司机 {DRIVER_PER_HOUR:.0f} 元/小时；装卸 {HANDLING_PER_TRIP:.0f} 元/趟",
            "电动重卡续航按 220km 示例；实际受载重、温度、坡度、电池衰减影响",
            "未计车辆购置/电池折旧、充电设施、保险、残值和司机社保；当前只是运营成本对比，不是最终换车结论",
            "运营数据由固定随机种子生成，仅用于验证口径和页面，不代表协丰真实经营结果",
        ],
        "warning": "公开资料来自公开网页缓存；运营数据为合成演示；成本参数为示例假设，且未计车辆折旧/充电设施；真实结论需客户提供能耗、工时、路桥、合同价和 TCO 参数后重跑。",
    }
