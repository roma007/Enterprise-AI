"""经营驾驶舱 AI 摘要：老板视角的 3–5 句结论 + 行动顺序。

规则先把经营结果、客户/线路、能源/线路的异常汇总好；模型只写摘要、排序和动作草稿。
数字、异常编号、责任人、时间全部校验；不通过就回退规则模板。
"""
from __future__ import annotations

import json
import re

from . import thresholds as th
from .config import settings
from .insight_ai import _allowed_numbers, _validate_text
from .llm import chat_json, mask, parse_json_loose

_ALLOWED_OWNERS = ("老板/总经理", "财务", "调度", "运营")
_ALLOWED_WHEN = ("今天", "本周", "本月", "下季度")
_FORBIDDEN = ("减免", "免息", "起诉", "律师函", "法院", "仲裁",
              "保证", "一定", "必然", "裁员", "辞退")

SYSTEM = """你是集卡/综合物流公司的经营驾驶舱助理。系统已经算好经营结果、客户/线路、能源/线路的异常，你只负责给老板写摘要。
必须严格遵守：
1. 只使用输入中出现的数字、客户名、线路名、异常编号；不得新增、推算或改写任何数字。
2. 必须明确这是“示例/合成数据”，不能包装成客户真实结论。
3. 不承诺省钱、回本、减人、买车；不写裁员、辞退、法律结论。
4. brief 为 3–5 句中文：先说经营结果，再说最该先处理的一件事。
5. priorities 覆盖所有异常，id 只能来自输入，按建议处理顺序排列；why 不超过 60 字。
6. actions 覆盖所有异常；owner 只能从 allowed_owners 选，when 只能从 allowed_when 选，action 不超过 60 字。
7. 只输出 JSON：
{"brief": "...", "priorities": [{"id": "I1", "why": "..."}],
 "actions": [{"id": "I1", "owner": "财务", "when": "本周", "action": "..."}]}"""


def _candidates(result: dict) -> list[dict]:
    return [{
        "id": f"I{i}",
        "source": x.get("source", ""),
        "level": x.get("level", ""),
        "title": x.get("title", ""),
        "detail": x.get("detail", ""),
        "action": x.get("action", ""),
    } for i, x in enumerate(result.get("decisions") or [], 1)]


def _money(value: float) -> str:
    return f"{float(value or 0):,.0f}"


def _fallback_brief(result: dict) -> str:
    h = result.get("headline") or {}
    parts = [
        f"示例数据下，应收 {_money(h.get('revenue'))} 元、毛利 {_money(h.get('profit'))} 元，"
        f"毛利率 {float(h.get('margin', 0)) * 100:.1f}%。"
    ]
    parts.append(
        f"逾期未收 {_money(h.get('overdue'))} 元，{int(h.get('overdue_clients', 0))} 家客户需催收；"
        f"另有 {_money(h.get('unallocated'))} 元成本未归集。"
    )
    high = next((x for x in _candidates(result) if x["level"] == "high"), None)
    if high:
        parts.append(f"最该先处理：{high['title']}。")
    else:
        parts.append("当前没有必须立即停止的动作，但要先补真实数据再下结论。")
    parts.append("以上为合成演示，不代表客户真实经营结果；AI 只做解读，不改数。")
    return "".join(parts[:5])


def _fallback_owner(item: dict) -> str:
    text = f"{item.get('title', '')}{item.get('detail', '')}{item.get('action', '')}"
    if any(w in text for w in ("催", "逾期", "回款", "成本", "毛利", "亏损")):
        return "财务"
    if any(w in text for w in ("空驶", "线路", "调度", "派车")):
        return "调度"
    if any(w in text for w in ("电动", "补能", "充电", "车型")):
        return "运营"
    return "老板/总经理"


def _fallback(result: dict, error: str = "", tokens: int = 0,
              cached: bool = False) -> dict:
    candidates = _candidates(result)
    order = {"high": 0, "warn": 1, "ok": 2}
    ordered = sorted(candidates, key=lambda x: order.get(x["level"], 9))
    priorities, actions = [], []
    for item in ordered:
        why = ("规则判定为高优先级；先处理可避免影响扩大。"
               if item["level"] == "high" else
               "规则判定为需关注；先小范围核实，不要一次性改经营策略。")
        priorities.append({"id": item["id"], "title": item["title"], "why": why})
        actions.append({
            "id": item["id"],
            "title": item["title"],
            "owner": _fallback_owner(item),
            "when": "本周" if item["level"] == "high" else "本月",
            "action": item.get("action") or "按规则结果逐项核对",
        })
    return {
        "ok": False,
        "source": "rule",
        "fallback": True,
        "error": error,
        "brief": _fallback_brief(result),
        "priorities": priorities,
        "actions": actions,
        "synthetic": True,
        "tokens": tokens,
        "cached": cached,
        "boundary": "规则汇总 + 规则模板；模型未参与或输出未通过校验。",
    }


