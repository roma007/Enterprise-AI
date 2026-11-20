"""行业包激活状态与历史（Step 4）。

v1 语义：激活/回滚只写“下次启动使用哪个包”的指针；运行中的模块级常量
（schema.SPECS / invoice.INVOICE_SPECS / extract.SPECS 等）在进程启动时生成，
所以**重启后生效**。这比热切换安全：不会出现规则已换、抽取字段没换的半状态。

存储：
- SQLite：`data/active_pack.json` + `data/pack_history.json`
- PostgreSQL：`app_settings` 的 `active_pack` / `pack_history` 两个 key（多实例一致）

优先级：页面激活状态 > `PACK_ID` 环境变量 > 默认 `trucking`。
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from . import db
from .config import ROOT

PATH = ROOT / "data" / "active_pack.json"
HISTORY_PATH = ROOT / "data" / "pack_history.json"
HISTORY_MAX = 100
_DB_STATE_KEY = "active_pack"
_DB_HISTORY_KEY = "pack_history"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def _db_read(key: str) -> dict:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT value, updated_at, updated_by FROM app_settings WHERE key=?", (key,)
        ).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    data.setdefault("updated_at", row["updated_at"] or "")
    data.setdefault("updated_by", row["updated_by"] or "")
    return data


def _db_write(key: str, payload: dict) -> None:
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at, updated_by)"
            " VALUES (?,?,?,?)"
            " ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"
            " updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by",
            (key, json.dumps(payload, ensure_ascii=False),
             payload.get("updated_at", ""), payload.get("updated_by", "")),
        )


def get_state() -> dict:
    state = _db_read(_DB_STATE_KEY) if db.BACKEND == "postgres" else _read(PATH)
    return state if state.get("id") is not None else {}


def get_active_id() -> str:
    return str(get_state().get("id") or "")


def _history_load() -> list[dict]:
    raw = _db_read(_DB_HISTORY_KEY) if db.BACKEND == "postgres" else _read(HISTORY_PATH)
    items = raw.get("items") if isinstance(raw, dict) else None
    return items if isinstance(items, list) else []


def _history_save(items: list[dict]) -> None:
    payload = {"items": items[:HISTORY_MAX]}
    if db.BACKEND == "postgres":
        _db_write(_DB_HISTORY_KEY, payload)
    else:
        _write(HISTORY_PATH, payload)


def history(limit: int = 50) -> list[dict]:
    return _history_load()[: max(1, min(int(limit or 50), HISTORY_MAX))]


def _record(from_id: str, to_id: str, actor: str, reason: str) -> dict:
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": _now(),
        "actor": actor or "",
        "reason": (reason or "")[:200],
        "from_id": from_id,
        "to_id": to_id,
    }
    items = _history_load()
    items.insert(0, entry)
    _history_save(items)
    return entry


def set_active(pack_id: str, actor: str = "", reason: str = "") -> dict:
    """把“下次启动使用的包”写成 pack_id；不热切换运行中的模块。"""
    current = get_active_id()
    state = {
        "id": pack_id,
        "updated_at": _now(),
        "updated_by": actor or "",
    }
    if db.BACKEND == "postgres":
        _db_write(_DB_STATE_KEY, state)
    else:
        _write(PATH, state)
    entry = _record(current, pack_id, actor, reason)
    return {**state, "from_id": current, "to_id": pack_id, "entry": entry}


def _clear_active() -> None:
    if db.BACKEND == "postgres":
        _db_write(_DB_STATE_KEY, {"id": "", "updated_at": _now(), "updated_by": ""})
    else:
        try:
            PATH.unlink()
        except FileNotFoundError:
            pass


def rollback(entry_id: str | None = None, actor: str = "", reason: str = "") -> dict:
    """回滚到某次切换之前的包；不传 entry_id 时撤销最近一次切换。"""
    items = _history_load()
    if not items:
        raise ValueError("没有可回滚的切换记录")
    if entry_id:
        entry = next((x for x in items if x.get("id") == entry_id), None)
        if not entry:
            raise ValueError("切换记录不存在")
        target = str(entry.get("from_id") or "")
    else:
        target = str(items[0].get("from_id") or "")

    current = get_active_id()
    if target:
        state = {"id": target, "updated_at": _now(), "updated_by": actor or ""}
        if db.BACKEND == "postgres":
            _db_write(_DB_STATE_KEY, state)
        else:
            _write(PATH, state)
    else:
        state = {"id": "", "updated_at": _now(), "updated_by": actor or ""}
        _clear_active()

    entry = _record(current, target, actor, reason or (f"回滚到 {target}" if target else "回滚到默认"))
    return {**state, "from_id": current, "to_id": target, "entry": entry}
