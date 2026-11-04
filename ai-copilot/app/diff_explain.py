"""差异解释：规则模板 + 可选大模型。

硬约束：
- 金额、差异类型由规则计算；大模型只生成 possible_causes / suggested_action
- 大模型失败自动回退规则模板
- 解释必须带 evidence，低置信不下结论
"""
from __future__ import annotations

import json

from .config import settings
from .llm import chat_json, mask, parse_json_loose

RULE_CAUSES = {
    "amount_mismatch": [
        "税额/附加费/折扣口径不同",
        "运单金额录错",
        "对账单重复计费",
    ],
    "missing_line": [
        "客户漏报该运单",
        "对账单未包含该票",
        "运单未关联客户",
    ],
    "extra_line": [
        "系统未录入该运单",
        "运单号识别错误",
        "重复计费",
    ],
    "duplicate": [
        "同一运单重复计费",
        "多页/多表重复",
    ],
    "tax_mismatch": [
        "税率不一致",
        "含税/不含税口径不同",
    ],
    "unit_price_mismatch": [
        "合同版本不同",
        "线路/箱型匹配错",
        "车队报错价",
    ],
    "quantity_mismatch": [
        "趟次/数量重复",
        "装卸数量不一致",
    ],
    "period_mismatch": [
        "账期口径不同",
        "跨月归属",
    ],
    "customer_mismatch": [
        "客户/车队名称不一致",
        "主体变更",
    ],
    "rounding": [
        "舍入差异",
    ],
    "no_rate": [
        "合同缺该线路/箱型",
        "车队名称不一致",
        "合同过期",
    ],
}

RULE_ACTIONS = {
    "amount_mismatch": "核对合同税率与费用明细，确认差额归属后再调整",
    "missing_line": "与客户确认是否漏单，必要时补发对账单",
    "extra_line": "核对运单号与系统记录，确认补录或剔除",
    "duplicate": "核对重复行，保留一条并说明原因",
    "tax_mismatch": "核对合同税率与发票税率",
    "unit_price_mismatch": "核对合同版本与线路/箱型，按合同价调整",
    "quantity_mismatch": "核对趟次与装卸记录",
    "period_mismatch": "确认账期归属",
    "customer_mismatch": "核对客户/车队主数据",
    "rounding": "按合同约定舍入规则处理",
    "no_rate": "补合同价或按协议价人工核定",
}

SYSTEM_PROMPT = """你是财务对账助手。只根据给定的差异、金额和证据，用中文给出可能原因和建议动作。
要求：
1. 不要计算或编造金额；金额只能引用输入。
2. possible_causes 1-3 条，具体、可核对。
3. suggested_action 1 句，必须是人可以执行的动作。
4. 不确定时降低 confidence，不要下法律或付款结论。
只输出 JSON：{"possible_causes": ["..."], "suggested_action": "...", "confidence": 0.0}"""


def _rule_explanation(diff: dict) -> tuple[list[str], str]:
    diff_type = str(diff.get("type") or "amount_mismatch")
    causes = list(RULE_CAUSES.get(diff_type, RULE_CAUSES["amount_mismatch"]))
    action = RULE_ACTIONS.get(diff_type, RULE_ACTIONS["amount_mismatch"])
    delta = diff.get("delta")
    if diff_type == "amount_mismatch" and delta is not None:
        causes.insert(0, f"差额 {delta} 元，优先核对税额/附加费/折扣")
    if not diff.get("evidence"):
        causes = causes[:2]
    return causes[:3], action


def _llm_explanation(diff: dict, context: dict | None) -> tuple[list[str], str, float] | None:
    if not settings.llm_enabled:
        return None
    payload = {
        "difference": {
            "type": diff.get("type"),
            "waybill_no": diff.get("waybill_no"),
            "statement_amount": diff.get("statement_amount"),
            "system_amount": diff.get("system_amount"),
            "delta": diff.get("delta"),
            "evidence": diff.get("evidence", []),
        },
        "context": context or {},
    }
    user = mask(json.dumps(payload, ensure_ascii=False))
    res = chat_json(SYSTEM_PROMPT, user)
    if not res.ok or not res.text:
        return None
    parsed = parse_json_loose(res.text)
    causes = [
        str(x).strip()
        for x in (parsed.get("possible_causes") or [])
        if str(x).strip()
    ][:3]
    action = str(parsed.get("suggested_action") or "").strip()
    if not causes and not action:
        return None
    try:
        confidence = float(parsed.get("confidence", 0.7))
    except (TypeError, ValueError):
        confidence = 0.7
    confidence = min(0.95, max(0.3, confidence))
    return causes, action, confidence


def explain_difference(diff: dict, context: dict | None = None) -> dict:
    rule_causes, rule_action = _rule_explanation(diff)
    llm = _llm_explanation(diff, context)
    out = dict(diff)
    if llm:
        causes, action, confidence = llm
        out["possible_causes"] = causes or rule_causes
        out["suggested_action"] = action or rule_action
        out["confidence"] = confidence
        out["source"] = "llm+rule"
    else:
        out["possible_causes"] = rule_causes
        out["suggested_action"] = rule_action
        out["confidence"] = 0.6
        out["source"] = "rule"
    return out


def explain_differences(diffs: list[dict], context: dict | None = None) -> list[dict]:
    return [explain_difference(d, context) for d in diffs]
