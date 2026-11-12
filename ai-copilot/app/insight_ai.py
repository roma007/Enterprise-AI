"""经营洞察 AI 解读：规则算指标，模型只写简报、排序和动作草稿。

边界（必须守住）：
- 指标、异常、金额、客户名由 `insight.build()` 规则计算；模型不得新增或改数。
- 模型只做三件事：3–5 句老板简报、异常优先级、动作草稿。
- 输出必须通过数字 / 异常 ID / 措辞校验；不通过就回退规则模板。
- 未配置模型、模型失败、未启用开关，同样回退，不影响规则结果。
"""
from __future__ import annotations

import json
import re

from . import thresholds as th
from .config import settings
from .llm import chat_json, mask, parse_json_loose

_ALLOWED_OWNERS = ("老板/总经理", "财务", "调度", "客服", "单证", "运营")
_ALLOWED_WHEN = ("今天", "本周", "本月", "下月", "本季度")
_FORBIDDEN = ("减免", "免息", "起诉", "律师函", "法院", "仲裁", "保证回款", "保证盈利")

_NUM_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")

SYSTEM = """你是集卡/货代公司的经营分析助理。系统已经算好指标和异常，你只负责把结果讲给老板听。
必须严格遵守：
1. 只使用输入中出现的数字、客户名、异常编号；不得新增、推算或改写任何数字。
2. 不承诺减免、免息、延期、付款保证，不写起诉、法院、仲裁等法律结论。
3. brief 为 3–5 句中文，每句简短，先说结论，再说最该先处理的事。
4. priorities 必须覆盖所有异常，id 只能来自输入，按建议处理顺序排列；why 说明为什么先做，不超过 60 字。
5. actions 必须覆盖所有异常；owner 只能从 allowed_owners 选，when 只能从 allowed_when 选，action 是可执行动作，不超过 60 字。
6. 只输出 JSON：
{"brief": "...", "priorities": [{"id": "I1", "why": "..."}],
 "actions": [{"id": "I1", "owner": "财务", "when": "本周", "action": "..."}]}"""


def _norm_num(token: str) -> str:
    raw = token.replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return raw
    return str(int(value)) if value.is_integer() else f"{value:g}"


def _numbers(text: str) -> set[str]:
    out: set[str] = set()
    for m in _NUM_RE.finditer(text or ""):
        token = m.group(0)
        out.add(_norm_num(token))
        if token.startswith("-"):
            out.add(_norm_num(token[1:]))
    return out


