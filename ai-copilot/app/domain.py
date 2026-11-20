"""领域数据模型：字段、校验、草稿与行业包。

放在独立模块，避免 `schema → pack → schema` 的循环依赖：
- `domain` 只依赖 pydantic / dataclasses
- `pack` 依赖 `domain`
- `schema` 依赖 `pack` 与 `domain`，并继续对外暴露原有名字
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

# 字段类型 / 归一化器 / 校验器只允许固定枚举；pack 不能写任意代码。
FIELD_KINDS = frozenset({"text", "datetime", "number", "enum"})
NORMALIZERS = frozenset({
    "text", "text_name", "number", "quantity", "amount", "datetime",
    "container_list", "container_type", "so_no", "alnum_upper",
})
VALIDATOR_TYPES = frozenset({
    "builtin.required",
    "builtin.low_confidence",
    "builtin.iso6346",
    "builtin.qty_match",
    "builtin.enum",
    "builtin.regex",
    "builtin.geo",
    "builtin.deadline",
    "builtin.ordering",
})


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    hint: str = ""
    example: str = ""
    blocking: bool = False
    kind: str = "text"
    normalize: str = "text"


@dataclass(frozen=True)
class ValidationSpec:
    id: str
    type: str
    level: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Pack:
    id: str
    name: str
    version: str
    documents: dict[str, tuple[FieldSpec, ...]]
    validations: tuple[ValidationSpec, ...]
    review: dict[str, Any]
    reconcile: dict[str, Any]
    aging: dict[str, Any]
    fees: dict[str, Any]
    cost: dict[str, Any]
    geo: dict[str, Any]
    acceptance: dict[str, Any]
    settings_refs: tuple[str, ...] = ()
    description: str = ""


class FieldValue(BaseModel):
    """单个字段的抽取结果。"""

    value: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    source: str = "missing"  # llm | rule | regex | user | missing


class Check(BaseModel):
    """一条校验结果。"""

    level: str          # error | warn | info
    code: str
    field: str | None = None
    message: str


class Draft(BaseModel):
    """一张托书的解析草稿。"""

    fields: dict[str, FieldValue]
    checks: list[Check] = []
    engine: str = "rule-based-v1"
    elapsed_ms: int = 0
    tokens: int = 0
    note: str = ""
    # 分级审批：auto（直过）/ single（单人确认）/ double（双人复核）/ blocked（有阻断）
    review_level: str = "single"
    # 审计用：这一版是怎么跑出来的
    model: str = ""
    prompt_version: str = ""
    pipeline_version: str = ""
    pack_id: str = ""
    pack_version: str = ""

    @property
    def blocking(self) -> bool:
        return any(c.level == "error" for c in self.checks)

    def to_plain(self) -> dict[str, Any]:
        return {k: (v.value or "") for k, v in self.fields.items()}
