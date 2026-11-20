"""结算单文本抽取的 pack 词表自检（AI-61 复盘遗留）。

验证 `settlement_extract.py` 的明细列/表头别名来自 `fees.settlement_extract`，
切包或换词表后不需要改代码。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/test_pack_settlement.py
"""
from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import pack, settlement_extract  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


TRUCKING_TEXT = """结算单号：S-1
车队：顺达车队
周期：2026-11-01~2026-11-30
趟次号,车牌号,线路,箱型,数量,单价,报账金额
T1,浙A12345,北仑-慈溪,40HQ,1,320,320
"""


def main() -> None:
    real = pack.active_pack()

    print("trucking：默认词表")
    doc = settlement_extract.parse_settlement_text(TRUCKING_TEXT)
    chk("结算单号", doc["settlement_no"] == "S-1", str(doc["settlement_no"]))
    chk("车队", doc["carrier_name"] == "顺达车队", str(doc["carrier_name"]))
    chk("明细行", len(doc["lines"]) == 1, str(len(doc["lines"])))
    line = doc["lines"][0]
    chk("趟次号", line["trip_no"] == "T1", str(line["trip_no"]))
    chk("金额", line["amount"] == 320.0, str(line["amount"]))
    bills = settlement_extract.to_bills(doc)
    chk("to_bills", bills[0]["booking_no"] == "T1" and bills[0]["claimed"] == 320.0, str(bills[:1]))

    print("\n自定义词表：只换配置，不改代码")
    custom = replace(real, fees={
        "settlement_extract": {
            "line_hints": {
                "trip_no": ["行程号"],
                "amount": ["金额"],
            },
            "header_aliases": {
                "settlement_no": ["单据号"],
                "carrier_name": ["承运商"],
                "period": ["周期"],
                "total_amount": ["合计"],
            },
        },
    })
    settlement_extract._apply(custom)
    text = "单据号：S-2\n承运商：测试车队\n行程号,金额\nT9,100\n"
    doc2 = settlement_extract.parse_settlement_text(text)
    chk("自定义结算单号", doc2["settlement_no"] == "S-2", str(doc2["settlement_no"]))
    chk("自定义车队", doc2["carrier_name"] == "测试车队", str(doc2["carrier_name"]))
    chk("自定义明细", doc2["lines"][0]["trip_no"] == "T9", str(doc2["lines"][0]))
    bills2 = settlement_extract.to_bills(doc2)
    chk("自定义 to_bills", bills2[0]["booking_no"] == "T9" and bills2[0]["claimed"] == 100.0,
        str(bills2[:1]))

    print("\n恢复 trucking")
    settlement_extract._apply(real)
    doc3 = settlement_extract.parse_settlement_text(TRUCKING_TEXT)
    chk("恢复后可解析", doc3["settlement_no"] == "S-1" and len(doc3["lines"]) == 1)

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
