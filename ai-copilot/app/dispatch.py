"""调度与装箱演示（B6）。

边界：
- 这是启发式规则/运筹演示，不是 LLM；合成订单/车辆，不代表真实客户。
- 目标：让人看到“优化前后差多少”，不是承诺真实降本。
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from .demo_ops import _dist, orders, vehicles

SPEED_KMH = 45.0
SERVICE_H = 1.0


def _travel_hours(km: float) -> float:
    return km / SPEED_KMH + SERVICE_H


def _assign_baseline(orders_: list[dict], vehicles_: list[dict]) -> list[dict]:
    out = []
    for i, order in enumerate(orders_):
        v = vehicles_[i % len(vehicles_)]
        out.append({**order, "truck": v["truck"], "capacity": v["capacity_teu"]})
    return out


def _assign_greedy(orders_: list[dict], vehicles_: list[dict]) -> list[dict]:
    # 每台车记录当前位置和可用时间
    state = {v["truck"]: {"loc": v["start"], "at": datetime(2026, 11, 8, 6),
                          "cap": v["capacity_teu"]} for v in vehicles_}
    out, unassigned = [], []
    for order in sorted(orders_, key=lambda x: x["due"]):
        ready = datetime.fromisoformat(order["ready"])
        due = datetime.fromisoformat(order["due"])
        best = None
        for v in vehicles_:
            st = state[v["truck"]]
            if st["cap"] < order["qty"]:
                continue
            start_at = max(st["at"], ready)
            empty = _dist(st["loc"], order["from"])
            loaded = _dist(order["from"], order["to"])
            arrive = start_at + timedelta(hours=_travel_hours(empty + loaded))
            late = max(0.0, (arrive - due).total_seconds() / 3600)
            score = empty * 1.0 + late * 400
            if best is None or score < best[0]:
                best = (score, v, start_at, empty, loaded, arrive, late)
        if not best:
            unassigned.append(order)
            continue
        _, v, start_at, empty, loaded, arrive, late = best
        st = state[v["truck"]]
        st["loc"] = order["to"]
        st["at"] = arrive
        out.append({**order, "truck": v["truck"], "capacity": v["capacity_teu"],
                    "empty_km": round(empty, 1), "loaded_km": round(loaded, 1),
                    "late_hours": round(late, 2), "arrive": arrive.isoformat(timespec="minutes")})
    return out


def _metrics(rows: list[dict]) -> dict:
    empty = sum(r.get("empty_km", 0) for r in rows)
    loaded = sum(r.get("loaded_km", 0) for r in rows)
    on_time = sum(1 for r in rows if r.get("late_hours", 0) <= 0)
    util = (sum(min(1.0, r["qty"] / max(1, r["capacity"])) for r in rows) / len(rows)) if rows else 0
    return {
        "assignments": len(rows),
        "empty_km": round(empty, 1),
        "loaded_km": round(loaded, 1),
        "total_km": round(empty + loaded, 1),
        "on_time": on_time,
        "on_time_rate": round(on_time / len(rows), 4) if rows else 0.0,
        "utilization": round(util, 4),
    }


def _baseline_metrics(rows: list[dict], vehicles_: list[dict]) -> dict:
    # 基准：按顺序派车，不优化起点/时间；按实际到达时间算准时率
    state = {v["truck"]: {"loc": v["start"], "at": datetime(2026, 11, 8, 6)}
             for v in vehicles_}
    out = []
    for r in rows:
        st = state[r["truck"]]
        ready = datetime.fromisoformat(r["ready"])
        due = datetime.fromisoformat(r["due"])
        start_at = max(st["at"], ready)
        empty = _dist(st["loc"], r["from"])
        loaded = _dist(r["from"], r["to"])
        arrive = start_at + timedelta(hours=_travel_hours(empty + loaded))
        late = max(0.0, (arrive - due).total_seconds() / 3600)
        st["loc"], st["at"] = r["to"], arrive
        out.append({**r, "empty_km": round(empty, 1), "loaded_km": round(loaded, 1),
                    "late_hours": round(late, 2)})
    return _metrics(out)


def _loading(orders_: list[dict]) -> dict:
    # 40HQ：约 68 CBM / 26 吨
    bins: list[dict] = []
    for o in sorted(orders_, key=lambda x: -x["volume_cbm"]):
        placed = False
        for b in bins:
            if b["cbm"] + o["volume_cbm"] <= 68 and b["ton"] + o["weight_t"] <= 26:
                b["cbm"] += o["volume_cbm"]
                b["ton"] += o["weight_t"]
                b["orders"].append(o["order_no"])
                placed = True
                break
        if not placed:
            bins.append({"cbm": o["volume_cbm"], "ton": o["weight_t"],
                         "orders": [o["order_no"]]})
    used = sum(b["cbm"] for b in bins)
    capacity = len(bins) * 68
    return {
        "bins": len(bins),
        "orders": len(orders_),
        "used_cbm": round(used, 1),
        "capacity_cbm": capacity,
        "utilization": round(used / capacity, 4) if capacity else 0.0,
        "naive_bins": len(orders_),
        "naive_utilization": round(sum(o["volume_cbm"] for o in orders_) /
                                   (len(orders_) * 68), 4) if orders_ else 0.0,
    }


def demo() -> dict:
    os_ = orders()
    vs = vehicles()
    baseline_rows = _assign_baseline(os_, vs)
    optimized_rows = _assign_greedy(os_, vs)
    baseline = _baseline_metrics(baseline_rows, vs)
    optimized = _metrics(optimized_rows)
    loading = _loading(os_[:80])
    return {
        "synthetic": True,
        "summary": {"orders": len(os_), "vehicles": len(vs),
                    "unassigned": len(os_) - len(optimized_rows)},
        "baseline": baseline,
        "optimized": optimized,
        "improvement": {
            "empty_km": round(baseline["empty_km"] - optimized["empty_km"], 1),
            "empty_km_pct": round(1 - optimized["empty_km"] / baseline["empty_km"], 4)
            if baseline["empty_km"] else 0.0,
            "on_time_pct": round(optimized["on_time_rate"] - baseline["on_time_rate"], 4),
        },
        "assignments": optimized_rows[:12],
        "loading": loading,
        "warning": "合成演示数据；调度/装箱为启发式规则，不是大模型，也不代表真实降本。",
    }
