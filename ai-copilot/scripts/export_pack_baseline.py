"""把当前代码里的行业常量导出成 packs/trucking/ 基线（Step 0）。

目的：在把字段、校验、对账口径改成“读配置”之前，先把**现有行为**冻结成
一份可对照的 JSON。这样 Step 1 改完代码后，`scripts/pack_snapshot.py` 能证明
“配置化前后逐字段一致”，而不是靠肉眼检查。

这不是运行时加载器；Step 0 不改变任何运行时行为。Step 1 起 pack 才成为源，
本脚本保留用于对照和重新导出。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/export_pack_baseline.py
"""
from __future__ import annotations

import json
from pathlib import Path

from app import address_check, aging, fees, margin, reconcile, rules
from app.config import ROOT
from app.invoice import INVOICE_SPECS
from app.rules import CLOSING_WARN_HOURS, LOW_CONF_WARN, PHONE_RE, RISK_KEYS, SEAL_RE, VALID_TYPES
from app.schema import BLOCKING_KEYS, SPECS

PACK_DIR = ROOT / "packs" / "trucking"

# 字段归一化只是声明“用哪种内置归一化器”，算法仍留在 app/schema.py。
_BOOKING_NORMALIZE = {
    "container_no": "container_list",
    "seal_no": "container_list",
    "container_type": "container_type",
    "container_qty": "number",
    "gross_weight": "number",
    "freight": "amount",
    "factory_phone": "number",
    "so_no": "so_no",
    "loading_window": "datetime",
    "closing_time": "datetime",
}
_INVOICE_NORMALIZE = {
    "invoice_date": "datetime",
    "amount": "amount",
    "tax_amount": "amount",
    "total_amount": "amount",
    "tax_rate": "number",
}


def _write(name: str, payload: object) -> None:
    path = PACK_DIR / name
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _booking_fields() -> list[dict]:
    out = []
    for s in SPECS:
        out.append({
            "key": s.key,
            "label": s.label,
            "hint": s.hint,
            "example": s.example,
            "blocking": s.blocking,
            "kind": s.kind,
            "normalize": getattr(s, "normalize", _BOOKING_NORMALIZE.get(s.key, "text")),
        })
    return out


def _invoice_fields() -> list[dict]:
    out = []
    for s in INVOICE_SPECS:
        out.append({
            "key": s.key,
            "label": s.label,
            "hint": s.hint,
            "example": s.example,
            "blocking": s.blocking,
            "kind": getattr(s, "kind", "number" if s.key in {"tax_rate"} else "text"),
            "normalize": getattr(s, "normalize", _INVOICE_NORMALIZE.get(s.key, "text")),
        })
    return out


