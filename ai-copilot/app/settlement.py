"""外协结算：车队报账 ↔ 合同价。

痛点：外协车队月底发一张结算单，几十行，财务按合同价逐行乘、逐行对。
错一行就是几百上千的差额，而且很难发现——因为人只会核对"这一行看着眼熟"。

做法：
1. 用合同价表算出"应付"
2. 与车队报的"报账金额"逐行比
3. 超出容差 → 标记多付；缺合同价 → 标记无法核定

计价单位支持：按趟 / 按吨 / 按天 / 按公里。
查价顺序：车队+线路+箱型 → 车队+线路 → 车队（兜底），层层降级并记录用的是哪一级。
"""
from __future__ import annotations

import csv
import io
import re
from decimal import Decimal, InvalidOperation

TOLERANCE = Decimal("1.00")   # 1 元内视为一致

_RATE_HINTS = {
    "carrier": ("车队", "承运商", "外协", "供应商"),
    "route": ("线路", "路线", "起止", "区间"),
    "container_type": ("箱型", "柜型", "车型"),
    "price": ("单价", "价格", "运价"),
    "unit": ("单位", "计价单位", "计费单位"),
}
_BILL_HINTS = {
    "carrier": ("车队", "承运商", "外协", "供应商"),
    "booking_no": ("单号", "运单号", "趟次号", "委托单号"),
    "route": ("线路", "路线", "起止"),
    "container_type": ("箱型", "柜型", "车型"),
    "qty": ("数量", "趟数", "吨位", "重量", "车数"),
    "claimed": ("报账", "金额", "结算金额", "应付金额"),
}


def _dec(v) -> Decimal | None:
    if v is None or v == "":
        return None
    s = re.sub(r"[^\d.\-]", "", str(v))
    if not s or s in {"-", "."}:
        return None
    try:
        return Decimal(s).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def _map_header(cols: list[str], hints: dict) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for i, c in enumerate(cols):
        name = (c or "").strip().lower().replace(" ", "")
        for key, hs in hints.items():
            if key in mapping.values():
                continue
            if any(h.lower() in name for h in hs):
                mapping[i] = key
                break
    return mapping


def _parse(text: str, hints: dict) -> list[dict]:
    text = text.lstrip("\ufeff")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    header = -1
    for i, ln in enumerate(lines[:5]):
        if any(h in ln for hs in hints.values() for h in hs):
            header = i
            break
    if header >= 0:
        sample = "\n".join(lines[header:header + 5])
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(io.StringIO("\n".join(lines[header:])), dialect))
        mapping = _map_header(rows[0], hints)
        data = rows[1:]
    else:
        mapping = {i: k for i, k in enumerate(hints.keys())}
        data = [re.split(r"\s+", ln) for ln in lines]

    out = []
    for r in data:
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if any(rec.values()):
            out.append(rec)
    return out


def parse_rates(text: str) -> list[dict]:
    return _parse(text, _RATE_HINTS)


def parse_bills(text: str) -> list[dict]:
    return _parse(text, _BILL_HINTS)


def _key(carrier: str, route: str = "", ctype: str = "") -> tuple[str, str, str]:
    return ((carrier or "").strip(), (route or "").strip(), (ctype or "").strip().upper())


def settle(rates: list[dict], bills: list[dict], tolerance: Decimal = TOLERANCE) -> dict:
    exact: dict[tuple, Decimal] = {}
    by_carrier_route: dict[tuple, Decimal] = {}
    by_carrier: dict[tuple, Decimal] = {}
    carrier_count: dict[str, int] = {}

    for r in rates:
        c, rt, ct = _key(r.get("carrier", ""), r.get("route", ""), r.get("container_type", ""))
        price = _dec(r.get("price"))
        if price is None:
            continue
        exact[(c, rt, ct)] = price
        by_carrier_route[(c, rt)] = price
        # 同一车队可能有多条线路价，记录条数；只有"唯一价"时才允许兜底
        if (c,) not in by_carrier:
            by_carrier[(c,)] = price
            carrier_count[c] = 1
        else:
            carrier_count[c] = carrier_count.get(c, 1) + 1

    rows = []
    for b in bills:
        c, rt, ct = _key(b.get("carrier", ""), b.get("route", ""), b.get("container_type", ""))
        qty = _dec(b.get("qty"))
        claimed = _dec(b.get("claimed"))

        price, level = None, ""
        if (c, rt, ct) in exact:
            price, level = exact[(c, rt, ct)], "车队+线路+箱型"
        elif (c, rt) in by_carrier_route:
            price, level = by_carrier_route[(c, rt)], "车队+线路"
        elif carrier_count.get(c) == 1 and (c,) in by_carrier:
            # 只有该车队在合同里仅有一条价时才敢兜底；
            # 有多条线路价却拿别的线路价套，会直接导致多付。
            price, level = by_carrier[(c,)], "车队唯一价"

        if price is None:
            rows.append({
                "booking_no": b.get("booking_no", ""), "carrier": b.get("carrier", ""),
                "route": b.get("route", ""), "container_type": b.get("container_type", ""),
                "qty": float(qty) if qty is not None else None,
                "price": None, "expected": None,
                "claimed": float(claimed) if claimed is not None else None,
                "diff": None, "status": "no_rate", "price_level": "",
                "note": "合同里没有这个价，无法核定",
            })
            continue

        q = qty if qty is not None else Decimal("1")
        expected = (price * q).quantize(Decimal("0.01"))
        c_amt = claimed if claimed is not None else Decimal("0")
        diff = c_amt - expected
        if abs(diff) <= tolerance:
            status, note = "ok", ""
        elif diff > 0:
            status, note = "overcharge", "报账高于合同价"
        else:
            status, note = "undercharge", "报账低于合同价（可能漏项）"

        rows.append({
            "booking_no": b.get("booking_no", ""), "carrier": b.get("carrier", ""),
            "route": b.get("route", ""), "container_type": b.get("container_type", ""),
            "qty": float(q), "price": float(price), "expected": float(expected),
            "claimed": float(c_amt), "diff": float(diff),
            "status": status, "price_level": level, "note": note,
        })

    def total(key):
        vals = [Decimal(str(r[key])) for r in rows if r.get(key) is not None]
        return float(sum(vals, Decimal("0")))

    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    over = sum((Decimal(str(r["diff"])) for r in rows if r["status"] == "overcharge"), Decimal("0"))
    under = sum((Decimal(str(r["diff"])) for r in rows if r["status"] == "undercharge"), Decimal("0"))

    return {
        "summary": {
            "bills": len(rows),
            "ok": counts.get("ok", 0),
            "overcharge": counts.get("overcharge", 0),
            "undercharge": counts.get("undercharge", 0),
            "no_rate": counts.get("no_rate", 0),
            "expected_total": total("expected"),
            "claimed_total": total("claimed"),
            "diff_total": round(float(Decimal(str(total("claimed"))) - Decimal(str(total("expected")))), 2),
            "overcharge_amount": float(over),
            "undercharge_amount": float(under),
            "need_action": len(rows) - counts.get("ok", 0),
        },
        "rows": rows,
    }


