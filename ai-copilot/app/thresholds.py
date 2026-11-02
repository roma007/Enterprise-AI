"""运行时可调的阈值（A3）。

问题：`RISK_AUTO_FLOOR=0.90`、`MATCH_TOLERANCE=0.01` 这些写死在 5 个模块里。
客户现场说"太严了，放宽到 0.85"，就得改代码、重新部署。

做法：
- 存 JSON 文件 `data/settings.json`（不进版本库），带 mtime 缓存，改了立即生效
- 每个阈值有默认值、范围、说明，非法值直接拒绝
- 只让管理员改（API 层控制角色）

为什么用文件而不是数据库表：
1. 避免 thresholds → store → rules → thresholds 的循环依赖
2. 配置文件本来就不该跟业务数据混在一起，备份和回滚更简单
3. 单进程读取，mtime 缓存足够；多进程时最坏是几秒延迟
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from .config import ROOT

PATH = ROOT / "data" / "settings.json"
_lock = threading.Lock()
_cache: dict | None = None
_cache_mtime: float = -1.0


SPECS: list[dict] = [
    # ---- 托书解析 ----
    {"key": "booking.risk_auto_floor", "group": "托书解析", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "风险字段自动通过阈值",
     "hint": "箱号/箱型/箱量/截港/电话 全部 ≥ 该值才允许自动通过"},
    {"key": "booking.low_conf_floor", "group": "托书解析", "default": 0.80,
     "min": 0.30, "max": 1.0, "step": 0.01,
     "label": "双人复核下限",
     "hint": "必填或风险字段低于该值 → 转双人复核"},
    {"key": "booking.rule_floor", "group": "托书解析", "default": 0.85,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "规则优先阈值（floor 模式用）",
     "hint": "只在 MERGE_POLICY=floor 时生效；默认 fill_only 不受影响"},

    # ---- 发票 ----
    {"key": "invoice.risk_auto_floor", "group": "发票", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "自动通过阈值",
     "hint": "发票号码/购买方税号/价税合计 全部 ≥ 该值才自动通过"},
    {"key": "invoice.low_conf_floor", "group": "发票", "default": 0.80,
     "min": 0.30, "max": 1.0, "step": 0.01,
     "label": "双人复核下限",
     "hint": "关键字段低于该值 → 转双人复核"},

    # ---- 文档配对 ----
    {"key": "pairing.auto_accept", "group": "纸质↔TMS 配对", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "自动接受分数",
     "hint": "单号一致=1.0，箱号一致=0.9"},
    {"key": "pairing.review_min", "group": "纸质↔TMS 配对", "default": 0.60,
     "min": 0.30, "max": 0.99, "step": 0.01,
     "label": "最低接受分数",
     "hint": "低于该值视为配不上"},

    # ---- 对账与结算 ----
    {"key": "reconcile.tolerance", "group": "对账 / 结算", "default": 0.01,
     "min": 0.0, "max": 100.0, "step": 0.01,
     "label": "对账金额容差（元）",
     "hint": "差额在这个范围内视为一致"},
    {"key": "settlement.tolerance", "group": "对账 / 结算", "default": 1.00,
     "min": 0.0, "max": 500.0, "step": 0.01,
     "label": "外协结算容差（元）",
     "hint": "报账与合同价的差额在这个范围内视为一致"},
]

BY_KEY = {s["key"]: s for s in SPECS}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> dict:
    """读文件（带 mtime 缓存）。文件不存在时返回空覆盖。"""
    global _cache, _cache_mtime
    try:
        mtime = PATH.stat().st_mtime
    except FileNotFoundError:
        if _cache is None:
            _cache = {}
            _cache_mtime = -1.0
        return _cache or {}

    if _cache is not None and mtime == _cache_mtime:
        return _cache
    try:
        data = json.loads(PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    _cache = data if isinstance(data, dict) else {}
    _cache_mtime = mtime
    return _cache


def _write(payload: dict) -> None:
    global _cache, _cache_mtime
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, PATH)
    _cache = payload
    _cache_mtime = PATH.stat().st_mtime


def get(key: str) -> float:
    spec = BY_KEY.get(key)
    default = spec["default"] if spec else 0.0
    raw = (_load().get("values") or {}).get(key)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return float(default)


def snapshot() -> dict:
    """给 UI 用：带说明与当前值。"""
    data = _load()
    values = data.get("values") or {}
    groups: dict[str, list] = {}
    for spec in SPECS:
        item = dict(spec)
        item["value"] = get(spec["key"])
        item["changed"] = spec["key"] in values and abs(
            float(values[spec["key"]]) - float(spec["default"])) > 1e-9
        groups.setdefault(spec["group"], []).append(item)
    return {
        "groups": [{"name": k, "items": v} for k, v in groups.items()],
        "updated_at": data.get("updated_at", ""),
        "updated_by": data.get("updated_by", ""),
    }


def set_many(values: dict, actor: str = "") -> dict:
    """批量设置。只接受 SPECS 里的 key，且必须落在范围内。"""
    unknown = [k for k in values if k not in BY_KEY]
    if unknown:
        raise ValueError(f"未知配置项：{', '.join(unknown)}")

    clean: dict[str, float] = {}
    for k, v in values.items():
        spec = BY_KEY[k]
        try:
            num = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{spec['label']} 必须是数字")
        if not (spec["min"] <= num <= spec["max"]):
            raise ValueError(f"{spec['label']} 必须在 {spec['min']}–{spec['max']} 之间")
        clean[k] = num

    with _lock:
        current = dict(_load().get("values") or {})
        current.update(clean)
        # 与默认值相同的就不落盘，保持文件干净
        for k in list(current):
            if k in BY_KEY and abs(float(current[k]) - float(BY_KEY[k]["default"])) < 1e-9:
                current.pop(k)
        _write({"values": current, "updated_at": _now(), "updated_by": actor})
    return {"ok": True, "changed": list(clean), "values": current}


def reset(keys: list[str] | None = None, actor: str = "") -> dict:
    with _lock:
        current = dict(_load().get("values") or {})
        for k in (keys or list(current)):
            current.pop(k, None)
        _write({"values": current, "updated_at": _now(), "updated_by": actor})
    return {"ok": True, "values": current}
