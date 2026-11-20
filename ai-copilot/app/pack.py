"""行业包加载器（Step 1）。

pack 是“会随行业/客户变化的领域知识”的唯一来源：
字段、校验参数、对账口径、账龄/费用/成本词表、地域词表、验收指标。

这里只做加载与基本校验，不执行任意代码：
- 字段只允许固定 `kind` / `normalize`
- 校验只允许固定 `VALIDATOR_TYPES`
- 具体算法仍在 `rules.py` / `reconcile.py` / 其他模块

加载失败策略：
- 指定的包不存在 → 回退默认包 `trucking` 并打印告警
- 默认包也不存在/损坏 → 抛 `PackError`，让部署阶段立刻发现
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .config import ROOT
from .domain import (
    FIELD_KINDS,
    NORMALIZERS,
    VALIDATOR_TYPES,
    FieldSpec,
    Pack,
    ValidationSpec,
)

PACKS_DIR = ROOT / "packs"
DEFAULT_PACK_ID = "trucking"
PACK_FILES = (
    "pack.json",
    "fields.json",
    "rules.json",
    "reconcile.json",
    "aging.json",
    "fees.json",
    "cost.json",
    "geo.json",
    "acceptance.json",
)


class PackError(RuntimeError):
    """行业包缺失、损坏或包含不支持的声明。"""


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PackError(f"行业包缺少文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise PackError(f"行业包 JSON 无法解析：{path}（{exc}）") from exc


def _parse_field(raw: dict, doc: str) -> FieldSpec:
    key = str(raw.get("key") or "").strip()
    if not key:
        raise PackError(f"{doc} 存在空字段 key")
    kind = raw.get("kind", "text")
    if kind not in FIELD_KINDS:
        raise PackError(f"{doc}.{key} 的 kind 不支持：{kind}")
    normalize = raw.get("normalize", "text")
    if normalize not in NORMALIZERS:
        raise PackError(f"{doc}.{key} 的 normalize 不支持：{normalize}")
    return FieldSpec(
        key=key,
        label=str(raw.get("label") or key),
        hint=str(raw.get("hint") or ""),
        example=str(raw.get("example") or ""),
        blocking=bool(raw.get("blocking", False)),
        kind=str(kind),
        normalize=str(normalize),
    )


def _parse_fields(raw: dict) -> dict[str, tuple[FieldSpec, ...]]:
    documents: dict[str, tuple[FieldSpec, ...]] = {}
    for doc, block in raw.items():
        items = (block or {}).get("fields") or []
        specs = tuple(_parse_field(f, doc) for f in items)
        keys = [s.key for s in specs]
        if len(keys) != len(set(keys)):
            raise PackError(f"{doc} 字段 key 重复")
        documents[doc] = specs
    for required in ("booking", "invoice"):
        if required not in documents:
            raise PackError(f"fields.json 缺少 {required}")
    return documents


def _parse_rules(raw: dict) -> tuple[tuple[ValidationSpec, ...], dict[str, Any]]:
    specs: list[ValidationSpec] = []
    for rule in raw.get("validations") or []:
        rid = str(rule.get("id") or "").strip()
        rtype = rule.get("type")
        level = rule.get("level")
        if not rid:
            raise PackError("rules.json 存在空规则 id")
        if rtype not in VALIDATOR_TYPES:
            raise PackError(f"校验规则 {rid} 的类型不支持：{rtype}")
        if level not in {"error", "warn", "info"}:
            raise PackError(f"校验规则 {rid} 的 level 不支持：{level}")
        params = {k: v for k, v in rule.items() if k not in {"id", "type", "level"}}
        specs.append(ValidationSpec(id=rid, type=str(rtype), level=str(level), params=params))
    ids = [s.id for s in specs]
    if len(ids) != len(set(ids)):
        raise PackError("rules.json 规则 id 重复")
    return tuple(specs), dict(raw.get("review") or {})


def _load_pack_dir(path: Path) -> Pack:
    for name in PACK_FILES:
        if not (path / name).is_file():
            raise PackError(f"行业包 {path.name} 缺少 {name}")
    meta = _read_json(path / "pack.json")
    fields = _read_json(path / "fields.json")
    rules = _read_json(path / "rules.json")
    reconcile = _read_json(path / "reconcile.json")
    aging = _read_json(path / "aging.json")
    fees = _read_json(path / "fees.json")
    cost = _read_json(path / "cost.json")
    geo = _read_json(path / "geo.json")
    acceptance = _read_json(path / "acceptance.json")

    documents = _parse_fields(fields)
    validations, review = _parse_rules(rules)

    return Pack(
        id=str(meta.get("id") or path.name),
        name=str(meta.get("name") or path.name),
        version=str(meta.get("version") or "0.0.0"),
        documents=documents,
        validations=validations,
        review=review,
        reconcile=reconcile,
        aging=aging,
        fees=fees,
        cost=cost,
        geo=geo,
        acceptance=acceptance,
        settings_refs=tuple(meta.get("settings_refs") or ()),
    )


def load_pack(pack_id: str | None = None) -> Pack:
    """按 id 加载行业包；指定的包不存在时回退默认包。"""
    requested = (pack_id or os.getenv("PACK_ID") or DEFAULT_PACK_ID).strip() or DEFAULT_PACK_ID
    path = PACKS_DIR / requested
    if not path.is_dir():
        if requested == DEFAULT_PACK_ID:
            raise PackError(f"默认行业包不存在：{path}")
        print(f"[pack] 未找到行业包 {requested}，回退 {DEFAULT_PACK_ID}")
        requested = DEFAULT_PACK_ID
        path = PACKS_DIR / requested
    if not path.is_dir():
        raise PackError(f"默认行业包不存在：{path}")
    return _load_pack_dir(path)


_cache: Pack | None = None


def active_pack() -> Pack:
    """当前进程使用的行业包（`PACK_ID` 环境变量，默认 trucking）。"""
    global _cache
    if _cache is None:
        _cache = load_pack()
    return _cache


def reload_pack() -> Pack:
    """清缓存并重新加载；测试或切换 pack 后使用。"""
    global _cache
    _cache = None
    return active_pack()
