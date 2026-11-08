"""在途异常事件抽取（C6 的可验证原型）。

输入：调度群/司机群/客服群里的文字（微信口语、短句、没有字段名）。
输出：事件卡片——提箱 / 装柜 / 进港 / 报关 / 放行 / 开船 / 到港 / 压车 / 改单 / 甩柜 / 异常 / 费用。

边界：
- 规则先抽，模型只做补充；模型输出必须有原文证据，不能编造。
- 事件是“记录/提示”，不自动改单、不自动派车、不自动扣费。
- 合成演示数据必须标注，不代表真实客户。
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from . import llm
from .config import settings
from .rules import containers_in, fmt, parse_datetime

EVENT_TYPES = ("提箱", "装柜", "进港", "报关", "放行", "开船", "到港",
               "压车", "改单", "甩柜", "异常", "费用", "其他")

_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("提箱", ("提柜", "提箱", "提到柜", "空箱", "提空")),
    ("装柜", ("装柜", "装货", "装箱", "装完", "封柜")),
    ("进港", ("进港", "还柜", "还箱", "进码头", "到闸")),
    ("报关", ("报关", "申报", "预录", "截关")),
    ("放行", ("放行", "通关", "清关")),
    ("开船", ("开船", "船开", "离港", "已开", "启航")),
    ("到港", ("到港", "抵达", "靠泊")),
    ("压车", ("压车", "等候", "排队", "堵", "等卸货", "等装货", "压夜")),
    ("改单", ("改单", "改配", "换船", "改港", "退关", "改地址", "改箱")),
    ("甩柜", ("甩柜", "延班", "延误", "截港提前", "赶不上", "漏装")),
    ("异常", ("破损", "短少", "扣关", "查验", "罚款", "事故", "异常", "丢货")),
    ("费用", ("压夜费", "等候费", "改单费", "退关费", "停车费", "滞箱费",
              "超期费", "搬移费", "费用", "收费")),
]
_LOCATIONS = ("北滘港", "顺德新港", "盐田", "蛇口", "南沙", "广州港", "深圳港",
              "堆场", "码头", "工厂", "仓库", "保税区", "口岸", "闸口")
_BOOKING_LABEL_RE = re.compile(
    r"(?:委托单号|订单号|托书号|单号|booking(?:\s*no)?)\s*[:：]?\s*([A-Z0-9][A-Z0-9_-]{3,})",
    re.IGNORECASE,
)
_BOOKING_HYPHEN_RE = re.compile(r"\b([A-Z]{2,5}[-_]\d{3,})\b", re.IGNORECASE)


def _line_events(line: str) -> list[dict]:
    text = line.strip(" \t-—，,。；;")
    if not text:
        return []
    hits = []
    for etype, words in _KEYWORDS:
        if any(w in text for w in words):
            hits.append(etype)
    if not hits:
        return []
    # 一行多关键词：按更具体的事件优先，避免“费用”吃掉“压车”
    priority = ["甩柜", "改单", "异常", "压车", "费用", "提箱", "装柜",
                "进港", "报关", "放行", "开船", "到港"]
    etype = next((x for x in priority if x in hits), hits[0])
    dt = parse_datetime(text)
    boxes = containers_in(text)
    booking = _BOOKING_LABEL_RE.search(text) or _BOOKING_HYPHEN_RE.search(text)
    booking_no = booking.group(1) if booking else ""
    if booking_no and booking_no.upper() in {b.upper() for b in boxes}:
        booking_no = ""
    location = next((x for x in _LOCATIONS if x in text), "")
    impact = ""
    if etype in ("压车", "改单", "甩柜", "异常", "费用"):
        impact = "可能产生费用/延误，需人工确认"
    return [{
        "type": etype,
        "time": fmt(dt) if dt else "",
        "location": location,
        "container_no": ",".join(boxes),
        "booking_no": booking_no,
        "detail": text[:160],
        "impact": impact,
        "evidence": text[:300],
        "source": "rule",
    }]


def rule_events(text: str) -> list[dict]:
    out: list[dict] = []
    for line in re.split(r"[\n\r]+", text):
        out.extend(_line_events(line))
    return out


_SYSTEM = """你是集卡/货代调度群的事件抽取助手。
从聊天原文中抽取**明确出现**的事件，不得推测、不得补不存在的字段。
事件类型只能是：提箱、装柜、进港、报关、放行、开船、到港、压车、改单、甩柜、异常、费用、其他。
只输出 JSON：{"events":[{"type":"...","time":"","location":"","container_no":"","booking_no":"","detail":"","impact":"","evidence":"原文中的一句话"}]}
没有事件就输出 {"events":[]}。"""


def _llm_events(text: str) -> list[dict]:
    if not settings.llm_enabled:
        return []
    res = llm.chat_json(_SYSTEM, text[:4000])
    if not res.ok:
        return []
    data = llm.parse_json_loose(res.text)
    items = data.get("events") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    compact = re.sub(r"\s+", "", text)
    for item in items[:20]:
        if not isinstance(item, dict):
            continue
        etype = str(item.get("type") or "").strip()
        evidence = str(item.get("evidence") or "").strip()
        if etype not in EVENT_TYPES or not evidence:
            continue
        # 证据必须能在原文里找到，防止模型编造
        if re.sub(r"\s+", "", evidence) not in compact:
            continue
        out.append({
            "type": etype,
            "time": str(item.get("time") or "").strip()[:40],
            "location": str(item.get("location") or "").strip()[:40],
            "container_no": str(item.get("container_no") or "").strip()[:80],
            "booking_no": str(item.get("booking_no") or "").strip()[:60],
            "detail": str(item.get("detail") or evidence).strip()[:160],
            "impact": str(item.get("impact") or "").strip()[:120],
            "evidence": evidence[:300],
            "source": "llm",
        })
    return out


def extract_events(text: str, use_llm: bool = True) -> dict:
    text = (text or "").strip()
    if not text:
        return {"events": [], "engine": "rule", "warning": "没有输入"}
    rules = rule_events(text)
    llm_items = _llm_events(text) if use_llm else []
    # 规则与模型合并；同一句只留规则结果，避免模型重复报同一个事件
    seen = {re.sub(r"\s+", "", x["evidence"]) for x in rules}
    merged = list(rules)
    for item in llm_items:
        key = re.sub(r"\s+", "", item["evidence"])
        if key not in seen:
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda x: (x.get("time") or "9999", x.get("type") or ""))
    engine = "rule" if not llm_items else "rule+llm"
    warning = ""
    if use_llm and not settings.llm_enabled:
        warning = "模型未配置，当前只显示规则抽取结果。"
    elif use_llm and not llm_items:
        warning = "模型未返回可用事件，已回退规则结果。"
    return {"events": merged, "engine": engine, "warning": warning,
            "counts": {t: sum(1 for e in merged if e["type"] == t) for t in EVENT_TYPES}}


def demo() -> dict:
    text = """11-08 09:12 浙B12345 北滘港已提柜，柜号 MSCU7654329，去工厂装货
11-08 10:40 工厂装柜完成，封号 SL8823101，毛重 18600
11-08 14:05 北滘港还柜进港，等报关
11-08 15:20 报关已申报，等放行
11-08 17:50 盐田截港提前到明天 12:00，这票可能赶不上，客户很急
11-08 18:10 客户改单：卸货地改到东莞长安，增加压夜费 300
11-09 08:30 查验通知，柜号 MSCU7654329，需补装箱单
"""
    result = extract_events(text, use_llm=False)
    result["synthetic"] = True
    result["warning"] = "演示对话，不代表真实客户；系统抽取，AI 可补充。" + result["warning"]
    return {"text": text, "result": result}
