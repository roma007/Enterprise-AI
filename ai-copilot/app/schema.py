"""托书字段定义与数据模型（兼容层）。

字段清单来自当前行业包（默认 `packs/trucking`）。本模块继续暴露原有名字
（`SPECS` / `FIELD_KEYS` / `LABELS` / `SPEC_MAP` / `BLOCKING_KEYS`），
所以下游 `from .schema import ...` 不需要改。

设计原则：
1. 字段清单集中在行业包，抽取、校验、评测、UI 全部从这里派生。
2. 每个字段都带 confidence 与 source，因为"AI 只出草稿，人必须能看见哪一条不可靠"。
3. blocking=True 的字段缺失时，整张单不可提交。
"""
from __future__ import annotations

import re
import unicodedata

from .domain import Check, Draft, FieldSpec, FieldValue  # noqa: F401  （兼容旧 import）
from .pack import active_pack

PACK = active_pack()
PACK_ID: str = PACK.id
PACK_VERSION: str = PACK.version

SPECS: tuple[FieldSpec, ...] = PACK.documents["booking"]
FIELD_KEYS: tuple[str, ...] = tuple(s.key for s in SPECS)
LABELS: dict[str, str] = {s.key: s.label for s in SPECS}
SPEC_MAP: dict[str, FieldSpec] = {s.key: s for s in SPECS}
BLOCKING_KEYS: tuple[str, ...] = tuple(s.key for s in SPECS if s.blocking)


def empty_draft() -> Draft:
    return Draft(
        fields={k: FieldValue() for k in FIELD_KEYS},
        pack_id=PACK_ID,
        pack_version=PACK_VERSION,
    )


# 用于评测的字段归一化目标
def normalize_for_compare(key: str, value: str | None) -> str:
    if value is None:
        return ""
    v = unicodedata.normalize("NFKC", str(value)).strip()
    if key in {"container_no", "seal_no"}:
        v = v.replace(" ", "").replace("，", ",").replace("、", ",").upper()
        v = ",".join(sorted(x for x in v.split(",") if x))
    elif key in {"container_type"}:
        v = v.replace(" ", "").upper().replace("HC", "HQ")
    elif key in {"gross_weight", "freight", "container_qty", "factory_phone"}:
        v = "".join(ch for ch in v if ch.isdigit())
    elif key in {"so_no"}:
        v = re.sub(r"^(SO|S/O)[-\s]?", "", v.upper())
        v = re.sub(r"[^A-Z0-9]", "", v)
    elif key in {"pickup_addr", "delivery_addr", "client", "cargo_desc",
                 "vessel_voyage", "remark"}:
        # 地址/名称类：空格、全半角、标点差异不该算错
        v = re.sub(r"\s+", "", v)
        v = v.replace("（", "(").replace("）", ")").replace("、", ",").replace("，", ",")
    return v


__all__ = [
    "SPECS", "FIELD_KEYS", "LABELS", "SPEC_MAP", "BLOCKING_KEYS",
    "PACK_ID", "PACK_VERSION",
    "FieldSpec", "FieldValue", "Check", "Draft",
    "empty_draft", "normalize_for_compare",
]
