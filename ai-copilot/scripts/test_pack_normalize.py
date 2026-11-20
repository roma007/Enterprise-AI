"""字段归一化自检（AI-61 复盘遗留修复）。

验证 `normalize_for_compare` / `canonicalize` 真的按 pack 的 `normalize` 元数据走：
- trucking：金额/日期/箱号/名称；
- freight_audit：合同价、账单号、运单号、费用代码。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/test_pack_normalize.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import pack, schema  # noqa: E402
from app.normalize import canonicalize  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def eq(name: str, got, expected) -> None:
    if got == expected:
        chk(name, True)
    else:
        chk(name, False, f"{got!r} != {expected!r}")


def draft_fields(**values):
    d = schema.empty_draft()
    for key, value in values.items():
        d.fields[key].value = value
        d.fields[key].confidence = 0.9
        d.fields[key].source = "rule"
    return d


def main() -> None:
    pack.reload_pack("trucking")
    print("trucking：normalize_for_compare")
    eq("箱号列表排序", schema.normalize_for_compare("container_no", "oolu1234567, csqu3054383"),
       "CSQU3054383,OOLU1234567")
    eq("箱型 HC→HQ", schema.normalize_for_compare("container_type", "40 hc"), "40HQ")
    eq("金额 1,200.00", schema.normalize_for_compare("freight", "1,200.00"), "1200.00")
    eq("金额 1200", schema.normalize_for_compare("freight", "1200"), "1200.00")
    eq("日期斜杠", schema.normalize_for_compare("closing_time", "2026/11/7 18:00"), "2026-11-07 18:00")
    eq("名称去空格标点", schema.normalize_for_compare("client", "宏运 国际（货代）"), "宏运国际(货代)")

    print("\ntrucking：canonicalize")
    d = draft_fields(container_qty="两个", freight="1,200.00", closing_time="2026/11/7 18:00")
    changed = canonicalize(d.fields)
    eq("中文箱量→2", d.fields["container_qty"].value, "2")
    eq("金额去千分位", d.fields["freight"].value, "1200.00")
    eq("日期归一", d.fields["closing_time"].value, "2026-11-07 18:00")
    chk("留痕非空", bool(changed), str(changed))

    print("\nfreight_audit：normalize_for_compare")
    pack.reload_pack("freight_audit")
    eq("合同价 1,000", schema.normalize_for_compare("contract_rate", "1,000"), "1000.00")
    eq("账单金额 1200", schema.normalize_for_compare("amount", "1200"), "1200.00")
    eq("账单号去符号", schema.normalize_for_compare("carrier_invoice_no", "ci-2026 1101"), "CI20261101")
    eq("运单号去符号", schema.normalize_for_compare("shipment_no", "shp 1001"), "SHP1001")
    eq("费用代码大写", schema.normalize_for_compare("charge_code", "freight"), "FREIGHT")

    print("\nfreight_audit：canonicalize")
    d = draft_fields(amount="1,200.00", contract_rate="1,000", carrier_invoice_no="ci-1")
    canonicalize(d.fields)
    eq("账单金额归一", d.fields["amount"].value, "1200.00")
    eq("合同价归一", d.fields["contract_rate"].value, "1000")
    eq("账单号归一", d.fields["carrier_invoice_no"].value, "CI1")

    print("\n切回 trucking")
    pack.reload_pack("trucking")
    eq("回到集卡金额口径", schema.normalize_for_compare("freight", "1,200.00"), "1200.00")
    eq("amount 不再按金额归一", schema.normalize_for_compare("amount", "1,200.00"), "1,200.00")

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
