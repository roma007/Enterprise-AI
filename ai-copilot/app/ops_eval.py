"""运营能力合成回归：在途查询、调度装箱、在途事件、HS 候选。

目的：证明这四个能力在**足够量的合成数据**上可复现、可量化，
而不是只有一页手工演示。

边界：
- 全部为合成数据，不代表真实客户效果。
- 只验证规则/流程/边界；真实上线仍需客户港口、船期、订单、车辆、报关接口。
- 结果写入 data/ops_eval.json，并在 /ops-eval 页面展示。
"""
from __future__ import annotations

import json
import random
from datetime import datetime
from pathlib import Path

from .customs import _rank
from .demo_ops import shipments
from .dispatch import run as run_dispatch
from .events import rule_events
from .tracking import find_shipment

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "ops_eval.json"

# 事件抽取合成语料：12 类 × 25 条 + 60 条无事件干扰
_EVENT_TEMPLATES: dict[str, list[str]] = {
    "提箱": [
        "{t} 粤B{truck} 在北滘港提柜，柜号 {box}",
        "{t} {box} 已提箱，从北滘堆场出发",
        "{t} 司机说提到空箱了，柜号 {box}",
        "{t} 提柜完成，柜号 {box}，去工厂",
        "{t} 北滘港提箱，柜号 {box}，封号 SL{seal}",
    ],
    "装柜": [
        "{t} 工厂装柜完成，柜号 {box}",
        "{t} {box} 已装货，封号 SL{seal}",
        "{t} 装完柜了，毛重 {weight}",
        "{t} 工厂装箱完成，柜号 {box}",
        "{t} {box} 装柜中，预计一小时完成",
    ],
    "进港": [
        "{t} {box} 已还柜进港",
        "{t} 柜子进码头了，柜号 {box}",
        "{t} {box} 到闸口，准备进港",
        "{t} 还箱完成，柜号 {box}",
        "{t} {box} 已进港区，等下一步",
    ],
    "报关": [
        "{t} {box} 报关已申报",
        "{t} 报关资料已提交，柜号 {box}",
        "{t} {box} 预录完成，等申报",
        "{t} 这票报关中，柜号 {box}",
        "{t} {box} 已报关，等结果",
    ],
    "放行": [
        "{t} {box} 海关放行",
        "{t} 柜号 {box} 已放行",
        "{t} {box} 通关了，可以安排后续",
        "{t} 放行通知到了，柜号 {box}",
        "{t} {box} 已清关放行",
    ],
    "开船": [
        "{t} {box} 已开船",
        "{t} 船开了，柜号 {box}",
        "{t} {box} 已离港，船名 COSCO",
        "{t} 这票已启航，柜号 {box}",
        "{t} {box} 开船时间 {t}",
    ],
    "到港": [
        "{t} {box} 已到港",
        "{t} 柜号 {box} 靠泊了",
        "{t} {box} 抵达目的港",
        "{t} 到港通知，柜号 {box}",
        "{t} {box} 已到港，等卸船",
    ],
    "压车": [
        "{t} 粤B{truck} 在工厂压车，排队等装",
        "{t} {box} 压车中，前面还有三台",
        "{t} 司机说堵在闸口，等候进港",
        "{t} 工厂压夜，柜号 {box}",
        "{t} {box} 等卸货，压车两小时",
    ],
    "改单": [
        "{t} 客户改单，卸货地改到东莞",
        "{t} {box} 改配到下一班船",
        "{t} 改单：换船，柜号 {box}",
        "{t} 客户要求改港，柜号 {box}",
        "{t} {box} 改地址，送到长安",
    ],
    "甩柜": [
        "{t} 这票甩柜了，柜号 {box}",
        "{t} {box} 延班，赶不上这条船",
        "{t} 截港提前，可能漏装，柜号 {box}",
        "{t} {box} 被甩柜，等下一班",
        "{t} 船公司通知甩柜，柜号 {box}",
    ],
    "异常": [
        "{t} {box} 破损，需查验",
        "{t} 柜号 {box} 被扣关",
        "{t} {box} 短少，客户要索赔",
        "{t} 现场事故，柜号 {box}",
        "{t} {box} 查验通知，需补资料",
    ],
    "费用": [
        "{t} 产生停车费 {fee}",
        "{t} {box} 有搬移费 {fee}",
        "{t} 这票超期费 {fee}",
        "{t} 客户问滞箱费 {fee}",
        "{t} {box} 产生收费 {fee}",
    ],
}

_DISTRACTORS = [
    "收到，明天再确认",
    "好的，辛苦了",
    "客户问价格，晚点回复",
    "文件已发邮箱",
    "这个柜子下周再说",
    "我在外面，稍后回",
    "船公司那边的联系人是谁",
    "收到，已转给同事",
    "麻烦发一下最新的表格",
    "今天先这样，明天继续",
]


def _box(rnd: random.Random) -> str:
    prefix = "".join(rnd.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3)) + "U"
    return prefix + f"{rnd.randint(100000, 999999):06d}" + "0"


def event_corpus(per_type: int = 25, distractor_count: int = 60) -> list[tuple[str, str]]:
    rnd = random.Random(20261108)
    out: list[tuple[str, str]] = []
    day = datetime(2026, 11, 8, 8, 0)
    for etype, templates in _EVENT_TEMPLATES.items():
        for i in range(per_type):
            tpl = templates[i % len(templates)]
            t = (day.replace(hour=8 + (i % 12), minute=(i * 7) % 60)).strftime("%m-%d %H:%M")
            text = tpl.format(t=t, truck=f"{10000 + i * 37 % 89999:05d}",
                              box=_box(rnd), seal=f"{rnd.randint(100000, 999999)}",
                              weight=rnd.randint(8000, 24000), fee=rnd.choice([200, 300, 500]))
            out.append((text, etype))
    rnd.shuffle(out)
    for i in range(distractor_count):
        out.append((_DISTRACTORS[i % len(_DISTRACTORS)] + f"（{i}）", ""))
    return out