def _add_number(out: set[str], value: float | int) -> None:
    """把一个数值的常见写法都加进白名单（含绝对值、千分位、百分比）。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return
    variants = {
        f"{number:g}",
        f"{number:.0f}",
        f"{number:,.0f}",
        f"{number:.1f}",
        f"{number:.2f}",
        f"{abs(number):g}",
        f"{abs(number):.0f}",
        f"{abs(number):,.0f}",
        f"{abs(number):.1f}",
    }
    for item in variants:
        out.add(_norm_num(item))


def _allowed_numbers(payload: dict) -> set[str]:
    out: set[str] = set()

    def walk(node, key: str = "") -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, k)
        elif isinstance(node, list):
            for item in node:
                walk(item, key)
        elif isinstance(node, bool):
            return
        elif isinstance(node, (int, float)):
            _add_number(out, node)
            # 比率字段额外允许百分比写法，例如 0.7221 → 72.2%
            if key in {"margin", "overdue_ratio", "ratio"} and -1.5 <= float(node) <= 1.5:
                _add_number(out, float(node) * 100)
        elif isinstance(node, str):
            out.update(_numbers(node))

    walk(payload)
    return out


def _known_clients(result: dict) -> set[str]:
    names = {str(x.get("client") or "").strip()
             for x in (result.get("overdue_clients") or [])}
    names |= {str(x.get("client") or "").strip()
              for x in (result.get("loss_orders") or [])}
    return {name for name in names if name}


def _candidates(result: dict) -> list[dict]:
    out = []
    for index, item in enumerate(result.get("insights") or [], 1):
        out.append({
            "id": f"I{index}",
            "level": str(item.get("level") or ""),
            "title": str(item.get("title") or ""),
            "detail": str(item.get("detail") or ""),
            "action": str(item.get("action") or ""),
        })
    return out


def _money(value: float | int) -> str:
    return f"{float(value):,.0f}"


def _fallback_brief(result: dict) -> str:
    s = result.get("summary") or {}
    parts = [
        f"本期 {int(s.get('orders', 0))} 单，毛利 {_money(s.get('profit', 0))} 元，"
        f"毛利率 {float(s.get('margin', 0)) * 100:.1f}%。"
    ]
    if float(s.get("unallocated", 0) or 0) > 0:
        parts.append(f"有 {_money(s['unallocated'])} 元成本未归集，当前毛利可能被高估。")
    if float(s.get("overdue", 0) or 0) > 0:
        parts.append(
            f"逾期未收 {_money(s['overdue'])} 元，"
            f"{int(s.get('overdue_clients', 0))} 家客户需要催收。"
        )
    high = next((c for c in _candidates(result) if c["level"] == "high"), None)
    if high:
        parts.append(f"优先处理：{high['title']}。")
    if len(parts) < 3:
        parts.append("当前没有明显异常，保持抽样核对，等真实数据接入后再看趋势。")
    return "".join(parts[:5])


def _fallback_owner(item: dict) -> str:
    text = f"{item.get('title', '')}{item.get('action', '')}"
    if "催" in text or "逾期" in text:
        return "财务"
    if any(word in text for word in ("成本", "毛利", "亏损", "分摊", "报价")):
        return "财务"
    if "车辆" in text or "调度" in text:
        return "调度"
    return "运营"


def _fallback(result: dict, error: str = "", tokens: int = 0,
              cached: bool = False) -> dict:
    candidates = _candidates(result)
    order = {"high": 0, "warn": 1, "ok": 2}
    ordered = sorted(candidates, key=lambda x: order.get(x["level"], 9))
    priorities = []
    actions = []
    for item in ordered:
        why = ("规则判定为高优先级；先处理可避免影响继续扩大。"
               if item["level"] == "high" else
               "规则判定为需关注；在本周内安排核对即可。")
        priorities.append({"id": item["id"], "title": item["title"], "why": why})
        when = "本周" if item["level"] == "high" else "本月"
        actions.append({
            "id": item["id"],
            "title": item["title"],
            "owner": _fallback_owner(item),
            "when": when,
            "action": item["action"] or "按规则结果逐项核对",
        })
    return {
        "ok": False,
        "source": "rule",
        "fallback": True,
        "error": error,
        "brief": _fallback_brief(result),
        "priorities": priorities,
        "actions": actions,
        "synthetic": bool(result.get("synthetic")),
        "tokens": tokens,
        "cached": cached,
        "boundary": "规则指标 + 规则模板；模型未参与或输出未通过校验。",
    }


def _validate_text(text: str, allowed: set[str], *, max_len: int) -> str:
    text = (text or "").strip()
    if not text:
        return "内容为空"
    if len(text) > max_len:
        return "内容过长"
    invented = sorted(_numbers(text) - allowed)
    if invented:
        return f"出现输入之外的数字：{'、'.join(invented[:4])}"
    for word in _FORBIDDEN:
        if word in text:
            return f"出现不允许的表述：{word}"
    return ""


def _validate_brief(text: str, allowed: set[str]) -> str:
    error = _validate_text(text, allowed, max_len=600)
    if error:
        return error
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
        error = _validate_text(str(item.get("why") or ""), allowed, max_len=160)
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
        error = _validate_text(str(item.get("action") or ""), allowed, max_len=160)
        if error:
            return f"动作 {item_id}：{error}"
    if seen != ids:
        return "动作没有覆盖全部异常"
    return ""


def explain(result: dict) -> dict:
    """在规则结果上生成 AI 简报、优先级和动作草稿。"""
    if not th.get_bool("insight.ai_brief"):
        return _fallback(result, "未启用 AI 解读")
    if not settings.llm_enabled:
        return _fallback(result, "模型未配置，已回退规则模板")

    candidates = _candidates(result)
    payload = {
        "summary": result.get("summary") or {},
        "insights": candidates,
        "loss_orders": [
            {k: x.get(k) for k in ("order_no", "client", "profit", "margin", "flag")}
            for x in (result.get("loss_orders") or [])[:5]
        ],
        "overdue_clients": [
            {k: x.get(k) for k in ("client", "overdue", "max_overdue_days", "level")}
            for x in (result.get("overdue_clients") or [])[:5]
        ],
        "allowed_owners": list(_ALLOWED_OWNERS),
        "allowed_when": list(_ALLOWED_WHEN),
        "synthetic": bool(result.get("synthetic")),
    }
    allowed = _allowed_numbers(payload)
    user = mask(json.dumps(payload, ensure_ascii=False))
    res = chat_json(SYSTEM, user)
    if not res.ok or not res.text:
        return _fallback(result, f"模型不可用：{res.error or '无返回'}", res.tokens, res.cached)

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
             "why": str(x.get("why") or "").strip()}
            for x in priorities
        ],
        "actions": [
            {"id": x["id"], "title": titles.get(x["id"], ""),
             "owner": str(x.get("owner") or "").strip(),
             "when": str(x.get("when") or "").strip(),
             "action": str(x.get("action") or "").strip()}
            for x in actions
        ],
        "synthetic": bool(result.get("synthetic")),
        "tokens": res.tokens,
        "cached": res.cached,
        "boundary": "指标与异常由规则计算；AI 只写简报、排序和动作草稿，未改数。",
    }
