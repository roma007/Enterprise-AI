"""托书（Booking Note）字段定义与数据模型。

设计原则：
1. 字段清单集中在一处，抽取、校验、评测、UI 全部从这里派生，避免四处维护。
2. 每个字段都带 confidence 与 source，因为"AI 只出草稿，人必须能看见哪一条不可靠"。
3. blocking=True 的字段缺失时，整张单不可提交。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    hint: str = ""          # 给模型的提示
    example: str = ""
    blocking: bool = False  # 缺失即阻断
    kind: str = "text"      # text | datetime | number | enum


SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("client", "客户/货代", "委托方公司名称", "宏远国际货代", blocking=True),
    FieldSpec("booking_no", "委托单号", "托书/委托单编号", "HY2026110501", blocking=True),
    FieldSpec("bl_no", "提单号", "B/L No.", "COSU6398471120"),
    FieldSpec("so_no", "SO号", "Shipping Order 号", "SO-778123"),
    FieldSpec("container_type", "箱型", "如 20GP / 40HQ / 40RF", "40HQ", blocking=True),
    FieldSpec("container_qty", "箱量", "整数", "2", kind="number"),
    FieldSpec("container_no", "箱号", "ISO 6346，多个用逗号分隔", "CSQU3054383"),
    FieldSpec("seal_no", "封号", "铅封号，多个用逗号分隔", "SL8823101"),
    FieldSpec("pickup_addr", "提箱/装货地", "提空箱堆场或工厂装货地址", "北仑港区二期堆场", blocking=True),
    FieldSpec("delivery_addr", "卸货/送货地", "重箱送达地址", "宁波北仑春晓工业园 3 号仓", blocking=True),
    FieldSpec("factory_contact", "工厂联系人", "姓名", "王主管"),
    FieldSpec("factory_phone", "联系电话", "手机或固话", "13800001234"),
    FieldSpec("loading_window", "装柜时间窗", "可装柜的时间范围", "2026-11-06 08:00~12:00", kind="datetime"),
    FieldSpec("closing_time", "截港时间", "码头截关/截港时间", "2026-11-07 18:00", kind="datetime"),
    FieldSpec("vessel_voyage", "船名航次", "Vessel / Voyage", "COSCO SHIPPING ARIES / 042E"),
    FieldSpec("depot", "提空箱点", "堆场名称", "北仑三期堆场"),
    FieldSpec("cargo_desc", "品名", "货物描述", "家用电器"),
    FieldSpec("gross_weight", "毛重", "KGS", "18600"),
    FieldSpec("freight", "运费", "报价或金额", "2600"),
    FieldSpec("remark", "备注", "其他要求，如报关、押车、加急", "需报关，周五前必须进港"),
)

FIELD_KEYS: tuple[str, ...] = tuple(s.key for s in SPECS)
LABELS: dict[str, str] = {s.key: s.label for s in SPECS}
SPEC_MAP: dict[str, FieldSpec] = {s.key: s for s in SPECS}
BLOCKING_KEYS: tuple[str, ...] = tuple(s.key for s in SPECS if s.blocking)


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

    @property
    def blocking(self) -> bool:
        return any(c.level == "error" for c in self.checks)

    def to_plain(self) -> dict[str, Any]:
        return {k: (v.value or "") for k, v in self.fields.items()}


def empty_draft() -> Draft:
    return Draft(fields={k: FieldValue() for k in FIELD_KEYS})


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
    return v
