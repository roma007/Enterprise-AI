"""模拟一整天：把新能力全部串起来跑一遍。

不是演示单个功能，而是模拟"客户真的用起来"之后，系统给出什么数。

流程：
1. 20 条来单先落入入口（其中 2 条人不走系统 = 绕过）
2. 18 条解析，看分级审批分布
3. 按级别模拟人工耗时并确认（部分单有人工修正）
4. 输出：审批分布 / 自动通过率 / 节省工时 / 绕过率 / 风险模拟 / 学习队列
5. 单独演示：多票切分、改单 diff

用法：PYTHONPATH=. .venv/bin/python scripts/sim_day.py
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.evalrun import load_samples  # noqa: E402

BASE = "http://127.0.0.1:8790"
HANDLE_MS = {"auto": 9_000, "single": 34_000, "double": 62_000, "blocked": 110_000}

MULTI = """1. 客户：宏远国际货代  单号：HY-1105  箱型：40HQ  箱号：CSQU3054383  提箱地：北仑二期堆场  卸货地：宁波北仑春晓工业园3号仓  截港：2026-12-07 18:00
2. 客户：海通货代  单号：HT-1106  箱型：20GP  箱号：TCLU1234568  提箱地：北仑三期堆场  卸货地：宁波北仑大碶街道  截港：2026-12-08 18:00
3. 客户：中远物流  单号：ZY-1107  箱型：40HQ  箱号：MSCU7654329  提箱地：穿山港区堆场  卸货地：宁波慈溪浒山街道  截港：2026-12-09 18:00"""

AMEND = """原单 HY2026110501 有变：
1. 箱型改 40GP
2. 加一个箱号 MSCU7654329
3. 截港延到 12月9号 18点
其他不变"""


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))


def get(path: str) -> dict:
    return json.load(urllib.request.urlopen(BASE + path, timeout=60))


def main() -> None:
    samples = load_samples(ROOT / "samples" / "bookings.jsonl")
    picks = samples[:18]

    print("=" * 62)
    print("一、入口：20 条来单")
    print("=" * 62)
    for s in picks:
        post("/api/inbound", {"text": s["raw"], "source": "wecom"})
    # 2 条绕过：来了但人自己录了，没走系统
    for i in range(2):
        post("/api/inbound", {"text": f"客户：绕过客户{i}\n单号：BYPASS-{i}\n箱号：CSQU3054383", "source": "wecom"})
    print(f"入口捕获 20 条，其中 2 条人没走系统（绕过）\n")

    print("=" * 62)
    print("二、解析 18 条，看分级审批")
    print("=" * 62)
    counts = {"auto": 0, "single": 0, "double": 0, "blocked": 0}
    confirmed = 0
    for s in picks:
        d = post("/api/extract", {"text": s["raw"], "use_llm": False})
        lv = d["review_level"]
        counts[lv] = counts.get(lv, 0) + 1

        auto = {k: (v["value"] or "") for k, v in d["fields"].items()}
        final = dict(auto)
        # 模拟人工：single 改一个字段，double 改两个，blocked 修好再提交
        if lv == "single":
            final["remark"] = (final.get("remark") or "") + "（已核对）"
        elif lv == "double":
            final["delivery_addr"] = final.get("delivery_addr") or "北仑"
        elif lv == "blocked":
            final["delivery_addr"] = final.get("delivery_addr") or "北仑"

        post("/api/confirm", {"run_id": d["run_id"], "auto": auto, "final": final,
                              "handle_ms": HANDLE_MS[lv]})
        confirmed += 1

    print(f"分级分布：auto {counts['auto']} / single {counts['single']} / "
          f"double {counts['double']} / blocked {counts['blocked']}")
    print(f"总计确认 {confirmed} 条\n")

    print("=" * 62)
    print("三、指标中心")
    print("=" * 62)
    m = get("/api/metrics")
    print(f"解析票数      {m['tickets_parsed']}")
    print(f"自动通过率    {m['auto_pass_rate']:.1%}")
    print(f"平均确认耗时  {m['avg_handle_sec']} 秒/单（基线 {m['baseline_manual_sec']:.0f} 秒）")
    print(f"累计节省工时  {m['saved_hours']} 小时")
    print(f"人工修正率    {m['correction_rate']:.1%}")
    print(f"绕过率        {m['bypass_rate']:.1%}  告警={m['bypass_alert']}")
    print()

    print("=" * 62)
    print("四、老板问：取消人工确认行不行？")
    print("=" * 62)
    r = get("/api/risk-sim?monthly_tickets=2000&penalty=8300&threshold=0.9")
    if r.get("ok"):
        print(f"自动通过率 {r['auto_pass_rate']:.0%}，其中错单率 {r['error_rate_among_auto']:.0%}")
        print(f"月错单 {r['expected_bad_tickets']}，月损失 {r['expected_monthly_loss']:,.0f} 元")
        print(f"省人工 {r['monthly_review_hours_saved']} 小时（{r['monthly_review_cost_saved']:,.0f} 元）")
        print(f"净收益 {r['net_monthly']:,.0f} 元 → {r['verdict']}")
    else:
        print("无法测算：", r.get("reason"))
    print()

    print("=" * 62)
    print("五、客户发来三票混在一条消息")
    print("=" * 62)
    sp = post("/api/split", {"text": MULTI, "use_llm": False})
    print(f"切出 {sp['count']} 票：")
    for t in sp["tickets"]:
        f = t["fields"]
        print(f"  第{t['index']}票  {f['client']['value']:<10} {f['booking_no']['value']:<10} "
              f"{f['container_type']['value']:<5} {f['container_no']['value']:<24} {f['closing_time']['value']}")
    print()

    print("=" * 62)
    print("六、客户改单")
    print("=" * 62)
    d2 = post("/api/extract", {"text": AMEND, "use_llm": False})
    am = d2.get("amend") or {}
    print(f"基于原单 {am.get('base_booking_no')}")
    for x in am.get("diff", []):
        print(f"  [{x['action']}] {x['label']}: {x['old'] or '（空）'} → {x['new']}")
    if not am.get("diff"):
        print("  ", am.get("note"))
    print()

    print("=" * 62)
    print("七、学习队列")
    print("=" * 62)
    ls = get("/api/learn/stats")
    print(f"已确认并产出金标 {ls['labeled']} 条，其中人工改过 {ls['corrected']} 条")
    print(f"按原因：{json.dumps(ls['by_reason'], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
