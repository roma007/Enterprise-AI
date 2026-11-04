"""表格类单据的通用解析工具：表头、分隔符、金额、日期。

只做确定性解析，不调用模型；OCR/LLM 负责把文件变成文本，这里负责把文本变成行。
"""
from __future__ import annotations

import csv
import io
import re
from decimal import Decimal, InvalidOperation

HEADER_RE = re.compile(r"^([^:：]{1,24})[:：]\s*(.+)$")
DATE_RE = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")


def to_decimal(value) -> Decimal | None:
    if value is None or value == "":
        return None
    s = re.sub(r"[^\d.\-]", "", str(value))
    if not s or s in {"-", "."}:
        return None
    try:
        return Decimal(s).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def norm_date(value) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    m = DATE_RE.search(s)
    if not m:
        return s
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def parse_header_lines(lines: list[str]) -> dict[str, str]:
    """解析 '键: 值' 形式的表头。"""
    out: dict[str, str] = {}
    for line in lines:
        m = HEADER_RE.match(line.strip())
        if not m:
            continue
        key = re.sub(r"\s+", "", m.group(1)).lower()
        out[key] = m.group(2).strip()
    return out


def find_table_header(lines: list[str], hints: list[tuple[str, tuple[str, ...]]]) -> int:
    for i, line in enumerate(lines[:8]):
        if all(any(h in line for h in hs) for _, hs in hints[:2]) or any(
            h in line for _, hs in hints for h in hs
        ):
            # 至少命中 2 个不同字段，避免把普通说明行当表头
            hits = sum(1 for _, hs in hints if any(h in line for h in hs))
            if hits >= 2:
                return i
    return -1


def map_header(columns: list[str], hints: list[tuple[str, tuple[str, ...]]]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for i, col in enumerate(columns):
        name = (col or "").strip().lower().replace(" ", "")
        for key, hs in hints:
            if key in mapping.values():
                continue
            if any(h.lower() in name for h in hs):
                mapping[i] = key
                break
    return mapping


def _reader(text: str):
    if "\t" in text:
        return csv.reader(io.StringIO(text), delimiter="\t")
    first = text.splitlines()[0] if text.splitlines() else ""
    if "," in first:
        return csv.reader(io.StringIO(text), delimiter=",")
    try:
        dialect = csv.Sniffer().sniff(text[:2000], delimiters=",\t;|")
        return csv.reader(io.StringIO(text), dialect)
    except csv.Error:
        return None


def parse_table(
    lines: list[str],
    start: int,
    hints: list[tuple[str, tuple[str, ...]]],
) -> list[dict]:
    block = "\n".join(lines[start:])
    reader = _reader(block)
    if reader is None:
        rows = [re.split(r"\s+", ln.strip()) for ln in lines[start:] if ln.strip()]
    else:
        rows = list(reader)
    if not rows:
        return []
    mapping = map_header(rows[0], hints)
    if not mapping:
        # 没有可识别表头时，按 hints 顺序做位置映射，便于简单文本
        mapping = {i: key for i, (key, _) in enumerate(hints)}
    out: list[dict] = []
    for r in rows[1:]:
        if not any((c or "").strip() for c in r):
            continue
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if any(rec.values()):
            out.append(rec)
    return out
