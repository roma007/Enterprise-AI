"""账单级自动对账（客户对账单 ↔ 系统运单）。

这是财务侧最贵的一件事：2 人 × 5 天/月，逐条对。
和「三单匹配」的区别：
- 三单匹配 = 一票货，核订单/运单/发票是否一致（单票级）
- 自动对账 = 客户发来一张对账单，上面几十上百条，批量找差异（账单级）

对账要回答四个问题：
1. 客户报了、系统也有，金额一样      → 没问题
2. 客户报了、系统也有，金额不一样    → **差异（要谈）**
3. 客户报了、系统没有                → **可能多收/错开（要查）**
4. 系统有、客户没报                  → **漏单（要追）**

第 4 类最容易被忽略，也最容易漏钱——所以必须双向比对，不能只顺着对账单看。
"""
from __future__ import annotations

import csv
import io
import re
from decimal import Decimal, InvalidOperation

MATCH_TOLERANCE = Decimal("0.01")


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


def _norm(v) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", str(v or "")).upper()


def _containers(v) -> set[str]:
    if not v:
        return set()
    return {_norm(x) for x in re.split(r"[,，、;；\s]+", str(v)) if _norm(x)}


# ---------- 对账单解析 ----------

_HINTS = {
    "booking_no": ("运单号", "委托单号", "单号", "托书号", "订单号", "提单号"),
    "container_no": ("箱号", "柜号", "集装箱号"),
    "amount": ("金额", "运费", "应收", "应收金额", "价税合计", "合计"),
    "client": ("客户", "货主", "抬头"),
}


def _map_header(cols: list[str]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for i, c in enumerate(cols):
        name = (c or "").strip().lower().replace(" ", "")
        for key, hints in _HINTS.items():
            if key in mapping.values():
                continue
            if any(h.lower() in name for h in hints):
                mapping[i] = key
                break
    return mapping


def parse_statement(text: str) -> dict:
    """解析客户对账单：CSV / 制表符 / 空格分隔都能吃。"""
    text = text.lstrip("\ufeff")
    raw_lines = [ln for ln in text.splitlines() if ln.strip()]
    if not raw_lines:
        return {"rows": [], "mapping": {}, "note": "空对账单"}

    # 1) 找表头行（含"单号/箱号/金额"之一）
    header_idx = -1
    for i, ln in enumerate(raw_lines[:5]):
        if any(h in ln for hints in _HINTS.values() for h in hints):
            header_idx = i
            break

    if header_idx >= 0:
        sample = "\n".join(raw_lines[header_idx: header_idx + 5])
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(io.StringIO("\n".join(raw_lines[header_idx:])), dialect))
        mapping = _map_header(rows[0])
        data = rows[1:]
        mode = "header"
    else:
        # 没有表头：按空白切，约定「单号 箱号 金额」的顺序
        mapping = {0: "booking_no", 1: "container_no", 2: "amount"}
        data = [re.split(r"\s+", ln) for ln in raw_lines]
        mode = "positional"

    out = []
    for r in data:
        if not any((c or "").strip() for c in r):
            continue
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if not rec.get("booking_no") and not rec.get("container_no"):
            continue
        out.append(rec)

    return {"rows": out, "mapping": {k: v for v, k in mapping.items()}, "mode": mode}


# ---------- 对账 ----------

def reconcile(statement_rows: list[dict], waybills: list[dict],
              tolerance: Decimal = MATCH_TOLERANCE) -> dict:
    by_no: dict[str, dict] = {}
    by_box: dict[str, dict] = {}
    for w in waybills:
        no = _norm(w.get("booking_no"))
        if no:
            by_no[no] = w
        for c in _containers(w.get("container_no")):
            by_box.setdefault(c, w)

    used: set[int] = set()
    rows: list[dict] = []

    def idx_of(w: dict) -> int:
        return id(w)

    for i, s in enumerate(statement_rows):
        s_no = _norm(s.get("booking_no"))
        s_boxes = _containers(s.get("container_no"))
        s_amt = _dec(s.get("amount"))

        w = by_no.get(s_no) if s_no else None
        if w is None and s_boxes:
            for c in s_boxes:
                if c in by_box:
                    w = by_box[c]
                    break

        if w is None:
            rows.append({
                "line": i + 1, "status": "missing_in_system",
                "booking_no": s.get("booking_no", ""),
                "container_no": s.get("container_no", ""),
                "statement_amount": float(s_amt) if s_amt is not None else None,
                "system_amount": None, "diff": None,
                "note": "对账单有、系统里没有（可能多收或错开）",
            })
            continue

        used.add(idx_of(w))
        w_amt = _dec(w.get("freight") or w.get("amount") or w.get("total_amount"))
        if s_amt is not None and w_amt is not None:
            diff = s_amt - w_amt
            status = "ok" if abs(diff) <= tolerance else "amount_diff"
        else:
            diff = None
            status = "ok" if s_amt is None and w_amt is None else "amount_diff"

        rows.append({
            "line": i + 1, "status": status,
            "booking_no": w.get("booking_no") or s.get("booking_no", ""),
            "container_no": w.get("container_no") or s.get("container_no", ""),
            "statement_amount": float(s_amt) if s_amt is not None else None,
            "system_amount": float(w_amt) if w_amt is not None else None,
            "diff": float(diff) if diff is not None else None,
            "note": "" if status == "ok" else "金额不一致",
        })

    # 反向：系统有、对账单没有 → 漏单
    for w in waybills:
        if idx_of(w) in used:
            continue
        rows.append({
            "line": None, "status": "missing_in_statement",
            "booking_no": w.get("booking_no", ""),
            "container_no": w.get("container_no", ""),
            "statement_amount": None,
            "system_amount": float(_dec(w.get("freight") or w.get("amount") or w.get("total_amount")) or 0),
            "diff": None,
            "note": "系统有、对账单没报（客户漏单，要追）",
        })

    def total(items, key):
        vals = [Decimal(str(r[key])) for r in items if r.get(key) is not None]
        return float(sum(vals, Decimal("0")))

    st_total = total([r for r in rows if r["statement_amount"] is not None], "statement_amount")
    sys_total = total([r for r in rows if r["system_amount"] is not None], "system_amount")
    diff_total = float(Decimal(str(st_total)) - Decimal(str(sys_total)))

    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    return {
        "summary": {
            "statement_lines": len(statement_rows),
            "waybills": len(waybills),
            "rows": len(rows),
            "ok": counts.get("ok", 0),
            "amount_diff": counts.get("amount_diff", 0),
            "missing_in_system": counts.get("missing_in_system", 0),
            "missing_in_statement": counts.get("missing_in_statement", 0),
            "statement_total": st_total,
            "system_total": sys_total,
            "diff_total": diff_total,
            "needs_action": len(rows) - counts.get("ok", 0),
        },
        "rows": rows,
    }


def export_csv(result: dict) -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["行号", "状态", "单号", "箱号", "对账单金额", "系统金额", "差额", "说明"])
    label = {"ok": "一致", "amount_diff": "金额不符",
             "missing_in_system": "系统无此单", "missing_in_statement": "客户漏单"}
    for r in result["rows"]:
        w.writerow([r["line"] or "", label.get(r["status"], r["status"]),
                    r["booking_no"], r["container_no"],
                    r["statement_amount"] if r["statement_amount"] is not None else "",
                    r["system_amount"] if r["system_amount"] is not None else "",
                    r["diff"] if r["diff"] is not None else "",
                    r["note"]])
    return buf.getvalue()
