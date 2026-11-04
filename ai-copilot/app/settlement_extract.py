"""结算单抽取：车队报账文本 → 标准 SettlementDocument。

规则比对仍由 app/settlement.py 负责；本模块只做解析和差异标准化。
"""
from __future__ import annotations

import re
import time
from decimal import Decimal

from .table_extract import find_table_header, norm_date, parse_header_lines, parse_table, to_decimal

LINE_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("trip_no", ("趟次号", "趟次", "trip")),
    ("waybill_no", ("运单号", "委托单号", "提单号", "单号")),
    ("plate_no", ("车牌号", "车牌", "车号")),
    ("route", ("线路", "路线", "起止")),
    ("container_type", ("箱型", "柜型", "车型")),
    ("quantity", ("数量", "趟数", "车数", "吨位")),
    ("unit_price", ("单价", "运价", "价格")),
    ("amount", ("结算金额", "应付金额", "报账金额", "金额")),
    ("deduction", ("扣款", "罚款", "扣减")),
    ("remark", ("备注", "说明")),
]

_WAYBILL_RE = re.compile(r"[A-Z]{2,4}\d{6,}")
_PLATE_RE = re.compile(r"[\u4e00-\u9fa5][A-Z][A-Z0-9]{4,6}")
_ROUTE_RE = re.compile(r"[\u4e00-\u9fa5]{2,}[-~至][\u4e00-\u9fa5]{2,}")
_CTYPE_RE = re.compile(r"(20|40|45)(GP|HQ|OT|RF|FR|TK)", re.IGNORECASE)
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_TRIP_RE = re.compile(r"T\d+")
_NUM_RE = re.compile(r"\d+(?:\.\d{1,2})?")

HEADER_ALIASES = {
    "settlement_no": ("结算单号", "账单号", "settlement_no"),
    "carrier_name": ("车队", "承运商", "供应商", "外协", "carrier"),
    "period": ("周期", "账期", "期间", "period"),
    "total_amount": ("合计", "总额", "total"),
}


