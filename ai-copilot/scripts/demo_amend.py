"""改单 diff 演示（D9）。

流程：先确认一张原单，再发一条改单通知，看系统能不能算出差异。

用法：PYTHONPATH=. .venv/bin/python scripts/demo_amend.py
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BASE = "http://127.0.0.1:8790"

ORIGINAL = """客户：宏远国际货代
委托单号：HY-1105
箱型：40GP
箱量：1
箱号：CSQU3054383
封号：SL8823101
提箱地：北仑二期堆场
卸货地：宁波北仑春晓工业园3号仓
截港时间：2026-11-07 18:00"""

AMEND = """原单 HY-1105 有变：
1. 箱型改40HQ
2. 加一个箱号 MSCU7654329
3. 截港延到11月8号18点
其他不变"""


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def main() -> None:
    d = post("/api/extract", {"text": ORIGINAL, "use_llm": False})
    auto = {k: (v["value"] or "") for k, v in d["fields"].items()}
    post("/api/confirm", {"run_id": d["run_id"], "auto": auto, "final": auto, "handle_ms": 30000})
    print("已确认原单 HY-1105：箱型 40GP，1 个箱号，截港 2026-11-07 18:00\n")

    d2 = post("/api/extract", {"text": AMEND, "use_llm": False})
    am = d2.get("amend") or {}
    print(f"改单识别：基于原单 {am.get('base_booking_no')}（run {am.get('base_run_id')}）")
    if am.get("diff"):
        for x in am["diff"]:
            print(f"  [{x['action']}] {x['label']}: {x['old'] or '（空）'} → {x['new']}")
    else:
        print("  未产生 diff：", am.get("note"))

    print("\n合并后的关键字段：")
    for k in ("booking_no", "container_type", "container_no", "closing_time", "client"):
        print(f"  {k:16} {d2['fields'][k]['value']}")


if __name__ == "__main__":
    main()