def eval_tracking(count: int = 400) -> dict:
    ships = shipments(count)
    ok_box = ok_booking = 0
    for s in ships:
        r = find_shipment(s["container_no"], ships)
        if r and r["container_no"] == s["container_no"]:
            ok_box += 1
        r = find_shipment(s["booking_no"], ships)
        if r and r["booking_no"] == s["booking_no"]:
            ok_booking += 1
    customers = sorted({s["customer"] for s in ships})
    ok_customer = 0
    for name in customers:
        r = find_shipment(name, ships)
        if r and r["customer"] == name:
            ok_customer += 1
    no_match = ["MSCU0000000 到哪了", "不存在的客户 到哪了", ""]
    no_match_ok = sum(1 for q in no_match if find_shipment(q, ships) is None)
    total = len(ships)
    return {
        "shipments": total,
        "customers": len(customers),
        "container_hit": round(ok_box / total, 4) if total else 0.0,
        "booking_hit": round(ok_booking / total, 4) if total else 0.0,
        "customer_hit": round(ok_customer / len(customers), 4) if customers else 0.0,
        "no_match_ok": round(no_match_ok / len(no_match), 4),
    }


def eval_dispatch(order_count: int = 500, vehicle_count: int = 60) -> dict:
    from .demo_ops import orders, vehicles
    res = run_dispatch(orders(order_count), vehicles(vehicle_count), loading_count=200)
    total = res["summary"]["orders"]
    unassigned = res["summary"]["unassigned"]
    return {
        "orders": total,
        "vehicles": res["summary"]["vehicles"],
        "assigned": total - unassigned,
        "unassigned": unassigned,
        "on_time_baseline": res["baseline"]["on_time_rate"],
        "on_time_optimized": res["optimized"]["on_time_rate"],
        "empty_km_baseline": res["baseline"]["empty_km"],
        "empty_km_optimized": res["optimized"]["empty_km"],
        "loading_bins": res["loading"]["bins"],
        "loading_utilization": res["loading"]["utilization"],
    }


def eval_events(per_type: int = 25, distractor_count: int = 60) -> dict:
    corpus = event_corpus(per_type, distractor_count)
    gold_total = sum(1 for _, g in corpus if g)
    tp = fp = fn = 0
    wrong: list[dict] = []
    for text, gold in corpus:
        events = rule_events(text)
        types = [e["type"] for e in events]
        if gold:
            hit = gold in types
            if hit:
                tp += 1
            else:
                fn += 1
            # 同一行多抽出的事件也算误报
            fp += max(0, len(types) - (1 if hit else 0))
            if not hit:
                wrong.append({"text": text, "gold": gold, "got": types})
        else:
            fp += len(types)
            if types:
                wrong.append({"text": text, "gold": "", "got": types})
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / gold_total if gold_total else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "lines": len(corpus),
        "gold_events": gold_total,
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "wrong_samples": wrong[:8],
    }


def eval_customs(items_count: int = 40, per_item: int = 5, no_match_count: int = 20) -> dict:
    items = []
    for i in range(items_count):
        kw = f"合成品类{i:03d}号"
        items.append({"code": f"{8500 + i:04d}", "name": f"合成品类{i:03d}",
                      "keywords": [kw, f"合成别名{i:03d}"]})
    cases = []
    for item in items:
        for j in range(per_item):
            cases.append((f"{item['keywords'][0]} 出口订单 {j}", item["code"]))
    top1 = top3 = 0
    for desc, code in cases:
        ranked = _rank(items, desc, 5)
        codes = [x["code"] for x in ranked]
        if codes[:1] == [code]:
            top1 += 1
        if code in codes[:3]:
            top3 += 1
    no_match_ok = 0
    for i in range(no_match_count):
        ranked = _rank(items, f"航天器零件 {i} 出口", 5)
        if not ranked:
            no_match_ok += 1
    total = len(cases)
    return {
        "dictionary_items": len(items),
        "cases": total,
        "top1": round(top1 / total, 4) if total else 0.0,
        "top3": round(top3 / total, 4) if total else 0.0,
        "no_match_ok": round(no_match_ok / no_match_count, 4) if no_match_count else 0.0,
    }


def evaluate() -> dict:
    tracking = eval_tracking()
    dispatch = eval_dispatch()
    events = eval_events()
    customs = eval_customs()
    checks = {
        "tracking_container": tracking["container_hit"] >= 0.99,
        "tracking_booking": tracking["booking_hit"] >= 0.99,
        "tracking_customer": tracking["customer_hit"] >= 0.99,
        "tracking_no_match": tracking["no_match_ok"] >= 0.99,
        "dispatch_assigned": dispatch["unassigned"] == 0,
        "dispatch_on_time": dispatch["on_time_optimized"] > dispatch["on_time_baseline"],
        "events_f1": events["f1"] >= 0.90,
        "customs_top1": customs["top1"] >= 0.95,
        "customs_top3": customs["top3"] >= 0.99,
        "customs_no_match": customs["no_match_ok"] >= 0.99,
    }
    result = {
        "synthetic": True,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "tracking": tracking,
        "dispatch": dispatch,
        "events": events,
        "customs": customs,
        "checks": checks,
        "pass": all(checks.values()),
        "warning": "合成数据回归，不代表真实客户效果；真实上线仍需客户接口与样本。",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    print(json.dumps(evaluate(), ensure_ascii=False, indent=2))
