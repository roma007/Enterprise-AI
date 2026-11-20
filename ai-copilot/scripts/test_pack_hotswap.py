"""行业包热切换自检（AI-61）。

验证：
- 切到 freight_audit 后，字段/规则/对账/词表立即跟随，无需重启；
- 请求/任务持闸期间切换被拒绝（PackBusy），包不变；
- 切回 trucking 后恢复；
- `rules.required` 默认值跟随当前包。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/test_pack_hotswap.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import (  # noqa: E402
    address_check, aging, fees, invoice, margin, pack, reconcile,
    rules, schema, settlement, statement, thresholds,
)

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def main() -> None:
    # 从干净状态开始（只改内存，不写 data/active_pack.json）
    pack.reload_pack("trucking")

    print("初始：trucking")
    chk("PACK_ID", schema.PACK_ID == "trucking", schema.PACK_ID)
    chk("首字段", schema.SPECS[0].key == "client", schema.SPECS[0].key)
    chk("匹配键", reconcile._MATCH_KEYS == ["booking_no", "container_no"], str(reconcile._MATCH_KEYS))
    chk("必填默认含 booking_no", "booking_no" in thresholds.BY_KEY["rules.required"]["default"])

    print("\n持闸期间禁止切换")
    with pack.request_guard():
        try:
            pack.reload_pack("freight_audit")
            chk("应抛 PackBusy", False)
        except pack.PackBusy as exc:
            chk("应抛 PackBusy", True, str(exc))
        chk("闸内仍是 trucking", schema.PACK_ID == "trucking", schema.PACK_ID)
    chk("闸外仍是 trucking", schema.PACK_ID == "trucking", schema.PACK_ID)

    print("\n切到 freight_audit（不重启）")
    pack.reload_pack("freight_audit")
    chk("PACK_ID", schema.PACK_ID == "freight_audit", schema.PACK_ID)
    chk("首字段=承运商", schema.SPECS[0].key == "carrier", schema.SPECS[0].key)
    chk("发票字段仍兼容", invoice.INVOICE_KEYS[0] == "invoice_code", invoice.INVOICE_KEYS[0])
    chk("风险字段=审计字段", rules.RISK_KEYS == [
        "carrier_invoice_no", "shipment_no", "charge_code", "amount",
    ], str(rules.RISK_KEYS))
    chk("箱型规则为空", not rules.VALID_TYPES, str(rules.VALID_TYPES))
    chk("匹配键=账单/运单/费用", reconcile._MATCH_KEYS == [
        "carrier_invoice_no", "shipment_no", "charge_code",
    ], str(reconcile._MATCH_KEYS))
    chk("_containers 不依赖 multi 配置", reconcile._containers("A,B") == {"A", "B"},
        str(reconcile._containers("A,B")))
    chk("对账表头含账单号", "carrier_invoice_no" in reconcile._HINTS, str(list(reconcile._HINTS)))
    chk("文本明细首列=账单号", statement.LINE_HINTS[0][1][0] == "账单号", str(statement.LINE_HINTS[0]))
    chk("费用词表为空", not fees.BUILTIN_FEES, str(len(fees.BUILTIN_FEES)))
    chk("结算词表为空", not settlement._RATE_HINTS, str(len(settlement._RATE_HINTS)))
    chk("毛利词表为空", not margin._REVENUE_HINTS, str(len(margin._REVENUE_HINTS)))
    chk("地域词表为空", not address_check.DISTRICTS, str(len(address_check.DISTRICTS)))
    chk("账龄词表为空", not aging._HINTS, str(len(aging._HINTS)))
    chk("必填默认=审计字段", thresholds.BY_KEY["rules.required"]["default"] == [
        "carrier", "carrier_invoice_no", "shipment_no", "charge_code", "amount",
    ], str(thresholds.BY_KEY["rules.required"]["default"]))
    chk("empty_draft 带新包版本", schema.empty_draft().pack_id == "freight_audit")

    print("\n切包后对账立即用新口径")
    parsed = reconcile.parse_statement("账单号,运单号,费用代码,账单金额\nCI-1,SHP-1,FREIGHT,1200\n")
    chk("表头映射", parsed["mapping"].get("carrier_invoice_no") == 0, str(parsed["mapping"]))
    r = reconcile.reconcile(
        [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "amount": "1200"}],
        [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "contract_rate": "1000"}],
    )
    chk("金额差异", r["rows"][0]["status"] == "amount_diff", str(r["rows"][0]))

    print("\n切回 trucking")
    pack.reload_pack("trucking")
    chk("PACK_ID", schema.PACK_ID == "trucking", schema.PACK_ID)
    chk("首字段=客户", schema.SPECS[0].key == "client", schema.SPECS[0].key)
    chk("匹配键回来", reconcile._MATCH_KEYS == ["booking_no", "container_no"], str(reconcile._MATCH_KEYS))
    chk("必填默认回来", "booking_no" in thresholds.BY_KEY["rules.required"]["default"])
    chk("empty_draft 回 trucking", schema.empty_draft().pack_id == "trucking")

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