def export_csv(result: dict) -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    label = {"ok": "一致", "overcharge": "多付", "undercharge": "少付", "no_rate": "无合同价"}
    w.writerow(["单号", "车队", "线路", "箱型", "数量", "单价", "应付", "报账", "差额", "状态", "查价层级", "说明"])
    for r in result["rows"]:
        w.writerow([r["booking_no"], r["carrier"], r["route"], r["container_type"],
                    r["qty"], r["price"] if r["price"] is not None else "",
                    r["expected"] if r["expected"] is not None else "",
                    r["claimed"] if r["claimed"] is not None else "",
                    r["diff"] if r["diff"] is not None else "",
                    label.get(r["status"], r["status"]), r["price_level"], r["note"]])
    return buf.getvalue()


def demo_data() -> dict:
    rates = [
        {"carrier": "北仑顺达车队", "route": "北仑-慈溪", "container_type": "40HQ", "price": "320", "unit": "趟"},
        {"carrier": "北仑顺达车队", "route": "北仑-余姚", "container_type": "40HQ", "price": "380", "unit": "趟"},
        {"carrier": "北仑顺达车队", "route": "北仑-慈溪", "container_type": "20GP", "price": "260", "unit": "趟"},
        {"carrier": "慈溪宏运车队", "route": "北仑-慈溪", "container_type": "40HQ", "price": "310", "unit": "趟"},
        {"carrier": "慈溪宏运车队", "route": "北仑-奉化", "container_type": "40HQ", "price": "360", "unit": "趟"},
    ]
    bills = [
        {"carrier": "北仑顺达车队", "booking_no": "WC-001", "route": "北仑-慈溪", "container_type": "40HQ", "qty": "1", "claimed": "320"},
        {"carrier": "北仑顺达车队", "booking_no": "WC-002", "route": "北仑-慈溪", "container_type": "40HQ", "qty": "1", "claimed": "350"},
        {"carrier": "北仑顺达车队", "booking_no": "WC-003", "route": "北仑-余姚", "container_type": "40HQ", "qty": "2", "claimed": "760"},
        {"carrier": "北仑顺达车队", "booking_no": "WC-004", "route": "北仑-慈溪", "container_type": "20GP", "qty": "1", "claimed": "260"},
        {"carrier": "慈溪宏运车队", "booking_no": "WC-005", "route": "北仑-慈溪", "container_type": "40HQ", "qty": "3", "claimed": "930"},
        {"carrier": "慈溪宏运车队", "booking_no": "WC-006", "route": "北仑-奉化", "container_type": "40HQ", "qty": "1", "claimed": "340"},
        {"carrier": "慈溪宏运车队", "booking_no": "WC-007", "route": "北仑-宁海", "container_type": "40HQ", "qty": "1", "claimed": "420"},
        {"carrier": "北仑顺达车队", "booking_no": "WC-008", "route": "北仑-慈溪", "container_type": "40HQ", "qty": "1", "claimed": "298"},
    ]
    rate_lines = ["车队,线路,箱型,单价,单位"] + [
        f'{r["carrier"]},{r["route"]},{r["container_type"]},{r["price"]},{r["unit"]}' for r in rates]
    bill_lines = ["车队,单号,线路,箱型,数量,报账金额"] + [
        f'{b["carrier"]},{b["booking_no"]},{b["route"]},{b["container_type"]},{b["qty"]},{b["claimed"]}'
        for b in bills]
    result = settle(rates, bills)
    return {"rate_text": "\n".join(rate_lines), "bill_text": "\n".join(bill_lines), "result": result}
