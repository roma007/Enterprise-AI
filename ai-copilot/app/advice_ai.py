"""催收话术的可选 AI 润色。

边界（必须守住）：
- 金额、逾期天数、客户名、笔数由规则算好并注入模板，模型只改措辞。
- 模型输出必须通过数字校验：不能新增、删改、编造任何数字。
- 不通过校验就回退模板，绝不把未经核对的内容返回给页面。
- 默认关闭；未配置模型或调用失败同样回退模板。
"""
from __future__ import annotations

import json
import re

from . import llm
from . import thresholds as th
from .aging import _advice, _advice_text

_SYSTEM = """你是集卡/货代公司的应收账款催收文案助手。
任务：把给定的催收模板改写得更自然、更专业，但必须严格遵守：
1. 不得改变客户名称、金额、逾期天数、笔数；不得新增或删除任何数字。
2. 不得承诺减免、免息、折扣、延期，也不得写起诉、律师函、法院、仲裁等法律结论。
3. 必须保留模板中的付款期限（例如 2 个或 3 个工作日）。
4. 只输出 JSON：{"draft": "..."}，draft 为纯文本，不超过 220 字。"""

_NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
_FORBIDDEN = ("减免", "免息", "折扣", "延期", "起诉", "律师函", "法院", "仲裁", "威胁")


def _norm_num(token: str) -> str:
    raw = token.replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return raw
    return str(int(value)) if value.is_integer() else f"{value:g}"


def _numbers(text: str) -> set[str]:
    return {_norm_num(m.group(0)) for m in _NUM_RE.finditer(text or "")}


def validate_draft(template: str, draft: str, facts: dict[str, str]) -> tuple[bool, str]:
    """校验模型输出。通过返回 (True, "")，否则 (False, 原因)。"""
    text = (draft or "").strip()
    if not text:
        return False, "模型没有返回内容"
    if len(text) > 320:
        return False, "模型输出过长"

    if facts["client"] not in text:
        return False, "客户名被改动"

    allowed = _numbers(template)
    for value in facts.values():
        allowed |= _numbers(str(value))
    allowed |= _numbers(" ".join(str(v) for v in facts.values()))

    used = _numbers(text)
    invented = sorted(used - allowed)
    if invented:
        return False, f"出现模板之外的数字：{'、'.join(invented[:5])}"

    for key in ("outstanding", "overdue", "days"):
        if _norm_num(str(facts[key])) not in used:
            return False, f"缺少关键数字：{key}"

    for word in _FORBIDDEN:
        if word in text and word not in template:
            return False, f"出现不允许的表述：{word}"

    # 付款期限不能被改写：模板里的「N 个工作日」必须原样保留
    for deadline in re.findall(r"(\d+)\s*个工作日", template):
        if not re.search(rf"{deadline}\s*个工作日", text):
            return False, "付款期限被改动"

    return True, ""


def draft(*, client: str, count: int, outstanding: float,
          overdue: float, days: int) -> dict:
    """生成 AI 润色建议；任何异常都回退到配置模板。"""
    if not th.get_bool("aging.ai_draft"):
        return {"ok": False, "error": "未启用 AI 润色", "fallback": True, "text": ""}

    ratio = (overdue / outstanding) if outstanding > 0 else 0.0
    level, _ = _advice(float(ratio), int(days), float(overdue))
    ctx = {"client": client, "count": int(count), "outstanding": float(outstanding),
           "overdue": float(overdue), "days": int(days)}
    template = _advice_text(level, ctx)
    if not template:
        return {"ok": False, "error": "该客户无需催收话术", "fallback": True, "text": ""}

    facts = {
        "client": client,
        "count": str(int(count)),
        "outstanding": f"{float(outstanding):,.0f}",
        "overdue": f"{float(overdue):,.0f}",
        "days": str(int(days)),
    }
    user = json.dumps({"template": template, "facts": facts}, ensure_ascii=False)
    res = llm.chat_json(_SYSTEM, user)
    if not res.ok:
        return {"ok": False, "error": f"模型不可用：{res.error}", "fallback": True,
                "text": template, "template": template, "level": level}

    data = llm.parse_json_loose(res.text)
    text = str((data or {}).get("draft") or "").strip()
    passed, reason = validate_draft(template, text, facts)
    if not passed:
        return {"ok": False, "error": f"模型输出不合规，已回退模板：{reason}",
                "fallback": True, "text": template, "template": template,
                "level": level, "tokens": res.tokens, "cached": res.cached}

    return {"ok": True, "text": text, "template": template, "level": level,
            "tokens": res.tokens, "cached": res.cached}
