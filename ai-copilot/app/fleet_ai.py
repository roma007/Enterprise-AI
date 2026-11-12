"""车队能源/线路/人力分析的 AI 解读。

规则算成本、能耗、空驶和工时；模型只写 3–5 句简报、排优先级、生成动作草稿。
数字、异常编号、责任人、时间全部校验；不通过就回退规则模板。
"""
from __future__ import annotations

import json
import re

from . import thresholds as th
from .config import settings
from .fleet import demo
from .insight_ai import _allowed_numbers, _numbers, _validate_text
from .llm import chat_json, mask, parse_json_loose

_ALLOWED_OWNERS = ("老板/总经理", "财务", "调度", "运营", "采购")
_ALLOWED_WHEN = ("今天", "本周", "本月", "下季度")
_FORBIDDEN = ("减免", "免息", "起诉", "律师函", "法院", "仲裁",
              "保证", "一定", "必然", "裁员", "辞退")

SYSTEM = """你是集卡/综合物流公司的经营分析助理。系统已经用公开资料和合成运营数据算好了线路、能源、车型和人力成本，你只负责解读。
必须严格遵守：
1. 只使用输入中出现的数字、线路名、车型名、异常编号；不得新增、推算或改写任何数字。
2. 必须明确这是“示例数据/示例假设下”，不能包装成客户真实结论。
3. 不承诺买车、省钱、减人、回本周期；不写裁员、辞退、法律结论。
4. brief 为 3–5 句中文：先说成本/结构结论，再说最该先验证的一件事。
5. priorities 覆盖所有异常，id 只能来自输入，按建议处理顺序排列；why 不超过 60 字。
6. actions 覆盖所有异常；owner 只能从 allowed_owners 选，when 只能从 allowed_when 选，action 不超过 60 字。
7. 只输出 JSON：
{"brief": "...", "priorities": [{"id": "I1", "why": "..."}],
 "actions": [{"id": "I1", "owner": "运营", "when": "本周", "action": "..."}]}"""


def _candidates(result: dict) -> list[dict]:
    return [{
        "id": f"I{i}",
        "level": str(x.get("level") or ""),
        "title": str(x.get("title") or ""),
        "detail": str(x.get("detail") or ""),
        "action": str(x.get("action") or ""),
    } for i, x in enumerate(result.get("insights") or [], 1)]


def _money(value: float) -> str:
    return f"{float(value):,.0f}"


def _fallback_brief(result: dict) -> str:
    s = result.get("summary") or {}
    parts = [
        f"示例 {int(s.get('fleet_total', 0))} 台车、{int(s.get('routes', 0))} 条线路，"
        f"单箱综合成本 {_money(s.get('cost_per_teu', 0))} 元，毛利率 "
        f"{float(s.get('margin', 0)) * 100:.1f}%。"
    ]
    parts.append(
        f"能源成本占运输成本 {float(s.get('energy_share', 0)) * 100:.1f}%，"
        f"空驶率 {float(s.get('empty_ratio', 0)) * 100:.1f}%。"
    )
    high = next((x for x in _candidates(result) if x["level"] == "high"), None)
    if high:
        parts.append(f"先处理：{high['title']}。")
    else:
        parts.append("示例数据下没有必须立即停止的动作，但要先补真实能耗和工时数据。")
    parts.append(
        f"人力方面，示例可减少的重复工时约 {_money(s.get('release_hours', 0))} 小时/月，"
        "先做接单、对账和在途三个入口。"
    )
    return "".join(parts[:5])


def _fallback_owner(item: dict) -> str:
    text = f"{item.get('title', '')}{item.get('detail', '')}{item.get('action', '')}"
    if any(w in text for w in ("电动", "补能", "充电", "车型", "马力")):
        return "运营"
    if any(w in text for w in ("空驶", "线路", "调度", "派车")):
        return "调度"
    if any(w in text for w in ("能源", "成本", "毛利", "报价")):
        return "财务"
    if any(w in text for w in ("工时", "人力", "单证", "对账", "在途")):
        return "运营"
    return "老板/总经理"


def _fallback(result: dict, error: str = "", tokens: int = 0,
              cached: bool = False) -> dict:
    candidates = _candidates(result)
    order = {"high": 0, "warn": 1, "ok": 2}
    ordered = sorted(candidates, key=lambda x: order.get(x["level"], 9))
    priorities, actions = [], []
    for item in ordered:
        why = ("规则判定为高优先级；先解决补能/续航或成本倒挂，再谈替换。"
               if item["level"] == "high" else
               "规则判定为需关注；先小范围验证，不要一次性改车队结构。")
        priorities.append({"id": item["id"], "title": item["title"], "why": why})
        actions.append({
            "id": item["id"],
            "title": item["title"],
            "owner": _fallback_owner(item),
            "when": "本周" if item["level"] == "high" else "本月",
            "action": item["action"] or "按示例结论补数据后复核",
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
        "boundary": "规则测算 + 规则模板；模型未参与或输出未通过校验。",
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
    if not any(word in text for word in ("示例", "假设")):
        return "简报必须说明是示例/假设，不能包装成真实结论"
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
    if not th.get_bool("fleet.ai_brief"):
        return _fallback(result, "未启用 AI 解读")
    if not settings.llm_enabled:
        return _fallback(result, "模型未配置，已回退规则模板")

    candidates = _candidates(result)
    payload = {
        "summary": result.get("summary") or {},
        "routes": result.get("routes") or [],
        "vehicles": result.get("vehicles") or [],
        "pairs": result.get("pairs") or [],
        "labor": result.get("labor") or [],
        "insights": candidates,
        "allowed_owners": list(_ALLOWED_OWNERS),
        "allowed_when": list(_ALLOWED_WHEN),
        "synthetic": True,
        "public": {
            "source_mode": (result.get("public") or {}).get("source_mode"),
            "source_ok": (result.get("public") or {}).get("source_ok"),
        },
    }
    allowed = _allowed_numbers(payload)
    # 7 条异常 + 简报 + 动作，2000 token 会被截断，单独放宽到 4000
    res = chat_json(SYSTEM, mask(json.dumps(payload, ensure_ascii=False)), max_tokens=4000)
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
        "boundary": "成本/能耗/工时由规则测算；AI 只写简报、排序和动作草稿，未改数。",
    }


def explain_demo() -> dict:
    return explain(demo())
