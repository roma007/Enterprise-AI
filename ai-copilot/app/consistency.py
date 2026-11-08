"""单证一致性检查（AI-43）。

输入：托书、发票、对账单（任意两份即可）。
输出：逐项一致性检查 + 差异说明。

边界：
- 字段先由各单据自己的抽取器读取；规则比对。
- 模型只写差异说明，不改变字段值、不新增数字。
- 客户名只做参考比对：发票购买方未必等于托书客户，低相似度只标 warn，不判错。
- 不做自动改单、不自动入账。
"""
from __future__ import annotations

import difflib
import re
from decimal import Decimal

from . import thresholds as th
from .extract import extract
from .invoice import extract_invoice
from .reconcile import _containers, _norm
from .statement import parse_statement_text, to_reconcile_rows


def _clean(value) -> str:
    return str(value or "").strip()


def _company(value: str) -> str:
    text = re.sub(r"[\s（）()·,，.。]", "", _clean(value))
    for suffix in ("有限责任公司", "有限公司", "集团", "公司"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return text


def _similar(a: str, b: str) -> float:
    a, b = _company(a), _company(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _dec(value) -> Decimal | None:
    text = re.sub(r"[^\d.\-]", "", _clean(value))
    if not text or text in {"-", "."}:
        return None
    try:
        return Decimal(text).quantize(Decimal("0.01"))
    except Exception:  # noqa: BLE001
        return None


def _statement_rows(text: str) -> list[dict]:
    try:
        doc = parse_statement_text(text)
        return to_reconcile_rows(doc)
    except ValueError:
        from .reconcile import parse_statement

        return parse_statement(text).get("rows", [])


def _matching_rows(booking: dict, rows: list[dict]) -> list[dict]:
    b_no = _norm(booking.get("booking_no"))
    b_boxes = _containers(booking.get("container_no"))
    matched = [r for r in rows if b_no and _norm(r.get("booking_no")) == b_no]
    if not matched and b_boxes:
        matched = [r for r in rows if b_boxes & _containers(r.get("container_no"))]
    return matched


def _check(field: str, status: str, expected: str = "", actual: str = "",
           detail: str = "", evidence: str = "") -> dict:
    return {"field": field, "status": status, "expected": expected,
            "actual": actual, "detail": detail, "evidence": evidence}


def check(booking_text: str, invoice_text: str = "", statement_text: str = "",
          use_llm: bool = True) -> dict:
    booking_text = (booking_text or "").strip()
    invoice_text = (invoice_text or "").strip()
    statement_text = (statement_text or "").strip()
    if not booking_text:
        raise ValueError("至少需要托书")
    if not invoice_text and not statement_text:
        raise ValueError("至少再提供发票或对账单中的一份")

    b_draft = extract(booking_text, allow_llm=use_llm)
    b = {k: (v.value or "") for k, v in b_draft.fields.items()}
    i_draft = extract_invoice(invoice_text, allow_llm=use_llm) if invoice_text else None
    inv = {k: (v.value or "") for k, v in i_draft.fields.items()} if i_draft else {}
    rows = _statement_rows(statement_text) if statement_text else []
    matched = _matching_rows(b, rows) if rows else []

    checks: list[dict] = []

    if statement_text:
        b_no = _clean(b.get("booking_no"))
        if b_no:
            if matched:
                checks.append(_check("单号", "ok", b_no, _clean(matched[0].get("booking_no")),
                                     "对账单找到该单号", "对账单"))
            else:
                checks.append(_check("单号", "warn", b_no, "",
                                     "对账单未找到该单号，可能漏单或单号不一致", "对账单"))
        else:
            checks.append(_check("单号", "skip", "", "", "托书未识别出委托单号"))

    if statement_text and matched:
        b_boxes = _containers(b.get("container_no"))
        s_boxes = set()
        for r in matched:
            s_boxes |= _containers(r.get("container_no"))
        if b_boxes and s_boxes:
            missing = sorted(b_boxes - s_boxes)
            extra = sorted(s_boxes - b_boxes)
            if not missing and not extra:
                checks.append(_check("箱号", "ok", ",".join(sorted(b_boxes)),
                                     ",".join(sorted(s_boxes)), "箱号一致", "对账单"))
            else:
                detail = []
                if missing:
                    detail.append("对账单缺少：" + ",".join(missing))
                if extra:
                    detail.append("对账单多出：" + ",".join(extra))
                checks.append(_check("箱号", "warn", ",".join(sorted(b_boxes)),
                                     ",".join(sorted(s_boxes)), "；".join(detail), "对账单"))
        else:
            checks.append(_check("箱号", "skip", "", "", "托书或对账单箱号缺失"))

        b_client = _clean(b.get("client"))
        s_client = _clean(matched[0].get("client"))
        if b_client and s_client:
            score = _similar(b_client, s_client)
            if score >= 0.8:
                checks.append(_check("客户", "ok", b_client, s_client,
                                     f"名称相似度 {score:.0%}", "对账单"))
            else:
                checks.append(_check("客户", "warn", b_client, s_client,
                                     f"名称相似度仅 {score:.0%}，请核对是否同一客户", "对账单"))

        b_amt = _dec(b.get("freight"))
        s_amt = _dec(matched[0].get("amount"))
        if b_amt is not None and s_amt is not None:
            tol = Decimal(str(th.get("reconcile.tolerance")))
            if abs(b_amt - s_amt) <= tol:
                checks.append(_check("金额", "ok", f"{b_amt}", f"{s_amt}",
                                     "金额一致", "托书/对账单"))
            else:
                checks.append(_check("金额", "warn", f"{b_amt}", f"{s_amt}",
                                     f"差额 {b_amt - s_amt}", "托书/对账单"))
        else:
            checks.append(_check("金额", "skip", "", "", "托书运费或对账单金额缺失"))

    if invoice_text:
        inv_total = _dec(inv.get("total_amount"))
        if statement_text and len(matched) == 1:
            s_amt = _dec(matched[0].get("amount"))
            if inv_total is not None and s_amt is not None:
                tol = Decimal(str(th.get("reconcile.tolerance")))
                if abs(inv_total - s_amt) <= tol:
                    checks.append(_check("发票价税合计", "ok", f"{inv_total}", f"{s_amt}",
                                         "发票与对账单金额一致", "发票/对账单"))
                else:
                    checks.append(_check("发票价税合计", "warn", f"{inv_total}", f"{s_amt}",
                                         f"差额 {inv_total - s_amt}", "发票/对账单"))
        elif statement_text:
            checks.append(_check("发票价税合计", "skip", "", "",
                                 "对账单匹配到多行，无法直接按发票总额比对"))
        b_client = _clean(b.get("client"))
        inv_buyer = _clean(inv.get("buyer_name"))
        if b_client and inv_buyer:
            score = _similar(b_client, inv_buyer)
            checks.append(_check("发票购买方", "ok" if score >= 0.8 else "warn",
                                 b_client, inv_buyer,
                                 f"名称相似度 {score:.0%}；购买方未必等于托书客户，仅供参考",
                                 "托书/发票"))

    summary = {
        "ok": sum(1 for x in checks if x["status"] == "ok"),
        "warn": sum(1 for x in checks if x["status"] == "warn"),
        "skip": sum(1 for x in checks if x["status"] == "skip"),
        "total": len(checks),
    }
    explanation = _explain(checks, use_llm)
    return {
        "summary": summary,
        "checks": checks,
        "explanation": explanation["text"],
        "engine": "+".join(x for x in (b_draft.engine,
                                       i_draft.engine if i_draft else "",
                                       explanation["engine"]) if x),
        "warnings": [x for x in (b_draft.note, i_draft.note if i_draft else "") if x],
    }


def _rule_explain(checks: list[dict]) -> str:
    bad = [x for x in checks if x["status"] == "warn"]
    if not bad:
        return "单证关键字段一致；仍建议人工抽查金额和客户名。"
    return "发现 " + "、".join(x["field"] for x in bad) + " 不一致，建议逐项核对原文与对账单。"


def _explain(checks: list[dict], use_llm: bool) -> dict:
    rule = _rule_explain(checks)
    if not use_llm:
        return {"text": rule, "engine": "rule"}
    from . import llm
    from .config import settings

    if not settings.llm_enabled:
        return {"text": rule, "engine": "rule"}
    res = llm.chat_json(
        "你是单证核对助手。根据给定的检查结果写 2–3 句差异说明和核对建议；"
        "不得新增数字、不得改变检查结果、不得做法律结论。只输出 JSON：{\"text\":\"...\"}",
        __import__("json").dumps(checks, ensure_ascii=False),
    )
    if not res.ok:
        return {"text": rule, "engine": "rule"}
    data = llm.parse_json_loose(res.text)
    text = _clean((data or {}).get("text"))
    if not text:
        return {"text": rule, "engine": "rule"}
    return {"text": text[:400], "engine": "llm"}


def demo() -> dict:
    booking = """客户：宁波宏运集卡运输有限公司
委托单号：HY2026110801
箱型：40HQ
箱量：1
箱号：MSCU7654329
提箱地：宁波北仑二期堆场
卸货地：宁波北仑春晓工业园3号仓
运费：2600
"""
    invoice = """发票号码：12345678
开票日期：2026-11-08
购买方名称：宁波宏运集卡运输有限公司
纳税人识别号：9133020662M3QQRL4D
价税合计：2550.00
"""
    statement = """运单号,箱号,金额,客户
HY2026110801,MSCU7654329,2550,宁波宏运集卡运输有限公司
"""
    result = check(booking, invoice, statement, use_llm=False)
    result["synthetic"] = True
    result["warning"] = "合成演示：托书运费 2600，对账单 2550，故意制造金额差异。"
    return {"booking_text": booking, "invoice_text": invoice,
            "statement_text": statement, "result": result}