def _header_value(headers: dict[str, str], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        key = re.sub(r"\s+", "", alias).lower()
        if key in headers:
            return headers[key]
    for key, value in headers.items():
        if any(alias.lower() in key for alias in aliases):
            return value
    return None


def _parse_period(value: str | None) -> tuple[str, str]:
    if not value:
        return "", ""
    dates = re.findall(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", value)
    if len(dates) >= 2:
        return norm_date(dates[0]), norm_date(dates[1])
    if len(dates) == 1:
        return norm_date(dates[0]), ""
    return "", ""


def norm_source_format(value: str | None, filename: str | None = None) -> str:
    raw = (value or "").strip().lower()
    name = (filename or "").lower()
    if raw in {"pdf", "pdf_scan"} or name.endswith(".pdf"):
        return "pdf_scan"
    if raw in {"image", "jpg", "jpeg", "png"} or name.endswith((".jpg", ".jpeg", ".png")):
        return "image"
    if raw in {"excel", "xlsx", "xls", "csv"} or name.endswith((".xlsx", ".xls", ".csv")):
        return "excel"
    return "text"


def _ocr_rows(lines: list[str]) -> list[dict]:
    """OCR 行兜底：列被粘连时，按业务格式用正则抽字段。"""
    rows: list[dict] = []
    for line in lines:
        waybill = _WAYBILL_RE.search(line)
        trip = _TRIP_RE.search(line)
        if not waybill and not trip:
            continue
        plate = _PLATE_RE.search(line)
        route = _ROUTE_RE.search(line)
        ctype = _CTYPE_RE.search(line)
        cleaned = line
        for pattern in (_WAYBILL_RE, _TRIP_RE, _PLATE_RE, _ROUTE_RE, _CTYPE_RE, _DATE_RE):
            cleaned = pattern.sub(" ", cleaned)
        nums = [to_decimal(x) for x in _NUM_RE.findall(cleaned)]
        qty = unit = amount = deduction = None
        if len(nums) >= 4:
            qty, unit, amount, deduction = nums[0], nums[1], nums[2], nums[3]
        elif len(nums) == 3:
            qty, unit, amount = nums[0], nums[1], nums[2]
        elif len(nums) == 2:
            qty, amount = nums[0], nums[1]
        elif len(nums) == 1:
            amount = nums[0]
        rows.append(
            {
                "trip_no": trip.group(0) if trip else "",
                "waybill_no": waybill.group(0) if waybill else "",
                "plate_no": plate.group(0) if plate else "",
                "route": route.group(0) if route else "",
                "container_type": ctype.group(0).upper() if ctype else "",
                "quantity": qty,
                "unit_price": unit,
                "amount": amount,
                "deduction": deduction,
            }
        )
    return rows


def parse_settlement_text(
    text: str,
    document_id: str | None = None,
    source_format: str | None = None,
) -> dict:
    """解析结算单文本，返回符合 pilot.schema.json 的 SettlementDocument。"""
    started = time.time()
    fmt = norm_source_format(source_format)
    raw_lines = [ln.rstrip("\n\r") for ln in (text or "").splitlines()]
    lines = [ln for ln in raw_lines if ln.strip()]
    if not lines:
        raise ValueError("结算单内容为空")

    header_idx = find_table_header(lines, LINE_HINTS)
    if header_idx < 0:
        raise ValueError("未找到结算单明细表头（需包含趟次/金额等字段）")

    headers = parse_header_lines(lines[:header_idx])
    rows = parse_table(lines, header_idx, LINE_HINTS)
    if fmt in {"pdf_scan", "image"}:
        ocr_rows = _ocr_rows(lines[header_idx + 1:])
        if ocr_rows:
            rows = ocr_rows
    if not rows:
        raise ValueError("未能从结算单中解析出明细行")

    settlement_no = _header_value(headers, HEADER_ALIASES["settlement_no"])
    carrier_name = _header_value(headers, HEADER_ALIASES["carrier_name"]) or ""
    period_start, period_end = _parse_period(_header_value(headers, HEADER_ALIASES["period"]))
    header_total = to_decimal(_header_value(headers, HEADER_ALIASES["total_amount"]))

    warnings: list[str] = []
    if not carrier_name:
        warnings.append("缺少车队/承运商")
    if not settlement_no:
        warnings.append("缺少结算单号")

    parsed_lines: list[dict] = []
    for i, row in enumerate(rows, 1):
        trip_no = (row.get("trip_no") or "").strip()
        waybill_no = (row.get("waybill_no") or "").strip()
        if not trip_no and not waybill_no:
            warnings.append(f"第 {i} 行缺少趟次号/运单号，已跳过")
            continue
        qty = to_decimal(row.get("quantity"))
        unit_price = to_decimal(row.get("unit_price"))
        amount = to_decimal(row.get("amount"))
        deduction = to_decimal(row.get("deduction"))
        if amount is None and unit_price is not None:
            amount = unit_price * (qty if qty is not None else Decimal("1"))
        if amount is None:
            warnings.append(f"第 {i} 行缺少金额")
        parsed_lines.append(
            {
                "line_no": i,
                "trip_no": trip_no or None,
                "waybill_no": waybill_no or None,
                "plate_no": (row.get("plate_no") or "").strip() or None,
                "route": (row.get("route") or "").strip() or None,
                "container_type": (row.get("container_type") or "").strip() or None,
                "quantity": float(qty) if qty is not None else None,
                "unit_price": float(unit_price) if unit_price is not None else None,
                "amount": float(amount) if amount is not None else 0.0,
                "deduction": float(deduction) if deduction is not None else None,
                "remark": (row.get("remark") or "").strip() or None,
                "confidence": 0.95,
                "source_page": None,
            }
        )

    if not parsed_lines:
        raise ValueError("没有可用的明细行")

    sum_total = sum((Decimal(str(line["amount"])) for line in parsed_lines), Decimal("0"))
    total_amount = header_total if header_total is not None else sum_total
    if header_total is not None and abs(sum_total - header_total) > Decimal("0.01"):
        warnings.append(f"明细合计 {sum_total} 与表头合计 {header_total} 不一致")

    doc_id = document_id or settlement_no or f"set-{int(time.time())}"
    return {
        "document_id": doc_id,
        "settlement_no": settlement_no,
        "carrier_name": carrier_name,
        "period_start": period_start or None,
        "period_end": period_end or None,
        "currency": "CNY",
        "total_amount": float(total_amount),
        "source_format": fmt,
        "page_count": None,
        "lines": parsed_lines,
        "warnings": warnings,
        "engine": "rule-text-v1",
        "needs_review": bool(warnings),
        "elapsed_ms": int((time.time() - started) * 1000),
    }


def to_bills(document: dict) -> list[dict]:
    """转成现有 settlement.settle 需要的行格式。"""
    bills = []
    for line in document.get("lines", []):
        booking_no = line.get("trip_no") or line.get("waybill_no") or ""
        bills.append(
            {
                "carrier": document.get("carrier_name") or "",
                "booking_no": booking_no,
                "waybill_no": line.get("waybill_no") or "",
                "route": line.get("route") or "",
                "container_type": line.get("container_type") or "",
                "qty": line.get("quantity") if line.get("quantity") is not None else 1,
                "claimed": line.get("amount"),
                "unit_price": line.get("unit_price"),
            }
        )
    return bills


def _find_bill(document: dict, booking_no: str) -> dict | None:
    for line in document.get("lines", []):
        if (line.get("trip_no") or line.get("waybill_no")) == booking_no:
            return line
    return None


def to_differences(document: dict, settle_result: dict) -> list[dict]:
    """把 settle 的 rows 转成标准 Difference。"""
    doc_id = document.get("document_id") or "set"
    diffs: list[dict] = []
    for i, row in enumerate(settle_result.get("rows", []), 1):
        status = row.get("status")
        if status == "ok":
            continue
        booking_no = row.get("booking_no") or ""
        bill = _find_bill(document, booking_no)
        waybill_no = (bill.get("waybill_no") if bill else None) or booking_no or None
        claimed_unit = bill.get("unit_price") if bill else None
        contract_unit = row.get("price")
        diff_type = "amount_mismatch"
        if status == "no_rate":
            diff_type = "no_rate"
        elif (
            claimed_unit is not None
            and contract_unit is not None
            and abs(float(claimed_unit) - float(contract_unit)) > 0.01
        ):
            diff_type = "unit_price_mismatch"

        evidence = []
        if row.get("booking_no"):
            evidence.append(f"结算单行 {row['booking_no']}")
        if row.get("claimed") is not None:
            evidence.append(f"报账金额 {row['claimed']}")
        if row.get("expected") is not None:
            evidence.append(f"合同应付 {row['expected']}")
        if claimed_unit is not None:
            evidence.append(f"报账单价 {claimed_unit}")
        if contract_unit is not None:
            evidence.append(f"合同单价 {contract_unit}")
        if row.get("note"):
            evidence.append(row["note"])

        diffs.append(
            {
                "difference_id": f"{doc_id}-{booking_no or i}",
                "document_id": doc_id,
                "type": diff_type,
                "waybill_no": waybill_no,
                "trip_no": (bill.get("trip_no") if bill else None),
                "statement_amount": row.get("claimed"),
                "system_amount": row.get("expected"),
                "delta": row.get("diff"),
                "evidence": evidence,
                "possible_causes": [],
                "suggested_action": None,
                "confidence": 0.6,
                "source": "rule",
            }
        )
    return diffs
