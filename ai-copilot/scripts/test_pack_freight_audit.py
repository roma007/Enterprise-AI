"""第二行业包 dry-run：买方运费审计（`PACK_ID=freight_audit`）。

目的：证明同一个内核（schema / rules / reconcile）不改一行代码，
只换 `packs/freight_audit/` 就能跑另一套字段与对账口径。

用法：
    cd ai-copilot
    PACK_ID=freight_audit PYTHONPATH=. .venv/bin/python scripts/test_pack_freight_audit.py
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import address_check, invoice, reconcile, rules, schema  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def make(**values) -> schema.Draft:
    d = schema.empty_draft()
    for key, raw in values.items():
        value, conf = raw if isinstance(raw, tuple) else (raw, 0.95)
        d.fields[key].value = value
        d.fields[key].confidence = conf
        d.fields[key].source = "rule"
    return d


def codes(d: schema.Draft, now: datetime) -> list[str]:
    return [c.code for c in rules.run_checks(d, now)]


NOW = datetime(2026, 11, 20, 12, 0)
FULL = dict(
    carrier="顺达车队",
    carrier_invoice_no="CI-2026-1101",
    shipment_no="SHP-1001",
    charge_code="FREIGHT",
    charge_name="干线运费",
    amount="1200.00",
    contract_rate="1000.00",
)

print("pack 元信息")
chk("PACK_ID", schema.PACK_ID == "freight_audit", schema.PACK_ID)
chk("字段数", len(schema.SPECS) == 10, str(len(schema.SPECS)))
chk("首个字段是承运商", schema.SPECS[0].key == "carrier", schema.SPECS[0].key)
chk("发票字段仍兼容", invoice.INVOICE_KEYS[0] == "invoice_code", invoice.INVOICE_KEYS[0])
chk("审核规则", [r.id for r in rules.current_pack().validations] == [
    "required", "low_confidence", "amount_format", "contract_rate_format",
], str([r.id for r in rules.current_pack().validations]))

print("\n校验")
c = codes(make(**{**FULL, "carrier_invoice_no": ""}), NOW)
chk("缺账单号 -> E_REQUIRED", "E_REQUIRED" in c, str(c))
c = codes(make(**{**FULL, "amount": ("1200.00", 0.5)}), NOW)
chk("低置信 -> W_LOW_CONF", "W_LOW_CONF" in c, str(c))
c = codes(make(**FULL), NOW)
chk("合法金额不报错", "W_AMOUNT_FORMAT" not in c, str(c))
c = codes(make(**{**FULL, "amount": "1,200.00"}), NOW)
chk("千分位金额可接受", "W_AMOUNT_FORMAT" not in c, str(c))
c = codes(make(**{**FULL, "amount": "abc"}), NOW)
chk("非法金额 -> W_AMOUNT_FORMAT", "W_AMOUNT_FORMAT" in c, str(c))
c = codes(make(**FULL), NOW)
chk("不跑箱号规则", "E_CONTAINER_CHECKSUM" not in c, str(c))

print("\n分级审批")
bad = make(**{**FULL, "carrier_invoice_no": ""})
bad.checks = rules.run_checks(bad, NOW)
chk("有 error -> blocked", rules.decide_review_level(bad) == "blocked")
auto = make(**FULL)
auto.checks = rules.run_checks(auto, NOW)
chk("全高风险字段 -> auto", rules.decide_review_level(auto) == "auto",
    f"level={rules.decide_review_level(auto)} checks={[x.code for x in auto.checks]}")

print("\n对账口径")
parsed = reconcile.parse_statement("账单号,运单号,费用代码,账单金额\nCI-1,SHP-1,FREIGHT,1200\n")
chk("表头映射", parsed["mapping"] == {
    "carrier_invoice_no": 0, "shipment_no": 1, "charge_code": 2, "amount": 3,
}, str(parsed["mapping"]))
chk("保留账单行", len(parsed["rows"]) == 1, str(parsed["rows"]))

r = reconcile.reconcile(
    [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "amount": "1200"}],
    [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "contract_rate": "1000"}],
)
chk("金额差异", r["rows"][0]["status"] == "amount_diff", str(r["rows"][0]))
chk("差异金额 200", r["rows"][0]["diff"] == 200.0, str(r["rows"][0]["diff"]))

r_charge = reconcile.reconcile(
    [{"charge_code": "FREIGHT", "amount": "1200"}],
    [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "contract_rate": "1000"}],
)
chk("只给费用代码也能命中", r_charge["summary"]["amount_diff"] == 1, str(r_charge["summary"]))

r_missing = reconcile.reconcile(
    [{"carrier_invoice_no": "CI-2", "shipment_no": "SHP-2", "charge_code": "FUEL", "amount": "50"}],
    [{"carrier_invoice_no": "CI-1", "shipment_no": "SHP-1", "charge_code": "FREIGHT", "contract_rate": "1000"}],
)
statuses = {row["status"] for row in r_missing["rows"]}
chk("账单有系统无", "missing_in_system" in statuses, str(statuses))
chk("系统有账单未报", "missing_in_statement" in statuses, str(statuses))

csv_text = reconcile.export_csv(r)
header = csv_text.splitlines()[0]
chk("CSV 展示字段来自 pack", "账单号" in header and "运单号" in header, header)
chk("CSV 状态文案来自 pack", "金额不符" in csv_text, "")

print("\n空领域不崩")
chk("空 geo 不崩", address_check.check_addresses("", "") == [])
chk("Draft 带 pack 版本", schema.empty_draft().pack_id == "freight_audit")

print()
if ok:
    print("全部通过：买方运费审计包不改代码可跑通")
else:
    print("存在失败项")
    sys.exit(1)
