"""对账单抽取：文本/CSV/Excel 粘贴 → 标准 StatementDocument。

模型只负责把图片/PDF 变成文本（后续接 OCR）；本模块负责确定性解析。
"""
from __future__ import annotations

import re
import time
from decimal import Decimal

from .table_extract import find_table_header, norm_date, parse_header_lines, parse_table, to_decimal

LINE_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("waybill_no", ("运单号", "客户单号", "提单号", "单号")),
    ("container_no", ("箱号", "柜号", "集装箱号")),
    ("container_type", ("箱型", "柜型")),
    ("total_amount", ("价税合计", "合计金额", "总额")),
    ("amount", ("金额", "运费", "应收")),
    ("tax_amount", ("税额", "税金")),
    ("due_date", ("到期", "付款日", "应收日期")),
    ("remark", ("备注", "说明")),
]

_WAYBILL_RE = re.compile(r"[A-Z]{2,4}\d{6,}")
_CONTAINER_RE = re.compile(r"[A-Z]{4}\d{7}")
_CTYPE_RE = re.compile(r"(20|40|45)(GP|HQ|OT|RF|FR|TK)", re.IGNORECASE)
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_NUM_RE = re.compile(r"\d+(?:\.\d{2})")

HEADER_ALIASES = {
    "statement_no": ("对账单号", "账单号", "statement_no"),
    "customer_name": ("客户名称", "客户", "货主", "customer"),
    "period": ("账期", "期间", "period"),
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
        if not waybill:
            continue
        container = _CONTAINER_RE.search(line)
        ctype = _CTYPE_RE.search(line)
        date = _DATE_RE.search(line)
        nums = [to_decimal(x) for x in _NUM_RE.findall(_DATE_RE.sub(" ", line))]
        amount = tax = total = None
        if len(nums) >= 3:
            amount, tax, total = nums[0], nums[1], nums[2]
        elif len(nums) == 2:
            amount, total = nums[0], nums[1]
        elif len(nums) == 1:
            amount = total = nums[0]
        rows.append(
            {
                "waybill_no": waybill.group(0),
                "container_no": container.group(0) if container else "",
                "container_type": ctype.group(0).upper() if ctype else "",
                "amount": amount,
                "tax_amount": tax,
                "total_amount": total if total is not None else amount,
                "due_date": date.group(0) if date else "",
            }
        )
    return rows


def parse_statement_text(
    text: str,
    document_id: str | None = None,
    source_format: str | None = None,
) -> dict:
    """解析对账单文本，返回符合 pilot.schema.json 的 StatementDocument。"""
    started = time.time()
    fmt = norm_source_format(source_format)
    raw_lines = [ln.rstrip("\n\r") for ln in (text or "").splitlines()]
    lines = [ln for ln in raw_lines if ln.strip()]
    if not lines:
        raise ValueError("对账单内容为空")

    header_idx = find_table_header(lines, LINE_HINTS)
    if header_idx < 0:
        raise ValueError("未找到对账单明细表头（需包含运单号/金额等字段）")

    headers = parse_header_lines(lines[:header_idx])
    rows = parse_table(lines, header_idx, LINE_HINTS)
    if fmt in {"pdf_scan", "image"}:
        ocr_rows = _ocr_rows(lines[header_idx + 1:])
        if ocr_rows:
            rows = ocr_rows
    if not rows:
        raise ValueError("未能从对账单中解析出明细行")

    statement_no = _header_value(headers, HEADER_ALIASES["statement_no"])
    customer_name = _header_value(headers, HEADER_ALIASES["customer_name"]) or ""
    period_start, period_end = _parse_period(_header_value(headers, HEADER_ALIASES["period"]))
    header_total = to_decimal(_header_value(headers, HEADER_ALIASES["total_amount"]))

    warnings: list[str] = []
    if not customer_name:
        warnings.append("缺少客户名称")
    if not statement_no:
        warnings.append("缺少对账单号")

    parsed_lines: list[dict] = []
    for i, row in enumerate(rows, 1):
        waybill_no = (row.get("waybill_no") or "").strip()
        if not waybill_no:
            warnings.append(f"第 {i} 行缺少运单号，已跳过")
            continue
        amount = to_decimal(row.get("amount"))
        tax = to_decimal(row.get("tax_amount"))
        total = to_decimal(row.get("total_amount"))
        if total is None and amount is not None:
            total = amount + (tax or Decimal("0"))
        if amount is None and total is not None:
            amount = total - (tax or Decimal("0"))
        if amount is None and total is None:
            warnings.append(f"第 {i} 行缺少金额")
        parsed_lines.append(
            {
                "line_no": i,
                "waybill_no": waybill_no,
                "container_no": (row.get("container_no") or "").strip() or None,
                "container_type": (row.get("container_type") or "").strip() or None,
                "amount": float(amount) if amount is not None else 0.0,
                "tax_amount": float(tax) if tax is not None else None,
                "total_amount": float(total) if total is not None else None,
                "due_date": norm_date(row.get("due_date")) or None,
                "remark": (row.get("remark") or "").strip() or None,
                "confidence": 0.95,
                "source_page": None,
            }
        )

    if not parsed_lines:
        raise ValueError("没有可用的明细行")

    sum_total = sum(
        (Decimal(str(line["total_amount"] if line["total_amount"] is not None else line["amount"])) for line in parsed_lines),
        Decimal("0"),
    )
    total_amount = header_total if header_total is not None else sum_total
    if header_total is not None and abs(sum_total - header_total) > Decimal("0.01"):
        warnings.append(f"明细合计 {sum_total} 与表头合计 {header_total} 不一致")

    doc_id = document_id or statement_no or f"stmt-{int(time.time())}"
    return {
        "document_id": doc_id,
        "statement_no": statement_no,
        "customer_name": customer_name,
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


def to_reconcile_rows(document: dict) -> list[dict]:
    """转成现有 reconcile 需要的行格式。"""
    rows = []
    for line in document.get("lines", []):
        amount = line.get("total_amount")
        if amount is None:
            amount = line.get("amount")
        rows.append(
            {
                "booking_no": line.get("waybill_no") or "",
                "container_no": line.get("container_no") or "",
                "amount": amount,
            }
        )
    return rows


STATUS_MAP = {
    "amount_diff": "amount_mismatch",
    "missing_in_system": "extra_line",
    "missing_in_statement": "missing_line",
}


def to_differences(document: dict, reconcile_result: dict) -> list[dict]:
    """把 reconcile 的 rows 转成标准 Difference。"""
    doc_id = document.get("document_id") or "stmt"
    diffs: list[dict] = []
    for i, row in enumerate(reconcile_result.get("rows", []), 1):
        status = row.get("status")
        if status == "ok":
            continue
        evidence = []
        if row.get("line"):
            evidence.append(f"对账单第 {row['line']} 行")
        if row.get("statement_amount") is not None:
            evidence.append(f"对账单金额 {row['statement_amount']}")
        if row.get("system_amount") is not None:
            evidence.append(f"系统金额 {row['system_amount']}")
        if row.get("note"):
            evidence.append(row["note"])
        diffs.append(
            {
                "difference_id": f"{doc_id}-{row.get('line') or i}",
                "document_id": doc_id,
                "type": STATUS_MAP.get(status, "amount_mismatch"),
                "waybill_no": row.get("booking_no") or None,
                "statement_amount": row.get("statement_amount"),
                "system_amount": row.get("system_amount"),
                "delta": row.get("diff"),
                "evidence": evidence,
                "possible_causes": [],
                "suggested_action": None,
                "confidence": 0.6,
                "source": "rule",
            }
        )
    return diffs
