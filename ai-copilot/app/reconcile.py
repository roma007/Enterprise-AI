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

Step 2：表头同义词、匹配键、金额字段、状态文案、展示字段来自行业包
（`packs/<id>/reconcile.json`）；匹配/双向比对/汇总算法仍在本模块。
"""
from __future__ import annotations

import csv
import io
import re
from decimal import Decimal, InvalidOperation

from . import thresholds as th
from .pack import current_pack, register_listener

# 容差仍在 settings（reconcile.tolerance）；其余口径来自 pack。
# 可变容器原地刷新，保证热切换后已 import 的调用方看到新口径。
_SPEC: dict = {}
_STATEMENT: dict = {}
_MATCH: dict = {}
_DISPLAY: dict = {}
_HINTS: dict = {}
POSITIONAL_DEFAULT: dict = {}
SYSTEM_AMOUNT_FIELDS: list = []
STATUS_LABELS: dict = {}
_MATCH_KEYS: list = []
_MULTI_KEYS: set = set()
_AMOUNT_FIELD: list[str] = ["amount"]


def _apply(pack) -> None:
    spec = pack.reconcile or {}
    st = spec.get("statement") or {}
    match = spec.get("match") or {}
    _SPEC.clear()
    _SPEC.update(spec)
    _STATEMENT.clear()
    _STATEMENT.update(st)
    _MATCH.clear()
    _MATCH.update(match)
    _DISPLAY.clear()
    _DISPLAY.update(st.get("display") or {})
    _HINTS.clear()
    _HINTS.update({k: tuple(v) for k, v in (st.get("header_hints") or {}).items()})
    POSITIONAL_DEFAULT.clear()
    POSITIONAL_DEFAULT.update({i: k for i, k in enumerate(st.get("positional") or [])})
    SYSTEM_AMOUNT_FIELDS[:] = list(st.get("amount_fields") or ())
    STATUS_LABELS.clear()
    STATUS_LABELS.update(spec.get("statuses") or {})
    _MATCH_KEYS[:] = list(match.get("keys") or ("booking_no", "container_no"))
    _MULTI_KEYS.clear()
    _MULTI_KEYS.update(match.get("multi") or ())
    _AMOUNT_FIELD[0] = st.get("amount_field") or "amount"


_apply(current_pack())
register_listener(_apply)


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


def _values_for(key: str, value) -> list[str]:
    """按匹配键取归一化值；multi 键（如箱号）按分隔符拆成多个。"""
    if value is None or value == "":
        return []
    if key in _MULTI_KEYS:
        return [_norm(x) for x in re.split(r"[,，、;；\s]+", str(value)) if _norm(x)]
    v = _norm(value)
    return [v] if v else []


def _containers(v) -> set[str]:
    """兼容旧调用：把任意文本拆成归一化箱号集合。"""
    if not v:
        return set()
    return set(_values_for("container_no", v))


def _system_amount(w: dict):
    """系统侧金额字段按优先级取第一个非空值（与原 or 链等价）。"""
    for key in SYSTEM_AMOUNT_FIELDS:
        if w.get(key):
            return w.get(key)
    return None


# ---------- 对账单解析 ----------

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

    # 1) 找表头行（含任一同义词）
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
        # 没有表头：按空白切，按 pack 的 positional 顺序
        mapping = dict(POSITIONAL_DEFAULT)
        data = [re.split(r"\s+", ln) for ln in raw_lines]
        mode = "positional"

    out = []
    for r in data:
        if not any((c or "").strip() for c in r):
            continue
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if not any(rec.get(k) for k in _MATCH_KEYS):
            continue
        out.append(rec)

    return {"rows": out, "mapping": {k: v for v, k in mapping.items()}, "mode": mode}


# ---------- 对账 ----------

def reconcile(statement_rows: list[dict], waybills: list[dict],
              tolerance: Decimal | None = None) -> dict:
    if tolerance is None:
        tolerance = Decimal(str(th.get("reconcile.tolerance")))

    # 按匹配键建索引：单值键后写覆盖（与原 by_no 一致），multi 键先写优先（与原 by_box 一致）。
    indexes: dict[str, dict[str, dict]] = {key: {} for key in _MATCH_KEYS}
    for w in waybills:
        for key in _MATCH_KEYS:
            for value in _values_for(key, w.get(key)):
                if key in _MULTI_KEYS:
                    indexes[key].setdefault(value, w)
                else:
                    indexes[key][value] = w

    used: set[int] = set()
    rows: list[dict] = []

    def idx_of(w: dict) -> int:
        return id(w)

    no_key = _DISPLAY.get("no") or "booking_no"
    container_key = _DISPLAY.get("container") or "container_no"

    def display_values(w: dict | None, s: dict) -> tuple[str, str]:
        no = (w.get(no_key) if w else "") or s.get(no_key, "")
        container = (w.get(container_key) if w else "") or s.get(container_key, "")
        return no, container

    for i, s in enumerate(statement_rows):
        s_amt = _dec(s.get(_AMOUNT_FIELD[0]))

        w = None
        for key in _MATCH_KEYS:
            for value in _values_for(key, s.get(key)):
                if value in indexes[key]:
                    w = indexes[key][value]
                    break
            if w is not None:
                break

        no, container = display_values(w, s)

        if w is None:
            rows.append({
                "line": i + 1, "status": "missing_in_system",
                "no": no, "container": container,
                "booking_no": no, "container_no": container,
                "statement_amount": float(s_amt) if s_amt is not None else None,
                "system_amount": None, "diff": None,
                "note": "对账单有、系统里没有（可能多收或错开）",
            })
            continue

        used.add(idx_of(w))
        w_amt = _dec(_system_amount(w))
        if s_amt is not None and w_amt is not None:
            diff = s_amt - w_amt
            status = "ok" if abs(diff) <= tolerance else "amount_diff"
        else:
            diff = None
            status = "ok" if s_amt is None and w_amt is None else "amount_diff"

        rows.append({
            "line": i + 1, "status": status,
            "no": no, "container": container,
            "booking_no": no, "container_no": container,
            "statement_amount": float(s_amt) if s_amt is not None else None,
            "system_amount": float(w_amt) if w_amt is not None else None,
            "diff": float(diff) if diff is not None else None,
            "note": "" if status == "ok" else "金额不一致",
        })

    # 反向：系统有、对账单没有 → 漏单
    for w in waybills:
        if idx_of(w) in used:
            continue
        no = w.get(no_key, "")
        container = w.get(container_key, "")
        rows.append({
            "line": None, "status": "missing_in_statement",
            "no": no, "container": container,
            "booking_no": no, "container_no": container,
            "statement_amount": None,
            "system_amount": float(_dec(_system_amount(w)) or 0),
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
    no_label = _DISPLAY.get("no_label") or "单号"
    container_label = _DISPLAY.get("container_label") or "箱号"
    w.writerow(["行号", "状态", no_label, container_label,
                "对账单金额", "系统金额", "差额", "说明"])
    for r in result["rows"]:
        w.writerow([
            r["line"] or "",
            STATUS_LABELS.get(r["status"], r["status"]),
            r.get("no") or r.get("booking_no", ""),
            r.get("container") or r.get("container_no", ""),
            r["statement_amount"] if r["statement_amount"] is not None else "",
            r["system_amount"] if r["system_amount"] is not None else "",
            r["diff"] if r["diff"] is not None else "",
            r["note"],
        ])
    return buf.getvalue()
