"""模型用量与预算账本（AI-52）。

灰犀牛要回答“还能用几天”，必须有两样事实：

1. **每天实际消耗多少 token**：本地记账，不依赖供应商后台，也不记提示词内容。
2. **账上还剩多少**：余额 / 额度 / 有效期，来自配置或人工更新。

边界：
- 余额不做猜测。没配置余额，就返回 `None`，风险规则自动跳过，不编 ETA。
- 供应商余额接口没有标准，先不硬接；`set_budget()` 留作人工/脚本更新入口。
- 多进程同时写同一文件会互相覆盖，MVP 单实例够用；多实例应换成数据库表。
"""
from __future__ import annotations

import json
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import ROOT, settings

LEDGER_PATH = ROOT / "data" / "llm_usage.json"
BUDGET_PATH = ROOT / "data" / "llm_budget.json"
KEEP_DAYS = 180
_LOCK = threading.Lock()


def _empty() -> dict:
    return {"version": 1, "total_tokens": 0, "days": {}, "last_call_at": None}


def _load(path: Path, default: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return data if isinstance(data, dict) else default


def _save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _today() -> str:
    return date.today().isoformat()


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _days_until(raw: str) -> int | None:
    """支持 `2026-12-01` 与完整 ISO 时间；解析不了就返回 None。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        day = datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError:
            return None
    return (day - date.today()).days


# ------------------------------------------------------------------ 记账
def record(tokens: int, ok: bool = True, cached: bool = False) -> None:
    """记一次模型调用。缓存命中不计 token（命中就说明没花供应商的钱）。"""
    spent = 0 if cached else max(0, int(tokens or 0))
    today = _today()
    with _LOCK:
        data = _load(LEDGER_PATH, _empty())
        days = data.setdefault("days", {})
        row = days.setdefault(today, {"tokens": 0, "calls": 0, "errors": 0, "cached": 0})
        row["calls"] = int(row.get("calls") or 0) + 1
        row["tokens"] = int(row.get("tokens") or 0) + spent
        if cached:
            row["cached"] = int(row.get("cached") or 0) + 1
        if not ok:
            row["errors"] = int(row.get("errors") or 0) + 1
        data["total_tokens"] = int(data.get("total_tokens") or 0) + spent
        data["last_call_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
        data["days"] = {k: v for k, v in days.items() if k >= cutoff}
        _save(LEDGER_PATH, data)


def stats(days: int = 7) -> dict:
    """近 N 天用量。日均按“不含今天”的完整天算，避免早上被 0 拉低。"""
    data = _load(LEDGER_PATH, _empty())
    rows = data.get("days") or {}
    today = date.today()
    keys = [(today - timedelta(days=i)).isoformat()
            for i in range(max(1, days) + 1)]
    past = [rows.get(k) or {} for k in keys[1:]]
    n = max(1, len(past))
    avg_tokens = sum(int(r.get("tokens") or 0) for r in past) / n
    today_row = rows.get(keys[0]) or {}
    return {
        "today_tokens": int(today_row.get("tokens") or 0),
        "today_calls": int(today_row.get("calls") or 0),
        "today_errors": int(today_row.get("errors") or 0),
        "today_cached": int(today_row.get("cached") or 0),
        "avg_tokens_per_day": avg_tokens,
        "total_tokens": int(data.get("total_tokens") or 0),
        "last_call_at": data.get("last_call_at"),
        "window_days": len(past),
    }


def tokens_since(day: str) -> int:
    data = _load(LEDGER_PATH, _empty())
    return sum(int(v.get("tokens") or 0)
               for k, v in (data.get("days") or {}).items() if k > day)


# ------------------------------------------------------------------ 预算
def budget() -> dict:
    """余额/额度/有效期：文件覆盖配置，文件不存在就用 .env。"""
    override = _load(BUDGET_PATH, {})
    price = _num(override.get("price_per_1k"))
    if price is None:
        price = settings.llm_price_per_1k
    price = float(price or 0)

    base_balance = _num(override.get("balance_cny"))
    if base_balance is None:
        base_balance = settings.llm_balance_cny or None
    asof = str(override.get("balance_asof") or settings.llm_balance_asof or "").strip()

    quota = _num(override.get("quota_tokens"))
    if quota is None:
        quota = settings.llm_quota_tokens or None

    expires = str(override.get("key_expires_at") or settings.llm_key_expires_at or "").strip()
    retires = str(override.get("model_retires_at") or settings.llm_model_retires_at or "").strip()

    remaining_cny = None
    if base_balance is not None:
        # 有基准时间：只扣基准之后的消耗；没有基准时间：把余额当“此刻余额”
        spent = tokens_since(asof) / 1000.0 * price if (asof and price > 0) else 0.0
        remaining_cny = round(base_balance - spent, 2)

    remaining_tokens = None
    if quota is not None:
        remaining_tokens = int(quota - int(_load(LEDGER_PATH, _empty()).get("total_tokens") or 0))

    return {
        "model": settings.model,
        "provider": settings.provider,
        "enabled": settings.llm_enabled,
        "price_per_1k": price,
        "balance_cny": remaining_cny,
        "balance_base_cny": base_balance,
        "balance_asof": asof or None,
        "quota_tokens": int(quota) if quota is not None else None,
        "remaining_tokens": remaining_tokens,
        "key_expires_days": _days_until(expires),
        "key_expires_at": expires or None,
        "model_retires_days": _days_until(retires),
        "model_retires_at": retires or None,
    }


def set_budget(balance_cny: float | None = None, quota_tokens: int | None = None,
               key_expires_at: str | None = None,
               model_retires_at: str | None = None,
               price_per_1k: float | None = None) -> dict:
    """人工/脚本更新余额与有效期。给余额时同时记 `balance_asof`，之后按实际消耗递减。"""
    with _LOCK:
        cur = _load(BUDGET_PATH, {})
        if balance_cny is not None:
            cur["balance_cny"] = float(balance_cny)
            cur["balance_asof"] = _today()
        if quota_tokens is not None:
            cur["quota_tokens"] = int(quota_tokens)
        if key_expires_at is not None:
            cur["key_expires_at"] = str(key_expires_at).strip()
        if model_retires_at is not None:
            cur["model_retires_at"] = str(model_retires_at).strip()
        if price_per_1k is not None:
            cur["price_per_1k"] = float(price_per_1k)
        cur["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _save(BUDGET_PATH, cur)
    return budget()


def snapshot() -> dict:
    """给 aiops 规则用的一行事实：用量 + 剩余 + 还能撑几天。"""
    s = stats(7)
    b = budget()
    price = float(b["price_per_1k"] or 0)
    avg_cost = round(s["avg_tokens_per_day"] / 1000.0 * price, 2)
    today_cost = round(s["today_tokens"] / 1000.0 * price, 4)
    days_balance = None
    if b["balance_cny"] is not None and avg_cost > 0:
        days_balance = round(b["balance_cny"] / avg_cost, 1)
    days_tokens = None
    if b["remaining_tokens"] is not None and s["avg_tokens_per_day"] > 0:
        days_tokens = round(b["remaining_tokens"] / s["avg_tokens_per_day"], 1)
    return {
        **b,
        "today_tokens": s["today_tokens"],
        "today_calls": s["today_calls"],
        "today_errors": s["today_errors"],
        "today_cached": s["today_cached"],
        "total_tokens": s["total_tokens"],
        "last_call_at": s["last_call_at"],
        "avg_tokens_per_day": round(s["avg_tokens_per_day"], 1),
        "avg_cost_per_day": avg_cost,
        "today_cost": today_cost,
        "days_left_balance": days_balance,
        "days_left_tokens": days_tokens,
    }


def reset() -> dict:
    with _LOCK:
        _save(LEDGER_PATH, _empty())
    return stats(7)
