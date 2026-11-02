"""B6 异常费用识别自检。

覆盖：
- 干净批次不误报
- 重复收费 / 金额非法 / 算术不符 / 未知费用 / 同批离群
- CSV 解析与合计
- 现场费用字典扩展（data/fee_dict.txt）

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_fees.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fees  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def codes(rows: list[dict]) -> list[str]:
    return [x["code"] for x in fees.check(rows)["issues"]]


def row(no: str, name: str, amount, qty=None, unit=None) -> dict:
    return {"booking_no": no, "fee_name": name, "amount": amount,
            "qty": qty, "unit_price": unit}


print("干净批次")
clean = [
    row("HY-001", "运费", 2600, 1, 2600),
    row("HY-001", "提箱费", 300, 1, 300),
    row("HY-002", "运费", 2650, 1, 2650),
    row("HY-003", "运费", 2550, 1, 2550),
    row("HY-004", "运费", 2580, 1, 2580),
    row("HY-005", "运费", 2610, 1, 2610),
]
r = fees.check(clean)
chk("无异常", r["clean"] and not r["issues"], str(r["issues"])[:120])
chk("合计正确", r["total_amount"] == "13290.00", r["total_amount"])
chk("行数正确", r["rows"] == 6)

print("重复收费")
dups = clean + [row("HY-001", "运费", 2600, 1, 2600)]
chk("同单号+同费用+同金额", "E_FEE_DUPLICATE" in codes(dups))
same_amount_other_fee = clean + [row("HY-001", "提箱费", 2600, 1, 2600)]
chk("同金额但不同费用不算重复", "E_FEE_DUPLICATE" not in codes(same_amount_other_fee))

print("金额非法")
chk("金额为 0", "E_FEE_AMOUNT" in codes([row("HY-1", "运费", 0)]))
chk("金额为负", "E_FEE_AMOUNT" in codes([row("HY-1", "运费", -50)]))
chk("金额无法识别", "E_FEE_AMOUNT" in codes([row("HY-1", "运费", "abc")]))

print("算术不符")
chk("2×100≠150", "E_FEE_ARITHMETIC" in codes([row("HY-1", "运费", 150, 2, 100)]))
chk("2×100=200 放行", "E_FEE_ARITHMETIC" not in codes([row("HY-1", "运费", 200, 2, 100)]))
chk("缺单价不硬算", "E_FEE_ARITHMETIC" not in codes([row("HY-1", "运费", 200, 2)]))

print("未知费用")
chk("未知费用名告警", "W_FEE_UNKNOWN" in codes([row("HY-1", "神秘附加费", 100)]))
chk("内置费用不告警", "W_FEE_UNKNOWN" not in codes([row("HY-1", "燃油附加费", 100)]))

print("同批离群")
outliers = [
    row("HY-001", "运费", 2500), row("HY-002", "运费", 2550),
    row("HY-003", "运费", 2600), row("HY-004", "运费", 2580),
    row("HY-005", "运费", 2520), row("HY-006", "运费", 9000),
]
oc = codes(outliers)
chk("高价离群被抓", "W_FEE_OUTLIER" in oc, str(oc))
low = outliers[:-1] + [row("HY-006", "运费", 100)]
oc = codes(low)
chk("低价离群也提示", "W_FEE_OUTLIER" in oc, str(oc))
small = [row("HY-001", "运费", 2500), row("HY-002", "运费", 2500),
         row("HY-003", "运费", 2500), row("HY-004", "运费", 9000)]
chk("少于 5 条不判离群", "W_FEE_OUTLIER" not in codes(small))

print("CSV 解析")
text = (
    "运单号,费用名称,数量,单价,金额,车队\n"
    "HY-001,运费,1,2600,2600,宏运车队\n"
    "HY-002,提箱费,1,300,300,宏运车队\n"
)
rows = fees.parse_fee_text(text)
chk("解析出 2 行", len(rows) == 2, str(rows))
chk("列映射正确", rows[0]["booking_no"] == "HY-001"
    and rows[0]["fee_name"] == "运费" and rows[0]["amount"] == "2600")
chk("制表符也能解析", len(fees.parse_fee_text("单号\t费用名称\t金额\nHY-1\t运费\t100")) == 1)

print("现场字典扩展")
tmp = Path(tempfile.mkdtemp(prefix="fee-dict-")) / "fee_dict.txt"
tmp.write_text("神秘附加费\n# 注释行\n", encoding="utf-8")
old = fees.DICT_PATH
fees.DICT_PATH = tmp
chk("补充后不再告警", "W_FEE_UNKNOWN" not in codes([row("HY-1", "神秘附加费", 100)]))
fees.DICT_PATH = old

print("整批结果结构")
r = fees.check(dups)
chk("by_code 有计数", r["by_code"].get("E_FEE_DUPLICATE") == 1, str(r["by_code"]))
chk("not clean", r["clean"] is False)
chk("issue 带行号与说明", r["issues"][0]["row"] >= 0 and bool(r["issues"][0]["message"]))

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
