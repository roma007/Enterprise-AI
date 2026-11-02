"""三单匹配（订单 ↔ 运单 ↔ 发票）。

为什么要有这一步：
- 发票识别只解决了"把票读出来"，没解决"这张票配不配这张运单"
- 对账之所以要 2 个人 5 天，就是在做这件事——人肉比对三张单
- 这一步自动化了，"自动对账"才成立

三个维度，权重不同：
  箱号（硬）  对不上 → 一定有问题，直接阻断
  金额（硬）  差异超过 1% → 阻断；1% 内 → 提醒
  客户（软）  对不上 → 提醒（可能是代付/三方协议）

金额口径：运单的 freight 视为含税应收，与发票的价税合计比。
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from .pairing import _customer  # 复用同一套公司名归一

AMOUNT_TOLERANCE_PCT = Decimal("0.01")   # 1%
AMOUNT_TOLERANCE_ABS = Decimal("1.00")   # 或 1 元


def _containers(v) -> set[str]:
    if not v:
        return set()
    items = re.split(r"[,，、;；\s]+", str(v))
    return {re.sub(r"[^0-9A-Za-z]", "", x).upper() for x in items if x.strip()}


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


def match(booking: dict, waybill: dict, invoice: dict) -> dict:
    dims: list[dict] = []
    hard_fail = False
    soft_fail = False

    # ---------- 1. 箱号 ----------
    bc, wc, ic = (_containers(booking.get("container_no")),
                  _containers(waybill.get("container_no")),
                  _containers(invoice.get("container_no")))

    if bc and wc and bc != wc:
        missing = bc - wc
        extra = wc - bc
        detail = f"订单 {len(bc)} 个 / 运单 {len(wc)} 个"
        if missing:
            detail += f"；运单缺 {','.join(sorted(missing)[:3])}"
        if extra:
            detail += f"；运单多 {','.join(sorted(extra)[:3])}"
        dims.append({"key": "container", "label": "箱号", "result": "mismatch", "detail": detail})
        hard_fail = True
    elif bc and wc:
        dims.append({"key": "container", "label": "箱号", "result": "match",
                     "detail": f"{len(bc)} 个箱号一致"})
    else:
        dims.append({"key": "container", "label": "箱号", "result": "unknown",
                     "detail": "有一方没提供箱号，无法比对"})

    # 发票一般没有箱号，有就顺带核对
    if ic and bc and ic != bc:
        dims.append({"key": "container_invoice", "label": "箱号（发票）",
                     "result": "mismatch",
                     "detail": f"发票箱号 {len(ic)} 个与订单不一致"})
        soft_fail = True

    # ---------- 2. 金额 ----------
    inv_total = _dec(invoice.get("total_amount"))
    wb_amount = _dec(waybill.get("freight") or waybill.get("amount"))
    if inv_total is not None and wb_amount is not None:
        diff = inv_total - wb_amount
        base = wb_amount if wb_amount else Decimal("1")
        pct = (diff / base) if base else Decimal("0")
        ok = abs(diff) <= AMOUNT_TOLERANCE_ABS or abs(pct) <= AMOUNT_TOLERANCE_PCT
        dims.append({
            "key": "amount", "label": "金额",
            "result": "match" if ok else "mismatch",
            "detail": f"发票价税合计 {inv_total} / 运单应收 {wb_amount}，差 {diff}（{pct*100:.2f}%）",
            "invoice": float(inv_total), "waybill": float(wb_amount),
            "diff": float(diff), "diff_pct": round(float(pct), 4),
        })
        if not ok:
            hard_fail = True
    else:
        dims.append({"key": "amount", "label": "金额", "result": "unknown",
                     "detail": "有一方没提供金额，无法比对"})

    # ---------- 3. 客户 ----------
    bcust = _customer(booking.get("client"))
    icust = _customer(invoice.get("buyer_name"))
    if bcust and icust:
        same = bcust in icust or icust in bcust
        dims.append({
            "key": "client", "label": "客户", "result": "match" if same else "mismatch",
            "detail": f"订单客户「{booking.get('client','')}」/ 发票抬头「{invoice.get('buyer_name','')}」",
        })
        if not same:
            soft_fail = True
    else:
        dims.append({"key": "client", "label": "客户", "result": "unknown",
                     "detail": "有一方没提供客户名称"})

    # ---------- 4. 箱量 ----------
    try:
        qty = int(str(booking.get("container_qty") or "").strip() or 0)
    except ValueError:
        qty = 0
    if qty and bc:
        ok = qty == len(bc)
        dims.append({
            "key": "qty", "label": "箱量", "result": "match" if ok else "mismatch",
            "detail": f"订单箱量 {qty} / 实际箱号 {len(bc)} 个",
        })
        if not ok:
            soft_fail = True

    overall = "blocked" if hard_fail else ("review" if soft_fail else "pass")
    return {
        "overall": overall,
        "dimensions": dims,
        "summary": {
            "pass": sum(1 for d in dims if d["result"] == "match"),
            "mismatch": sum(1 for d in dims if d["result"] == "mismatch"),
            "unknown": sum(1 for d in dims if d["result"] == "unknown"),
        },
    }


def verdict_text(result: dict) -> str:
    return {
        "pass": "✅ 三单一致，可以付款",
        "review": "🟡 有软性差异，需人工确认",
        "blocked": "🔴 存在硬性不符，不能付款",
    }.get(result["overall"], result["overall"])
