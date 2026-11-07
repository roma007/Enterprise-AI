"""应收账款账龄与催收建议。

为什么放在财务链路末端：
- 对账解决"账对不对"，账龄解决"钱收回来没有"
- 老板真正关心的不是准确率，是"还有多少没收、谁欠最久"

口径（必须写清，否则每个财务算出来都不一样）：
- 未收金额 = 应收金额 − 已收金额
- 逾期天数 = 今天 − 到期日（未到期记 0）
- 账龄分档按"逾期天数"：未到期 / 1–30 / 31–60 / 61–90 / 90+
- 客户风险 = 逾期未收占该客户未收的比例 + 最长逾期天数
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from . import thresholds as th


def cuts() -> tuple[int, int, int]:
    return (int(th.get("aging.bucket_1")), int(th.get("aging.bucket_2")),
            int(th.get("aging.bucket_3")))


def buckets() -> tuple[str, str, str, str, str]:
    c1, c2, c3 = cuts()
    return ("未到期", f"1–{c1} 天", f"{c1 + 1}–{c2} 天", f"{c2 + 1}–{c3} 天", f"{c3} 天以上")

_HINTS = {
    "client": ("客户", "货主", "抬头", "单位"),
    "invoice_no": ("发票号", "单号", "运单号", "应收单号"),
    "amount": ("应收", "金额", "价税合计", "应收金额"),
    "due_date": ("到期", "应收日期", "账期截止", "付款日"),
    "paid_amount": ("已收", "已回款", "实收"),
    "paid_date": ("回款日", "收款日", "实际收款"),
}


def _dec(v) -> Decimal:
    if v is None or v == "":
        return Decimal("0")
    s = re.sub(r"[^\d.\-]", "", str(v))
    if not s or s in {"-", "."}:
        return Decimal("0")
    try:
        return Decimal(s).quantize(Decimal("0.01"))
    except InvalidOperation:
        return Decimal("0")


def _date(v) -> date | None:
    s = str(v or "").strip()
    if not s:
        return None
    m = re.search(r"(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})[-/月](\d{1,2})", s)
    if m:
        today = date.today()
        try:
            return date(today.year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


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


def parse_receivables(text: str) -> list[dict]:
    """解析应收台账：CSV / 制表符 / Excel 粘贴都行。"""
    text = text.lstrip("\ufeff")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []

    header_idx = -1
    for i, ln in enumerate(lines[:5]):
        if any(h in ln for hints in _HINTS.values() for h in hints):
            header_idx = i
            break

    if header_idx >= 0:
        sample = "\n".join(lines[header_idx:header_idx + 5])
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(io.StringIO("\n".join(lines[header_idx:])), dialect))
        mapping = _map_header(rows[0])
        data = rows[1:]
    else:
        mapping = {0: "client", 1: "amount", 2: "due_date"}
        data = [re.split(r"\s+", ln) for ln in lines]

    out = []
    for r in data:
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if not rec.get("client") and not rec.get("amount"):
            continue
        rec["amount"] = str(_dec(rec.get("amount")))
        rec["paid_amount"] = str(_dec(rec.get("paid_amount")))
        out.append(rec)
    return out


def _bucket(days: int) -> str:
    c1, c2, c3 = cuts()
    if days <= 0:
        return "未到期"
    if days <= c1:
        return f"1–{c1} 天"
    if days <= c2:
        return f"{c1 + 1}–{c2} 天"
    if days <= c3:
        return f"{c2 + 1}–{c3} 天"
    return f"{c3} 天以上"


def aging(rows: list[dict], as_of: date | None = None) -> dict:
    as_of = as_of or date.today()
    items = []
    clients: dict[str, dict] = {}

    for r in rows:
        amount = _dec(r.get("amount"))
        paid = _dec(r.get("paid_amount"))
        outstanding = amount - paid
        due = _date(r.get("due_date"))
        if due is None:
            days = 0
        else:
            days = (as_of - due).days
        overdue = max(0, days)
        b = _bucket(overdue)

        item = {
            "client": r.get("client", ""),
            "invoice_no": r.get("invoice_no", "") or r.get("booking_no", ""),
            "amount": float(amount),
            "paid_amount": float(paid),
            "outstanding": float(outstanding),
            "due_date": due.isoformat() if due else "",
            "overdue_days": overdue,
            "bucket": b,
            "paid_off": outstanding <= Decimal("0.01"),
        }
        items.append(item)

        c = clients.setdefault(item["client"] or "未填客户", {
            "client": item["client"] or "未填客户",
            "total": Decimal("0"), "outstanding": Decimal("0"),
            "overdue": Decimal("0"), "max_days": 0, "count": 0,
        })
        c["total"] += amount
        c["outstanding"] += outstanding
        c["count"] += 1
        # 只有还欠钱的单才计入逾期；已结清的单不该拉高客户的逾期天数
        if overdue > 0 and outstanding > Decimal("0.01"):
            c["overdue"] += outstanding
            c["max_days"] = max(c["max_days"], overdue)

    summary = []
    for c in clients.values():
        ratio = (c["overdue"] / c["outstanding"]) if c["outstanding"] > 0 else Decimal("0")
        level, advice = _advice(float(ratio), c["max_days"], float(c["overdue"]))
        summary.append({
            "client": c["client"],
            "count": c["count"],
            "total": float(c["total"]),
            "outstanding": float(c["outstanding"]),
            "overdue": float(c["overdue"]),
            "overdue_ratio": round(float(ratio), 4),
            "max_overdue_days": c["max_days"],
            "level": level,
            "advice": advice,
        })
    summary.sort(key=lambda x: (-x["overdue"], -x["max_overdue_days"]))

    bucket_totals = {b: Decimal("0") for b in buckets()}
    for it in items:
        if not it["paid_off"]:
            bucket_totals[it["bucket"]] += Decimal(str(it["outstanding"]))

    total_out = sum((Decimal(str(i["outstanding"])) for i in items), Decimal("0"))
    total_overdue = sum((Decimal(str(i["outstanding"])) for i in items if i["overdue_days"] > 0), Decimal("0"))

    return {
        "as_of": as_of.isoformat(),
        "summary": {
            "rows": len(items),
            "clients": len(summary),
            "total_receivable": float(sum((Decimal(str(i["amount"])) for i in items), Decimal("0"))),
            "total_outstanding": float(total_out),
            "total_overdue": float(total_overdue),
            "overdue_ratio": round(float(total_overdue / total_out) if total_out > 0 else 0.0, 4),
            "counts": {k: sum(1 for s in summary if s["level"] == k)
                       for k in ("正常", "提醒", "催收", "重点催收")},
            "buckets": {k: float(v) for k, v in bucket_totals.items()},
        },
        "clients": summary,
        "items": items,
    }


def _advice(ratio: float, max_days: int, overdue_amount: float) -> tuple[str, str]:
    """按"最长逾期天数"分档。天数是最稳定的口径，金额只影响话术强度。

    刻意不用"逾期占比"来分级：占比高但只逾期 3 天，不值得发催款函。
    """
    remind = int(th.get("aging.remind_days"))
    collect = int(th.get("aging.collect_days"))
    if max_days <= 0:
        return "正常", "未逾期，保持常规跟进"
    if max_days <= remind:
        return "提醒", "发对账单时顺带提醒付款日期"
    if max_days <= collect:
        extra = "；金额较大，建议先电话沟通" if overdue_amount >= 5000 else ""
        return "催收", "电话催收 + 书面催款函，明确最后付款日" + extra
    return "重点催收", "暂停接新单，走合同违约条款，必要时法务介入"


def export_csv(result: dict) -> str:
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["客户", "笔数", "应收合计", "未收", "逾期未收", "逾期占比",
                "最长逾期天数", "等级", "建议"])
    for c in result["clients"]:
        w.writerow([c["client"], c["count"], c["total"], c["outstanding"], c["overdue"],
                    f'{c["overdue_ratio"]*100:.1f}%', c["max_overdue_days"],
                    c["level"], c["advice"]])
    w.writerow([])
    w.writerow(["明细"])
    w.writerow(["客户", "单号", "应收", "已收", "未收", "到期日", "逾期天数", "账龄档"])
    for i in result["items"]:
        w.writerow([i["client"], i["invoice_no"], i["amount"], i["paid_amount"],
                    i["outstanding"], i["due_date"], i["overdue_days"], i["bucket"]])
    return buf.getvalue()


def demo_rows() -> list[dict]:
    """演示数据：6 个客户，覆盖四个账龄档。"""
    return [
        {"client": "宁波宏运集卡运输有限公司", "invoice_no": "INV-1001", "amount": "2600", "paid_amount": "0", "due_date": "2026-11-20"},
        {"client": "宁波宏运集卡运输有限公司", "invoice_no": "INV-1002", "amount": "1800", "paid_amount": "1800", "due_date": "2026-10-15"},
        {"client": "海通国际物流", "invoice_no": "INV-2001", "amount": "5200", "paid_amount": "0", "due_date": "2026-09-10"},
        {"client": "海通国际物流", "invoice_no": "INV-2002", "amount": "3100", "paid_amount": "1000", "due_date": "2026-10-05"},
        {"client": "中远海运物流", "invoice_no": "INV-3001", "amount": "8800", "paid_amount": "0", "due_date": "2026-07-01"},
        {"client": "中远海运物流", "invoice_no": "INV-3002", "amount": "4200", "paid_amount": "4200", "due_date": "2026-08-20"},
        {"client": "东方国际货运", "invoice_no": "INV-4001", "amount": "1500", "paid_amount": "0", "due_date": "2026-10-25"},
        {"client": "顺捷国际", "invoice_no": "INV-5001", "amount": "3000", "paid_amount": "0", "due_date": "2026-11-30"},
        {"client": "泰隆国际", "invoice_no": "INV-6001", "amount": "9600", "paid_amount": "2000", "due_date": "2026-06-15"},
    ]
