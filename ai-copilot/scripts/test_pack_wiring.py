"""Step 1 行为接线自检：schema / invoice / rules 是否真的读 pack。

不依赖服务、不依赖模型；固定时间 `NOW`，结果可复现。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/test_pack_wiring.py
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import address_check, aging, extract, fees, invoice, margin, reconcile, rules, schema, settlement  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def make(**values) -> schema.Draft:
    """构造草稿：值可以是 str（置信度 .95）或 (str, confidence)。"""
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
    client="测试货代",
    booking_no="T-001",
    container_type="40HQ",
    container_qty="1",
    container_no="CSQU3054383",
    seal_no="SL8823101",
    pickup_addr="宁波北仑二期堆场",
    delivery_addr="宁波北仑春晓工业园3号仓",
    factory_phone="13800001234",
    closing_time="2026-11-25 18:00",
)

print("字段与发票来自 pack")
chk("托书字段首项", schema.SPECS[0].key == "client", schema.SPECS[0].key)
chk("托书字段数", len(schema.SPECS) == 20, str(len(schema.SPECS)))
chk("发票字段首项", invoice.INVOICE_KEYS[0] == "invoice_code", invoice.INVOICE_KEYS[0])
chk("发票字段数", len(invoice.INVOICE_SPECS) == 15, str(len(invoice.INVOICE_SPECS)))
chk("Draft 带 pack 版本", schema.empty_draft().pack_id == schema.PACK_ID)

print("\n必填与低置信")
c = codes(make(**{**FULL, "booking_no": ""}), NOW)
chk("缺必填 -> E_REQUIRED", "E_REQUIRED" in c, str(c))
c = codes(make(**{**FULL, "client": ("测试货代", 0.5)}), NOW)
chk("低置信 -> W_LOW_CONF", "W_LOW_CONF" in c, str(c))

print("\n箱号 / 箱量 / 箱型")
c = codes(make(**FULL), NOW)
chk("合法箱号不报错", "E_CONTAINER_CHECKSUM" not in c, str(c))
c = codes(make(**{**FULL, "container_no": "CSQU3054384"}), NOW)
chk("校验位错 -> E_CONTAINER_CHECKSUM", "E_CONTAINER_CHECKSUM" in c, str(c))
c = codes(make(**{**FULL, "container_qty": "2"}), NOW)
chk("箱量不符 -> W_QTY_MISMATCH", "W_QTY_MISMATCH" in c, str(c))
c = codes(make(**{**FULL, "container_type": "40XX"}), NOW)
chk("箱型非法 -> W_CONTAINER_TYPE", "W_CONTAINER_TYPE" in c, str(c))

print("\n封号 / 电话")
c = codes(make(**{**FULL, "seal_no": "A"}), NOW)
chk("封号过短 -> W_SEAL_FORMAT", "W_SEAL_FORMAT" in c, str(c))
c = codes(make(**{**FULL, "factory_phone": "123"}), NOW)
chk("电话非法 -> W_PHONE", "W_PHONE" in c, str(c))

print("\n截港 / 时间矛盾")
c = codes(make(**{**FULL, "closing_time": "2026-11-19 18:00"}), NOW)
chk("截港已过 -> E_CLOSING_PASSED", "E_CLOSING_PASSED" in c, str(c))
c = codes(make(**{**FULL, "closing_time": "2026-11-20 20:00"}), NOW)
chk("24h 内截港 -> W_CLOSING_SOON", "W_CLOSING_SOON" in c, str(c))
c = codes(make(**{**FULL, "loading_window": "2026-11-26 08:00"}), NOW)
chk("装柜晚于截港 -> W_WINDOW_AFTER_CLOSING", "W_WINDOW_AFTER_CLOSING" in c, str(c))

print("\n地址")
c = codes(make(**{**FULL, "pickup_addr": "宁波北仓"}), NOW)
chk("错别字 -> W_ADDR_TYPO", "W_ADDR_TYPO" in c, str(c))

print("\n分级审批")
bad = make(**{**FULL, "container_no": "CSQU3054384"})
bad.checks = rules.run_checks(bad, NOW)
chk("有 error -> blocked", rules.decide_review_level(bad) == "blocked")
auto = make(**FULL)
auto.checks = rules.run_checks(auto, NOW)
chk("全高风险字段 -> auto", rules.decide_review_level(auto) == "auto",
    f"level={rules.decide_review_level(auto)} checks={[x.code for x in auto.checks]}")

print("\n对账口径")
parsed = reconcile.parse_statement("运单号,箱号,金额\nT-001,CSQU3054383,100\n")
chk("表头映射", parsed["mapping"] == {"booking_no": 0, "container_no": 1, "amount": 2}, str(parsed["mapping"]))
parsed_box_only = reconcile.parse_statement("箱号,金额\nCSQU3054383,100\n")
chk("只有箱号也保留", len(parsed_box_only["rows"]) == 1, str(parsed_box_only["rows"]))
r = reconcile.reconcile(
    [{"booking_no": "T-001", "amount": "100"}, {"booking_no": "T-002", "amount": "50"}],
    [{"booking_no": "T-001", "freight": "90"}, {"booking_no": "T-003", "freight": "30"}],
)
statuses = {row["status"] for row in r["rows"]}
chk("金额差异", "amount_diff" in statuses, str(statuses))
chk("对账单有系统无", "missing_in_system" in statuses, str(statuses))
chk("系统有对账单无", "missing_in_statement" in statuses, str(statuses))
csv_text = reconcile.export_csv(r)
chk("CSV 使用 pack 状态文案", "金额不符" in csv_text)
chk("CSV 表头使用 pack 展示字段", "单号" in csv_text.splitlines()[0] and "箱号" in csv_text.splitlines()[0], csv_text.splitlines()[0])
# 只给箱号：按 match.keys 的第二键 + multi 仍能命中
r_box = reconcile.reconcile(
    [{"container_no": "CSQU3054383", "amount": "100"}],
    [{"booking_no": "T-001", "container_no": "CSQU3054383", "freight": "100"}],
)
chk("箱号匹配", r_box["summary"]["ok"] == 1, str(r_box["summary"]))

print("\n账龄 / 费用 / 毛利 / 地址词表")
ar = aging.parse_receivables("客户,应收,到期\n测试客户,1000,2026-11-30\n")
chk("账龄表头来自 pack", ar and ar[0].get("client") == "测试客户", str(ar[:1]))
fee_rows = fees.parse_fee_text("单号,费用,金额\nT-001,运费,100\n")
chk("费用表头来自 pack", fee_rows and fee_rows[0].get("fee_name") == "运费", str(fee_rows[:1]))
rev = margin.parse_revenue("日期,单号,车辆,客户,应收\n2026-11-01,T-001,浙A1,测试客户,100\n")
chk("毛利表头来自 pack", rev and rev[0].get("client") == "测试客户", str(rev[:1]))
addr = address_check.check_one("宁波北仓", "pickup_addr", "提箱地")
chk("地址词表来自 pack", any(c.code == "W_ADDR_TYPO" for c in addr), str([c.code for c in addr]))
rates = settlement.parse_rates("车队,线路,箱型,单价,单位\n测试车队,宁波-上海,40HQ,1000,箱\n")
chk("结算表头来自 pack", rates and rates[0].get("carrier") == "测试车队", str(rates[:1]))

print("\n解析结果带 pack 版本")
d = extract.extract("客户：测试货代\n委托单号：T-001\n船名航次：TEST / 001E", mode="rule", allow_llm=False)
chk("extract.pack_id", d.pack_id == schema.PACK_ID, d.pack_id)
chk("extract.pack_version", d.pack_version == schema.PACK_VERSION, d.pack_version)

print()
if ok:
    print("全部通过")
else:
    print("存在失败项")
    sys.exit(1)
