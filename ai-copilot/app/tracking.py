"""客户查询与在途状态（B5 演示版）。

输入：集装箱号 / 委托单号 / 客户名 + 问题。
输出：当前状态、时间线、ETA、异常、数据来源。

边界：
- 数据来自合成演示；不是真实船期/港口接口。
- 有模型时只根据事实改写回答；没有数据就明确说没有。
"""
from __future__ import annotations

import re

from . import llm
from .config import settings
from .demo_ops import shipments

_CONTAINER = re.compile(r"\b([A-Z]{4}\d{7})\b", re.IGNORECASE)
_BOOKING = re.compile(r"(SYN\d{6,})", re.IGNORECASE)


def find_shipment(query: str, ships: list[dict] | None = None) -> dict | None:
    text = (query or "").upper()
    items = ships if ships is not None else shipments()
    box = _CONTAINER.search(text)
    if box:
        code = box.group(1)
        for s in items:
            if s["container_no"] == code:
                return s
    booking = _BOOKING.search(text)
    if booking:
        no = booking.group(1)
        for s in items:
            if s["booking_no"].upper() == no:
                return s
    # 客户名包含匹配
    for s in items:
        if s["customer"] and s["customer"] in query:
            return s
    return None


def _facts(s: dict) -> dict:
    return {
        "booking_no": s["booking_no"], "container_no": s["container_no"],
        "customer": s["customer"], "route": s["route"],
        "status": s["status"], "etd": s["etd"], "eta": s["eta"],
        "customs_status": s["customs_status"], "delay_hours": s["delay_hours"],
        "last_event": s["last_event"]["event"], "last_place": s["last_event"]["place"],
    }


def _template_answer(s: dict, question: str) -> str:
    q = question or ""
    if any(x in q for x in ("几时", "什么时候", "ETA", "到港", "到达")):
        extra = f"，预计延误 {s['delay_hours']} 小时" if s["delay_hours"] else ""
        return f"{s['container_no']} 预计 {s['eta']} 到港{extra}；当前状态：{s['status']}。"
    if any(x in q for x in ("放行", "报关", "清关")):
        return f"{s['container_no']} 报关状态：{s['customs_status']}；当前状态：{s['status']}。"
    if any(x in q for x in ("哪", "状态", "到哪", "进度")):
        return (f"{s['container_no']} 当前 {s['status']}，最后节点："
                f"{s['last_event']['event']}（{s['last_event']['place']}）。")
    return (f"{s['booking_no']} / {s['container_no']}：{s['route']}，"
            f"当前 {s['status']}，ETA {s['eta']}，报关 {s['customs_status']}。")


_SYSTEM = """你是货代客服。只能根据给定事实回答客户问题，不得编造船期、位置、放行状态。
没有的事实就说不知道。只输出 JSON：{"answer":"..."}。最多 120 字。"""


def answer(question: str, use_llm: bool = True) -> dict:
    question = (question or "").strip()
    if not question:
        raise ValueError("问题不能为空")
    s = find_shipment(question)
    if not s:
        return {"found": False, "answer": "没有找到对应的箱号/单号/客户，请提供更具体的信息。",
                "shipment": None, "timeline": [], "sources": [], "engine": "none"}
    facts = _facts(s)
    text = _template_answer(s, question)
    engine = "rule"
    if use_llm and settings.llm_enabled:
        res = llm.chat_json(_SYSTEM, __import__("json").dumps(
            {"question": question, "facts": facts}, ensure_ascii=False))
        if res.ok:
            data = llm.parse_json_loose(res.text)
            candidate = str((data or {}).get("answer") or "").strip()
            if candidate:
                text, engine = candidate[:240], "llm"
    return {
        "found": True,
        "answer": text,
        "shipment": facts,
        "timeline": s["timeline"],
        "sources": ["演示：订单/箱动态/报关状态"],
        "engine": engine,
        "warning": "演示数据；真实查询需对接港口/船期/报关数据。",
    }


def demo() -> dict:
    ships = shipments()
    sample = ships[0]
    return {
        "query": f"{sample['container_no']} 到哪了？几时到港？",
        "result": answer(sample["container_no"], use_llm=False),
        "summary": {"shipments": len(ships), "customers": len({s['customer'] for s in ships})},
    }
