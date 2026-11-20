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
from decimal import Decimal, InvalidOperation

from .domain import Check, Draft, FieldSpec, FieldValue  # noqa: F401  （兼容旧 import）
from .pack import current_pack, register_listener

PACK = current_pack()
PACK_ID: str = PACK.id
PACK_VERSION: str = PACK.version

# 可变容器：热切换时原地刷新，已 import 的模块看到同一对象的新内容。
SPECS: list[FieldSpec] = []
FIELD_KEYS: list[str] = []
LABELS: dict[str, str] = {}
SPEC_MAP: dict[str, FieldSpec] = {}
BLOCKING_KEYS: list[str] = []


def _apply(pack) -> None:
    global PACK, PACK_ID, PACK_VERSION
    PACK = pack
    PACK_ID = pack.id
    PACK_VERSION = pack.version
    specs = list(pack.documents["booking"])
    SPECS[:] = specs
    FIELD_KEYS[:] = [s.key for s in specs]
    LABELS.clear()
    LABELS.update({s.key: s.label for s in specs})
    SPEC_MAP.clear()
    SPEC_MAP.update({s.key: s for s in specs})
    BLOCKING_KEYS[:] = [s.key for s in specs if s.blocking]


_apply(PACK)
register_listener(_apply)


def empty_draft() -> Draft:
    pack = current_pack()
    keys = [s.key for s in pack.documents["booking"]]
    return Draft(
        fields={k: FieldValue() for k in keys},
        pack_id=pack.id,
        pack_version=pack.version,
    )


# ---------- 字段归一化（normalize 元数据驱动） ----------
# pack 的 fields.json 里每个字段声明 normalize；这里只实现固定几种归一化器。
# 旧版按字段名硬编码，导致第二行业包的 amount/日期仍按文本比较。

def _norm_text(v: str) -> str:
    return v


def _norm_text_name(v: str) -> str:
    # 名称/地址类：空格、全半角、标点差异不该算错
    v = re.sub(r"\s+", "", v)
    return v.replace("（", "(").replace("）", ")").replace("、", ",").replace("，", ",")


def _norm_number(v: str) -> str:
    return "".join(ch for ch in v if ch.isdigit())


def _norm_amount(v: str) -> str:
    s = re.sub(r"[^\d.\-]", "", v)
    if not s or s in {"-", "."}:
        return v
    try:
        return str(Decimal(s).quantize(Decimal("0.01")))
    except InvalidOperation:
        return v


def _norm_datetime(v: str) -> str:
    # 局部 import：rules 依赖 schema，避免顶层循环
    from .rules import fmt, parse_datetime

    dt = parse_datetime(v)
    return fmt(dt) if dt else v


def _norm_container_list(v: str) -> str:
    v = v.replace(" ", "").replace("，", ",").replace("、", ",").upper()
    return ",".join(sorted(x for x in v.split(",") if x))


def _norm_container_type(v: str) -> str:
    return v.replace(" ", "").upper().replace("HC", "HQ")


def _norm_so_no(v: str) -> str:
    v = re.sub(r"^(SO|S/O)[-\s]?", "", v.upper())
    return re.sub(r"[^A-Z0-9]", "", v)


def _norm_alnum_upper(v: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", v).upper()


_NORMALIZER_FNS = {
    "text": _norm_text,
    "text_name": _norm_text_name,
    "number": _norm_number,
    "quantity": _norm_number,
    "amount": _norm_amount,
    "datetime": _norm_datetime,
    "container_list": _norm_container_list,
    "container_type": _norm_container_type,
    "so_no": _norm_so_no,
    "alnum_upper": _norm_alnum_upper,
}


def normalize_for_compare(key: str, value: str | None) -> str:
    """按当前包字段声明的 normalize 归一，用于评测/比对。"""
    if value is None:
        return ""
    v = unicodedata.normalize("NFKC", str(value)).strip()
    spec = SPEC_MAP.get(key)
    kind = spec.normalize if spec else "text"
    return _NORMALIZER_FNS.get(kind, _norm_text)(v)


__all__ = [
    "SPECS", "FIELD_KEYS", "LABELS", "SPEC_MAP", "BLOCKING_KEYS",
    "PACK_ID", "PACK_VERSION",
    "FieldSpec", "FieldValue", "Check", "Draft",
    "empty_draft", "normalize_for_compare",
]