def main() -> None:
    PACK_DIR.mkdir(parents=True, exist_ok=True)

    _write("pack.json", {
        "id": "trucking",
        "name": "集卡/拖车",
        "version": "0.1.0",
        "description": "港口集卡托书 → 对账 → 应收；当前代码基线的冻结快照（Step 0）",
        "documents": ["booking", "invoice", "statement", "aging", "fees", "cost"],
        "settings_refs": [
            "rules.required",
            "rules.container_checksum",
            "rules.closing",
            "rules.address",
            "reconcile.tolerance",
            "settlement.tolerance",
            "margin.match_days",
            "margin.warn_margin",
            "aging.bucket_1",
            "aging.bucket_2",
            "aging.bucket_3",
            "aging.remind_days",
            "aging.collect_days",
        ],
    })

    _write("fields.json", {
        "booking": {"label": "托书", "fields": _booking_fields()},
        "invoice": {"label": "发票", "fields": _invoice_fields()},
    })

    _write("rules.json", {
        "validations": [
            {
                "id": "required",
                "type": "builtin.required",
                "level": "error",
                "code": "E_REQUIRED",
                "message": "缺少必填字段：{label}",
                "fields_from": "settings:rules.required",
                "fallback_fields": list(BLOCKING_KEYS),
            },
            {
                "id": "low_confidence",
                "type": "builtin.low_confidence",
                "level": "warn",
                "code": "W_LOW_CONF",
                "message": "{label} 置信度偏低（{confidence:.0%}），请人工核对",
                "threshold_from": "review.low_conf_warn",
            },
            {
                "id": "container_checksum",
                "type": "builtin.iso6346",
                "level": "error",
                "code": "E_CONTAINER_CHECKSUM",
                "message": "箱号 {value} 未通过 ISO 6346 校验位验证，可能录错",
                "field": "container_no",
                "enabled_from": "settings:rules.container_checksum",
            },
            {
                "id": "container_qty",
                "type": "builtin.qty_match",
                "level": "warn",
                "code": "W_QTY_MISMATCH",
                "message": "箱量为 {qty}，但识别到 {count} 个箱号，请核对",
                "field": "container_qty",
                "compare_to": "container_no",
                "enabled_from": "settings:rules.container_checksum",
            },
            {
                "id": "container_type",
                "type": "builtin.enum",
                "level": "warn",
                "code": "W_CONTAINER_TYPE",
                "message": "箱型 {value} 不在常见取值内（20GP/40HQ/40RF 等）",
                "field": "container_type",
                "values": sorted(VALID_TYPES),
                "aliases": {"HC": "HQ"},
            },
            {
                "id": "seal_format",
                "type": "builtin.regex",
                "level": "warn",
                "code": "W_SEAL_FORMAT",
                "message": "封号 {value} 格式可疑（应为 5–15 位字母数字）",
                "field": "seal_no",
                "pattern": SEAL_RE.pattern,
                "split": True,
            },
            {
                "id": "phone_format",
                "type": "builtin.regex",
                "level": "warn",
                "code": "W_PHONE",
                "message": "电话 {value} 格式可疑",
                "field": "factory_phone",
                "pattern": PHONE_RE.pattern,
                "strip": r"[\s\-]",
            },
            {
                "id": "address",
                "type": "builtin.geo",
                "level": "warn",
                "fields": ["pickup_addr", "delivery_addr"],
                "enabled_from": "settings:rules.address",
            },
            {
                "id": "closing",
                "type": "builtin.deadline",
                "level": "error",
                "code": "E_CLOSING_PASSED",
                "code_warn": "W_CLOSING_SOON",
                "message": "截港时间 {time} 已过，此单赶不上本班船，请立即改配",
                "message_warn": "距截港仅剩 {hours:.1f} 小时，需优先安排",
                "field": "closing_time",
                "warn_hours": CLOSING_WARN_HOURS,
                "enabled_from": "settings:rules.closing",
            },
            {
                "id": "window_after_closing",
                "type": "builtin.ordering",
                "level": "warn",
                "code": "W_WINDOW_AFTER_CLOSING",
                "message": "装柜时间晚于截港时间，时间安排矛盾",
                "fields": ["loading_window", "closing_time"],
                "enabled_from": "settings:rules.closing",
            },
        ],
        "review": {
            "risk_fields": list(RISK_KEYS),
            "low_conf_warn": LOW_CONF_WARN,
        },
    })

    _write("reconcile.json", {
        "statement": {
            "header_hints": {k: list(v) for k, v in reconcile._HINTS.items()},
            "positional": [v for _, v in sorted(reconcile.POSITIONAL_DEFAULT.items())],
            "amount_fields": list(reconcile.SYSTEM_AMOUNT_FIELDS),
        },
        "match": {
            "keys": ["booking_no", "container_no"],
            "normalize": "alnum_upper",
        },
        "statuses": dict(reconcile.STATUS_LABELS),
    })

    _write("aging.json", {
        "header_hints": {k: list(v) for k, v in aging._HINTS.items()},
    })

    _write("fees.json", {
        "header_hints": {k: list(v) for k, v in fees._HINTS.items()},
        "builtin_fees": sorted(fees.BUILTIN_FEES),
    })

    _write("cost.json", {
        "revenue_hints": {k: list(v) for k, v in margin._REVENUE_HINTS.items()},
        "cost_hints": {k: list(v) for k, v in margin._COST_HINTS.items()},
    })

    _write("geo.json", {
        "cities": {k: list(v) for k, v in address_check.DISTRICTS.items()},
        "city_aliases": {k: list(v) for k, v in address_check.CITY_ALIASES.items()},
        "terminals": {k: sorted(v) for k, v in address_check.TERMINALS.items()},
        "ambiguous": sorted(address_check._AMBIGUOUS),
        "typos": dict(address_check.TYPOS),
        "place_words": list(address_check.PLACE_WORDS),
        "towns": list(address_check.TOWNS),
    })

    # 验收指标不是从代码常量导出，而是把 docs/AI需求实施计划.md 里的口径显式化。
    _write("acceptance.json", {
        "field_accuracy": {"target": 0.90, "scope": "blocking"},
        "correction_seconds": {"target": 90},
        "diff_recall": {"target": 0.90},
        "false_positive_rate": {"target": 0.10},
        "samples": {
            "booking": {"min": 20, "recommended": 50},
            "statement": {"min": 1, "unit": "month"},
            "aging": {"min": 1, "unit": "ledger"},
        },
    })

    print(f"已导出 {PACK_DIR}")


if __name__ == "__main__":
    main()