def _forbidden(text: str) -> str:
    for word in _FORBIDDEN:
        if word in (text or ""):
            return f"出现不允许的表述：{word}"
    return ""


def _validate_brief(text: str, allowed: set[str]) -> str:
    error = _validate_text(text, allowed, max_len=600)
    if error:
        return error
    error = _forbidden(text)
    if error:
        return error
    if not any(word in text for word in ("示例", "合成")):
        return "简报必须说明是示例/合成数据，不能包装成真实结论"
    sentences = [x for x in re.split(r"[。！？!?]+", text) if x.strip()]
    if not 3 <= len(sentences) <= 5:
        return f"简报需要 3–5 句，当前 {len(sentences)} 句"
    return ""


def _validate_priorities(items: object, candidates: list[dict],
                         allowed: set[str]) -> str:
    if not isinstance(items, list) or len(items) != len(candidates):
        return "优先级数量与异常数量不一致"
    ids = {x["id"] for x in candidates}
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            return "优先级格式错误"
        item_id = str(item.get("id") or "").strip()
        if item_id not in ids:
            return f"优先级出现未知异常编号：{item_id or '空'}"
        if item_id in seen:
            return f"优先级异常编号重复：{item_id}"
        seen.add(item_id)
        why = str(item.get("why") or "")
        error = _validate_text(why, allowed, max_len=160) or _forbidden(why)
        if error:
            return f"优先级 {item_id}：{error}"
    if seen != ids:
        return "优先级没有覆盖全部异常"
    return ""


def _validate_actions(items: object, candidates: list[dict],
                      allowed: set[str]) -> str:
    if not isinstance(items, list) or len(items) != len(candidates):
        return "动作数量与异常数量不一致"
    ids = {x["id"] for x in candidates}
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            return "动作格式错误"
        item_id = str(item.get("id") or "").strip()
        if item_id not in ids:
            return f"动作出现未知异常编号：{item_id or '空'}"
        if item_id in seen:
            return f"动作异常编号重复：{item_id}"
        seen.add(item_id)
        owner = str(item.get("owner") or "").strip()
        when = str(item.get("when") or "").strip()
        if owner not in _ALLOWED_OWNERS:
            return f"动作 {item_id} 的责任人不在允许范围：{owner or '空'}"
        if when not in _ALLOWED_WHEN:
            return f"动作 {item_id} 的时间不在允许范围：{when or '空'}"
        action = str(item.get("action") or "")
        error = _validate_text(action, allowed, max_len=160) or _forbidden(action)
        if error:
            return f"动作 {item_id}：{error}"
    if seen != ids:
        return "动作没有覆盖全部异常"
    return ""


def explain(result: dict) -> dict:
    if not th.get_bool("dashboard.ai_brief"):
        return _fallback(result, "未启用 AI 摘要")
    if not settings.llm_enabled:
        return _fallback(result, "模型未配置，已回退规则模板")

    candidates = _candidates(result)
    payload = {
        "headline": result.get("headline") or {},
        "modules": result.get("modules") or [],
        "decisions": candidates,
        "allowed_owners": list(_ALLOWED_OWNERS),
        "allowed_when": list(_ALLOWED_WHEN),
        "synthetic": True,
    }
    allowed = _allowed_numbers(payload)
    res = chat_json(SYSTEM, mask(json.dumps(payload, ensure_ascii=False)), max_tokens=3000)
    if not res.ok or not res.text:
        return _fallback(result, f"模型不可用：{res.error or '无返回'}",
                         res.tokens, res.cached)

    data = parse_json_loose(res.text)
    brief = str((data or {}).get("brief") or "").strip()
    priorities = (data or {}).get("priorities")
    actions = (data or {}).get("actions")
    error = _validate_brief(brief, allowed)
    if not error:
        error = _validate_priorities(priorities, candidates, allowed)
    if not error:
        error = _validate_actions(actions, candidates, allowed)
    if error:
        return _fallback(result, f"模型输出不合规，已回退规则模板：{error}",
                         res.tokens, res.cached)

    titles = {x["id"]: x["title"] for x in candidates}
    return {
        "ok": True,
        "source": "llm+rule",
        "fallback": False,
        "error": "",
        "brief": brief,
        "priorities": [
            {"id": x["id"], "title": titles.get(x["id"], ""),
             "why": str(x.get("why") or "").strip()} for x in priorities
        ],
        "actions": [
            {"id": x["id"], "title": titles.get(x["id"], ""),
             "owner": str(x.get("owner") or "").strip(),
             "when": str(x.get("when") or "").strip(),
             "action": str(x.get("action") or "").strip()} for x in actions
        ],
        "synthetic": True,
        "tokens": res.tokens,
        "cached": res.cached,
        "boundary": "经营结果/异常由规则汇总；AI 只写摘要、排序和动作草稿，未改数。",
    }
